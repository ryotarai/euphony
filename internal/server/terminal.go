package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

type clientMessage struct {
	Type       string `json:"type"`
	Data       string `json:"data,omitempty"`
	DataBase64 string `json:"dataBase64,omitempty"`
	Cols       uint16 `json:"cols,omitempty"`
	Rows       uint16 `json:"rows,omitempty"`
}

type serverMessage struct {
	Type     string `json:"type"`
	Data     []byte `json:"data,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Message  string `json:"message,omitempty"`
	Cols     uint16 `json:"cols,omitempty"`
	Rows     uint16 `json:"rows,omitempty"`
}

func (s *Server) terminal(w http.ResponseWriter, r *http.Request) {
	s.terminalStream(w, r, false)
}

func (s *Server) v1TerminalStream(w http.ResponseWriter, r *http.Request) {
	s.terminalStream(w, r, true)
}

func (s *Server) terminalStream(w http.ResponseWriter, r *http.Request, v1 bool) {
	id := r.PathValue("id")
	ticket, valid := s.tickets.consumeEntry(r.URL.Query().Get("ticket"), id)
	if !valid {
		if v1 {
			writeV1Error(w, http.StatusUnauthorized, "invalid_ticket",
				"The terminal connection ticket is invalid or expired.", nil)
		} else {
			writeError(w, http.StatusUnauthorized, "invalid_ticket", "The terminal connection ticket is invalid or expired.")
		}
		return
	}
	terminal, ok := s.sessions.Get(id)
	if !ok {
		if v1 {
			writeV1Error(w, http.StatusNotFound, "terminal_not_found",
				"The terminal does not exist.", nil)
		} else {
			writeError(w, http.StatusNotFound, "session_not_found", "The terminal session does not exist.")
		}
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
	var cancelCWDRefresh context.CancelFunc
	defer func() {
		if cancelCWDRefresh != nil {
			cancelCWDRefresh()
		}
	}()
	history, output, lagged, unsubscribe := terminal.SubscribeWithStatus()
	defer unsubscribe()
	var reportSize func(uint16, uint16) error
	var sizeUpdates <-chan terminalDimensions
	if !ticket.readOnly {
		var unsubscribeSize func()
		reportSize, sizeUpdates, unsubscribeSize = s.terminalSizes.subscribe(
			id,
			terminal.Resize,
		)
		defer unsubscribeSize()
	}
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
		for _, chunk := range history {
			payload := marshalTerminalFrame(serverMessage{Type: "history", Data: chunk}, v1)
			if err := connection.Write(writeContext, websocket.MessageText, payload); err != nil {
				return
			}
		}
		payload := marshalTerminalFrame(serverMessage{Type: "history_end"}, v1)
		if err := connection.Write(writeContext, websocket.MessageText, payload); err != nil {
			return
		}
		for {
			select {
			case dimensions := <-sizeUpdates:
				payload := marshalTerminalFrame(serverMessage{
					Type: "resize",
					Cols: dimensions.Cols,
					Rows: dimensions.Rows,
				}, v1)
				if err := connection.Write(writeContext, websocket.MessageText, payload); err != nil {
					return
				}
				continue
			default:
			}
			select {
			case data, ok := <-output:
				if !ok {
					select {
					case <-lagged:
						return
					default:
					}
					exitCode := s.sessionExitCode(id)
					payload := marshalTerminalFrame(serverMessage{Type: "exit", ExitCode: exitCode}, v1)
					_ = connection.Write(writeContext, websocket.MessageText, payload)
					return
				}
				payload := marshalTerminalFrame(serverMessage{Type: "output", Data: data}, v1)
				if err := connection.Write(writeContext, websocket.MessageText, payload); err != nil {
					return
				}
			case dimensions := <-sizeUpdates:
				payload := marshalTerminalFrame(serverMessage{
					Type: "resize",
					Cols: dimensions.Cols,
					Rows: dimensions.Rows,
				}, v1)
				if err := connection.Write(writeContext, websocket.MessageText, payload); err != nil {
					return
				}
			case <-lagged:
				return
			case <-ctx.Done():
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
				if v1 {
					data, err = base64.RawStdEncoding.DecodeString(message.DataBase64)
				}
				if err != nil || len(data) == 0 {
					invalidMessages++
				} else if _, err := terminal.Write(data); err != nil {
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
			case "cwd":
				if _, err := s.sessions.UpdateCWD(id, message.Data); err == nil && cancelCWDRefresh != nil {
					cancelCWDRefresh()
					cancelCWDRefresh = nil
				}
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

func marshalTerminalFrame(message serverMessage, v1 bool) []byte {
	if !v1 {
		payload, _ := json.Marshal(message)
		return payload
	}
	payload, _ := json.Marshal(struct {
		Type       string `json:"type"`
		DataBase64 string `json:"dataBase64,omitempty"`
		ExitCode   *int   `json:"exitCode,omitempty"`
		Message    string `json:"message,omitempty"`
		Cols       uint16 `json:"cols,omitempty"`
		Rows       uint16 `json:"rows,omitempty"`
	}{
		Type:       message.Type,
		DataBase64: base64.RawStdEncoding.EncodeToString(message.Data),
		ExitCode:   message.ExitCode,
		Message:    message.Message,
		Cols:       message.Cols,
		Rows:       message.Rows,
	})
	return payload
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
		for _, metadata := range s.sessions.List() {
			if metadata.ID == id && metadata.ExitCode != nil {
				return metadata.ExitCode
			}
		}
		time.Sleep(time.Millisecond)
	}
	return nil
}
