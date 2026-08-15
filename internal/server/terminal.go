package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/euphony/internal/control"
)

type clientMessage struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

type serverMessage struct {
	Type     string `json:"type"`
	Data     []byte `json:"data,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Message  string `json:"message,omitempty"`
	Cols     uint16 `json:"cols,omitempty"`
	Rows     uint16 `json:"rows,omitempty"`
}

const terminalResizeTimeout = 2 * time.Second

func (s *Server) terminal(w http.ResponseWriter, r *http.Request) {
	s.terminalStream(w, r)
}

func (s *Server) terminalStream(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ticket, valid := s.tickets.consumeEntry(r.URL.Query().Get("ticket"), id)
	if !valid {
		writeError(w, http.StatusUnauthorized, "invalid_ticket", "The terminal connection ticket is invalid or expired.")
		return
	}
	terminal, ok := s.sessions.Get(id)
	if !ok {
		writeError(w, http.StatusNotFound, "session_not_found", "The terminal session does not exist.")
		return
	}

	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		return
	}
	defer connection.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		if err := monitorTerminalWebSocket(
			ctx,
			15*time.Second,
			5*time.Second,
			connection.Ping,
		); err != nil && !errors.Is(err, context.Canceled) {
			cancel()
		}
	}()
	var cancelCWDRefresh context.CancelFunc
	defer func() {
		if cancelCWDRefresh != nil {
			cancelCWDRefresh()
		}
	}()
	history, events, lagged, enqueueResize, unsubscribe :=
		terminal.SubscribeTerminalEventsWithStatus()
	defer unsubscribe()
	var reportSize func(uint16, uint16) error
	var releaseSize func() error
	var initialSize *terminalDimensions
	if !ticket.readOnly {
		var unsubscribeSize func()
		cols, rows := terminal.Dimensions()
		dimensions := terminalDimensions{Cols: cols, Rows: rows}
		applyResize := func(cols, rows uint16, notify func()) error {
			resizeContext, cancelResize := context.WithTimeout(ctx, terminalResizeTimeout)
			defer cancelResize()
			return terminal.ResizeWithNotificationContext(
				resizeContext,
				cols,
				rows,
				notify,
			)
		}
		reportSize, releaseSize, _, unsubscribeSize = s.terminalSizes.subscribe(
			id,
			dimensions,
			applyResize,
			func(dimensions terminalDimensions) {
				enqueueResize(dimensions.Cols, dimensions.Rows)
			},
		)
		cols, rows = terminal.Dimensions()
		initialSize = &terminalDimensions{Cols: cols, Rows: rows}
		defer unsubscribeSize()
	}
	outputGate := newTerminalOutputGate()
	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		defer cancel()
		writeContext, cancelWrites := interruptTerminalWritesOnLag(
			ctx,
			lagged,
			func() {
				_ = connection.Close(
					websocket.StatusTryAgainLater,
					"terminal output fell behind; reconnect",
				)
			},
		)
		defer cancelWrites()
		outputBatcher := newTerminalEventBatcher(terminalOutputFrameBytes)
		writeFrame := func(payload []byte) error {
			if err := outputGate.wait(writeContext); err != nil {
				return err
			}
			return connection.Write(writeContext, websocket.MessageText, payload)
		}
		if initialSize != nil {
			payload := marshalTerminalFrame(serverMessage{
				Type: "resize",
				Cols: initialSize.Cols,
				Rows: initialSize.Rows,
			})
			if err := writeFrame(payload); err != nil {
				return
			}
		}
		for _, chunk := range batchTerminalHistory(history, terminalOutputFrameBytes) {
			payload := marshalTerminalFrame(serverMessage{Type: "history", Data: chunk})
			if err := writeFrame(payload); err != nil {
				return
			}
		}
		payload := marshalTerminalFrame(serverMessage{Type: "history_end"})
		if err := writeFrame(payload); err != nil {
			return
		}
		for {
			if err := outputGate.wait(writeContext); err != nil {
				return
			}
			event, ok, err := outputBatcher.next(writeContext, events)
			if err != nil {
				return
			}
			if !ok {
				select {
				case <-lagged:
					return
				default:
				}
				exitCode := s.sessionExitCode(id)
				payload := marshalTerminalFrame(serverMessage{Type: "exit", ExitCode: exitCode})
				_ = writeFrame(payload)
				return
			}
			message := serverMessage{Type: "output", Data: event.Data}
			if event.Cols > 0 && event.Rows > 0 {
				message = serverMessage{
					Type: "resize",
					Cols: event.Cols,
					Rows: event.Rows,
				}
			}
			payload := marshalTerminalFrame(message)
			if err := writeFrame(payload); err != nil {
				return
			}
		}
	}()

	if ticket.readOnly {
		_, _, err := connection.Read(ctx)
		if err == nil {
			_ = connection.Close(websocket.StatusPolicyViolation, "observe streams are read-only")
		}
		return
	}

	invalidMessages := 0
	for {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			cancel()
			return
		}
		var message clientMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			invalidMessages++
		} else {
			switch message.Type {
			case "input":
				data := []byte(message.Data)
				if len(data) == 0 {
					invalidMessages++
				} else if err := s.control.SendTerminalBytes(id, data); err != nil {
					if errors.Is(err, control.ErrTerminalLocked) {
						continue
					}
					return
				} else if strings.ContainsAny(string(data), "\r\n") {
					if cancelCWDRefresh != nil {
						cancelCWDRefresh()
					}
					refreshContext, cancelRefresh := context.WithCancel(ctx)
					cancelCWDRefresh = cancelRefresh
					go s.refreshCWDWhileCommandSettles(refreshContext, id)
				}
			case "resize":
				if reportSize == nil || reportSize(message.Cols, message.Rows) != nil {
					invalidMessages++
				}
			case "resize_release":
				if releaseSize == nil || releaseSize() != nil {
					invalidMessages++
				}
			case "cwd":
				if _, err := s.sessions.UpdateCWD(id, message.Data); err == nil && cancelCWDRefresh != nil {
					cancelCWDRefresh()
					cancelCWDRefresh = nil
				}
			case "pause":
				outputGate.pause()
			case "resume":
				outputGate.resume()
			default:
				invalidMessages++
			}
		}
		if invalidMessages >= 3 {
			_ = connection.Close(websocket.StatusPolicyViolation, "too many invalid messages")
			return
		}
		select {
		case <-outputDone:
			return
		default:
		}
	}
}

func marshalTerminalFrame(message serverMessage) []byte {
	payload, _ := json.Marshal(message)
	return payload
}

func monitorTerminalWebSocket(
	ctx context.Context,
	interval time.Duration,
	timeout time.Duration,
	ping func(context.Context) error,
) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}

		pingContext, cancel := context.WithTimeout(ctx, timeout)
		err := ping(pingContext)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}

func interruptTerminalWritesOnLag(
	parent context.Context,
	lagged <-chan struct{},
	closeConnection func(),
) (context.Context, context.CancelFunc) {
	writeContext, cancel := context.WithCancel(parent)
	go func() {
		select {
		case <-lagged:
			go closeConnection()
			cancel()
		case <-writeContext.Done():
		}
	}()
	return writeContext, cancel
}

func (s *Server) refreshCWDWhileCommandSettles(ctx context.Context, id string) {
	delays := [...]time.Duration{
		100 * time.Millisecond,
		250 * time.Millisecond,
		500 * time.Millisecond,
		time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
		15 * time.Second,
	}
	for _, delay := range delays {
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return
		}
		if _, err := s.sessions.RefreshCWD(id); err != nil {
			return
		}
	}
}

func (s *Server) sessionExitCode(id string) *int {
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		for _, metadata := range s.sessions.ListStored() {
			if metadata.ID == id && metadata.ExitCode != nil {
				return metadata.ExitCode
			}
		}
		time.Sleep(time.Millisecond)
	}
	return nil
}
