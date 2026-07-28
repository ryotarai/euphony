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

func TestTerminalReconnectKeepsSessionAndReceivesNewOutput(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Reconnect"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)

	first := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	firstContext, firstCancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer firstCancel()
	configure, _ := json.Marshal(clientMessage{Type: "input", Data: "stty -echo; printf 'echo-configured\\n'\n"})
	if err := first.Write(firstContext, websocket.MessageText, configure); err != nil {
		t.Fatalf("first Write() error = %v", err)
	}
	var configured strings.Builder
	for strings.Count(configured.String(), "echo-configured") < 2 {
		_, payload, err := first.Read(firstContext)
		if err != nil {
			t.Fatalf("first Read() error = %v", err)
		}
		var message serverMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatalf("decode first message: %v", err)
		}
		if message.Type == "output" {
			configured.WriteString(message.Data)
		}
	}
	delayed, _ := json.Marshal(clientMessage{Type: "input", Data: "sleep 0.5; printf 'after-reconnect\\n'\n"})
	if err := first.Write(firstContext, websocket.MessageText, delayed); err != nil {
		t.Fatalf("first delayed Write() error = %v", err)
	}
	if err := first.Close(websocket.StatusNormalClosure, "switching browser connection"); err != nil {
		t.Fatalf("first Close() error = %v", err)
	}

	second := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	defer second.CloseNow()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var output strings.Builder
	for !strings.Contains(output.String(), "after-reconnect\r\n") {
		_, payload, err := second.Read(ctx)
		if err != nil {
			t.Fatalf("second Read() error = %v; output = %q", err, output.String())
		}
		var message serverMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatalf("decode message: %v", err)
		}
		if message.Type == "output" {
			output.WriteString(message.Data)
		}
	}

	listed := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
	var sessions []session.Metadata
	decodeResponse(t, listed, &sessions)
	if len(sessions) != 1 || sessions[0].State != session.StateRunning {
		t.Fatalf("sessions after reconnect = %#v", sessions)
	}
}

func dialTerminal(t *testing.T, srv *Server, baseURL, sessionID string) *websocket.Conn {
	t.Helper()
	ticketResponse := performRequest(t, srv, http.MethodPost, "/api/sessions/"+sessionID+"/tickets", "")
	var ticket struct {
		Ticket string `json:"ticket"`
	}
	decodeResponse(t, ticketResponse, &ticket)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(baseURL, "http") +
		"/api/sessions/" + sessionID + "/terminal?ticket=" + ticket.Ticket
	connection, response, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("websocket.Dial() status = %d, error = %v", status, err)
	}
	return connection
}
