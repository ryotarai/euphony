package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
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
}

func (s *Server) terminal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !s.tickets.consume(r.URL.Query().Get("ticket"), id) {
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
	var cancelCWDRefresh context.CancelFunc
	defer func() {
		if cancelCWDRefresh != nil {
			cancelCWDRefresh()
		}
	}()
	history, output, unsubscribe := terminal.Subscribe()
	defer unsubscribe()
	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		for _, chunk := range history {
			payload, _ := json.Marshal(serverMessage{Type: "history", Data: chunk})
			if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
				return
			}
		}
		payload, _ := json.Marshal(serverMessage{Type: "history_end"})
		if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
			return
		}
		for {
			select {
			case data, ok := <-output:
				if !ok {
					exitCode := s.sessionExitCode(id)
					payload, _ := json.Marshal(serverMessage{Type: "exit", ExitCode: exitCode})
					_ = connection.Write(ctx, websocket.MessageText, payload)
					return
				}
				payload, _ := json.Marshal(serverMessage{Type: "output", Data: data})
				if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}()

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
				if message.Data == "" {
					invalidMessages++
				} else if _, err := terminal.Write([]byte(message.Data)); err != nil {
					return
				} else if strings.ContainsAny(message.Data, "\r\n") {
					if cancelCWDRefresh != nil {
						cancelCWDRefresh()
					}
					refreshContext, cancelRefresh := context.WithCancel(ctx)
					cancelCWDRefresh = cancelRefresh
					go s.refreshCWDWhileCommandSettles(refreshContext, id)
				}
			case "resize":
				if err := terminal.Resize(message.Cols, message.Rows); err != nil {
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
