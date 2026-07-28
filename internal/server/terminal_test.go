package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/euphony/internal/session"
)

func TestTerminalWebSocketStreamsPTY(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Terminal"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)

	ticketResponse := performRequest(t, srv, http.MethodPost, "/api/sessions/"+metadata.ID+"/tickets", "")
	if ticketResponse.Code != http.StatusCreated {
		t.Fatalf("POST ticket status = %d, body = %s", ticketResponse.Code, ticketResponse.Body.String())
	}
	var ticket struct {
		Ticket string `json:"ticket"`
	}
	decodeResponse(t, ticketResponse, &ticket)

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") +
		"/api/sessions/" + metadata.ID + "/terminal?ticket=" + ticket.Ticket
	connection, response, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("websocket.Dial() status = %d, error = %v", status, err)
	}
	defer connection.CloseNow()

	input, _ := json.Marshal(clientMessage{Type: "input", Data: "printf 'socket-ready\\n'\n"})
	if err := connection.Write(ctx, websocket.MessageText, input); err != nil {
		t.Fatalf("Write(input) error = %v", err)
	}

	var combined strings.Builder
	for !strings.Contains(combined.String(), "socket-ready\r\n") {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			t.Fatalf("Read() error = %v; output = %q", err, combined.String())
		}
		var message serverMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatalf("decode message: %v", err)
		}
		if message.Type == "output" {
			combined.WriteString(message.Data)
		}
	}

	resize, _ := json.Marshal(clientMessage{Type: "resize", Cols: 120, Rows: 40})
	if err := connection.Write(ctx, websocket.MessageText, resize); err != nil {
		t.Fatalf("Write(resize) error = %v", err)
	}
}

func TestTerminalRejectsReusedTicket(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Terminal"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)
	ticketResponse := performRequest(t, srv, http.MethodPost, "/api/sessions/"+metadata.ID+"/tickets", "")
	var ticket struct {
		Ticket string `json:"ticket"`
	}
	decodeResponse(t, ticketResponse, &ticket)

	request := httptest.NewRequest(http.MethodGet,
		"/api/sessions/"+metadata.ID+"/terminal?ticket="+ticket.Ticket, nil)
	first := httptest.NewRecorder()
	srv.Handler().ServeHTTP(first, request)

	secondRequest := httptest.NewRequest(http.MethodGet,
		"/api/sessions/"+metadata.ID+"/terminal?ticket="+ticket.Ticket, nil)
	second := httptest.NewRecorder()
	srv.Handler().ServeHTTP(second, secondRequest)
	if second.Code != http.StatusUnauthorized {
		t.Fatalf("reused ticket status = %d, want 401", second.Code)
	}
}
