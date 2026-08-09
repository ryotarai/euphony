package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/euphony/internal/session"
)

func TestTerminalWebSocketPreservesSplitUTF8Bytes(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"UTF-8"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)
	connection := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	defer connection.CloseNow()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	configure, _ := json.Marshal(clientMessage{
		Type: "input",
		Data: "stty -echo; printf 'echo-disabled\\n'\n",
	})
	if err := connection.Write(ctx, websocket.MessageText, configure); err != nil {
		t.Fatalf("Write(configure) error = %v", err)
	}
	for {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			t.Fatalf("Read(configure) error = %v", err)
		}
		var message serverMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatalf("decode configure message: %v", err)
		}
		if message.Type == "output" && strings.Contains(string(message.Data), "echo-disabled") {
			break
		}
	}

	fragmented, _ := json.Marshal(clientMessage{
		Type: "input",
		Data: "printf '\\343'; sleep 0.05; printf '\\201\\202\\n'\n",
	})
	if err := connection.Write(ctx, websocket.MessageText, fragmented); err != nil {
		t.Fatalf("Write(fragmented UTF-8) error = %v", err)
	}

	var combined []byte
	for !bytes.Contains(combined, []byte("あ\r\n")) {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			t.Fatalf("Read(fragmented UTF-8) error = %v; output = %q", err, combined)
		}
		var message struct {
			Type string `json:"type"`
			Data string `json:"data"`
		}
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatalf("decode output message: %v", err)
		}
		if message.Type != "output" {
			continue
		}
		decoded, err := base64.StdEncoding.DecodeString(message.Data)
		if err != nil {
			t.Fatalf("output data is not base64: %v; data = %q", err, message.Data)
		}
		combined = append(combined, decoded...)
	}
}

func TestTerminalWebSocketWaitsForCodexAbortAfterCtrlC(t *testing.T) {
	transcriptPath := filepath.Join(t.TempDir(), "rollout-session-1.jsonl")
	if err := os.WriteFile(transcriptPath, []byte(
		`{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-1"}}`+"\n",
	), 0o600); err != nil {
		t.Fatalf("WriteFile(transcript) error = %v", err)
	}
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh", CodexSessionsRoot: filepath.Dir(transcriptPath),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Codex"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)
	if _, err := srv.sessions.UpdateAgent(metadata.ID, session.AgentUpdate{
		Agent: "codex", AgentSessionID: "session-1", TranscriptPath: transcriptPath,
		Status: "running",
	}); err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	terminal, ok := srv.sessions.Get(metadata.ID)
	if !ok {
		t.Fatal("terminal was not found")
	}
	if _, err := terminal.Write([]byte("stty intr undef; printf 'interrupt-ready\\n'\n")); err != nil {
		t.Fatalf("Write(disable interrupt) error = %v", err)
	}
	ready := false
	interruptDeadline := time.Now().Add(time.Second)
	for time.Now().Before(interruptDeadline) {
		read, readErr := srv.control.ReadTerminal(metadata.ID, 1024)
		if readErr == nil && strings.Contains(read.Text, "interrupt-ready") {
			ready = true
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !ready {
		t.Fatal("terminal did not finish interrupt setup")
	}

	connection := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	defer connection.CloseNow()
	events, unsubscribe := srv.control.SubscribeEvents([]string{"agent.updated"})
	defer unsubscribe()
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	payload, _ := json.Marshal(clientMessage{Type: "input", Data: "\x03"})
	if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("Write(ctrl-c) error = %v", err)
	}

	select {
	case event := <-events:
		t.Fatalf("agent.updated event = %#v, want no event before Codex abort", event.Data)
	case <-time.After(200 * time.Millisecond):
	}
	updated, ok := srv.sessions.Metadata(metadata.ID)
	if !ok || updated.AgentStatus != "running" {
		t.Fatalf("agent status after Ctrl-C = %#v, want running until abort", updated)
	}

	appendAbort := func(turnID string) {
		t.Helper()
		file, err := os.OpenFile(transcriptPath, os.O_APPEND|os.O_WRONLY, 0o600)
		if err != nil {
			t.Fatalf("OpenFile(transcript) error = %v", err)
		}
		_, writeErr := fmt.Fprintf(file, `{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":%q,"reason":"interrupted"}}`+"\n", turnID)
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			t.Fatalf("append Codex abort event: write = %v, close = %v", writeErr, closeErr)
		}
	}
	appendAbort("turn-2")
	select {
	case event := <-events:
		t.Fatalf("agent.updated event = %#v, want no event for another turn", event.Data)
	case <-time.After(200 * time.Millisecond):
	}
	updated, ok = srv.sessions.Metadata(metadata.ID)
	if !ok || updated.AgentStatus != "running" {
		t.Fatalf("agent status after another turn abort = %#v, want running", updated)
	}
	appendAbort("turn-1")

	select {
	case event := <-events:
		updated, ok := event.Data.(session.Metadata)
		if !ok || updated.ID != metadata.ID || updated.AgentStatus != "waiting" || !updated.NeedsAttention {
			t.Fatalf("agent.updated event = %#v, want waiting Codex metadata", event.Data)
		}
	case <-time.After(time.Second):
		updated, _ := srv.sessions.Metadata(metadata.ID)
		t.Fatalf("agent status = %q, want waiting after Codex abort", updated.AgentStatus)
	}
}

func TestInterruptTerminalWritesOnLag(t *testing.T) {
	lagged := make(chan struct{})
	closeCalled := make(chan struct{})
	writeContext, cancel := interruptTerminalWritesOnLag(
		t.Context(),
		lagged,
		func() { close(closeCalled) },
	)
	defer cancel()

	close(lagged)
	select {
	case <-closeCalled:
	case <-time.After(time.Second):
		t.Fatal("lagged subscriber did not close its WebSocket")
	}
	select {
	case <-writeContext.Done():
	case <-time.After(time.Second):
		t.Fatal("lagged subscriber did not cancel an in-progress history write")
	}
}

func TestMonitorTerminalWebSocketRepeatsSuccessfulPings(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	pings := make(chan struct{}, 2)
	done := make(chan error, 1)
	go func() {
		done <- monitorTerminalWebSocket(ctx, 10*time.Millisecond, time.Second, func(pingCtx context.Context) error {
			select {
			case pings <- struct{}{}:
				return nil
			case <-pingCtx.Done():
				return pingCtx.Err()
			}
		})
	}()

	for range 2 {
		select {
		case <-pings:
		case <-time.After(time.Second):
			t.Fatal("successful Ping did not repeat")
		}
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("monitorTerminalWebSocket() error = %v, want nil", err)
		}
	case <-time.After(time.Second):
		t.Fatal("monitor did not stop after parent cancellation")
	}
}

func TestMonitorTerminalWebSocketReturnsPingError(t *testing.T) {
	want := errors.New("Pong not received")
	err := monitorTerminalWebSocket(t.Context(), 10*time.Millisecond, time.Second, func(context.Context) error {
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("monitorTerminalWebSocket() error = %v, want %v", err, want)
	}
}

func TestMonitorTerminalWebSocketReturnsPingTimeout(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	err := monitorTerminalWebSocket(ctx, 10*time.Millisecond, 10*time.Millisecond, func(pingCtx context.Context) error {
		<-pingCtx.Done()
		return pingCtx.Err()
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("monitorTerminalWebSocket() error = %v, want %v", err, context.DeadlineExceeded)
	}
}

func TestMonitorTerminalWebSocketStopsWithoutErrorWhenParentIsCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	pingStarted := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- monitorTerminalWebSocket(ctx, 10*time.Millisecond, time.Second, func(pingCtx context.Context) error {
			close(pingStarted)
			<-pingCtx.Done()
			return pingCtx.Err()
		})
	}()

	select {
	case <-pingStarted:
	case <-time.After(time.Second):
		t.Fatal("monitor did not start Ping")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("monitorTerminalWebSocket() error = %v, want nil", err)
		}
	case <-time.After(time.Second):
		t.Fatal("monitor did not stop after parent cancellation")
	}
}

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
			combined.Write(message.Data)
		}
	}

	resize, _ := json.Marshal(clientMessage{Type: "resize", Cols: 120, Rows: 40})
	if err := connection.Write(ctx, websocket.MessageText, resize); err != nil {
		t.Fatalf("Write(resize) error = %v", err)
	}
}

func TestTerminalWebSocketDropsInputWhileInboxAutomationOwnsTerminal(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)
	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Locked socket"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)
	automationDone := make(chan error, 1)
	go func() {
		automationDone <- srv.control.RunTerminalAutomation(
			context.Background(), metadata.ID, []byte("sleep 0.25; printf 'socket-busy\\n'\r"),
		)
	}()
	deadline := time.Now().Add(time.Second)
	for !srv.control.IsTerminalLocked(metadata.ID) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !srv.control.IsTerminalLocked(metadata.ID) {
		t.Fatal("automation did not acquire terminal lock")
	}
	connection := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	defer connection.CloseNow()
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	input, _ := json.Marshal(clientMessage{Type: "input", Data: "printf 'socket-must-be-dropped\\n'\r"})
	if err := connection.Write(ctx, websocket.MessageText, input); err != nil {
		t.Fatalf("Write(locked input) error = %v", err)
	}
	if err := <-automationDone; err != nil {
		t.Fatalf("background automation error = %v", err)
	}
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		read, readErr := srv.control.ReadTerminal(metadata.ID, 4096)
		if readErr == nil && strings.Contains(read.Text, "socket-busy") {
			if strings.Contains(read.Text, "socket-must-be-dropped") {
				t.Fatalf("locked WebSocket input reached terminal: %q", read.Text)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("automation output was not observed")
}

func TestTerminalWebSocketsShareSmallestSize(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Shared size"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)
	large := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	defer large.CloseNow()
	small := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	defer small.CloseNow()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	assertTerminalResize(t, readTerminalMessage(t, ctx, large, "resize"), 80, 24)
	assertTerminalResize(t, readTerminalMessage(t, ctx, small, "resize"), 80, 24)
	readTerminalMessage(t, ctx, large, "history_end")
	readTerminalMessage(t, ctx, small, "history_end")

	writeTerminalResize(t, ctx, large, 120, 40)
	assertTerminalResize(t, readTerminalMessage(t, ctx, large, "resize"), 120, 40)
	assertTerminalResize(t, readTerminalMessage(t, ctx, small, "resize"), 120, 40)

	writeTerminalResize(t, ctx, small, 80, 24)
	assertTerminalResize(t, readTerminalMessage(t, ctx, large, "resize"), 80, 24)
	assertTerminalResize(t, readTerminalMessage(t, ctx, small, "resize"), 80, 24)

	release, _ := json.Marshal(clientMessage{Type: "resize_release"})
	if err := small.Write(ctx, websocket.MessageText, release); err != nil {
		t.Fatalf("small Write(resize_release) error = %v", err)
	}
	assertTerminalResize(t, readTerminalMessage(t, ctx, large, "resize"), 120, 40)
	assertTerminalResize(t, readTerminalMessage(t, ctx, small, "resize"), 120, 40)

	writeTerminalResize(t, ctx, small, 80, 24)
	assertTerminalResize(t, readTerminalMessage(t, ctx, large, "resize"), 80, 24)
	assertTerminalResize(t, readTerminalMessage(t, ctx, small, "resize"), 80, 24)

	if err := small.Close(websocket.StatusNormalClosure, "smaller browser closed"); err != nil {
		t.Fatalf("small Close() error = %v", err)
	}
	assertTerminalResize(t, readTerminalMessage(t, ctx, large, "resize"), 120, 40)
}

func writeTerminalResize(
	t *testing.T,
	ctx context.Context,
	connection *websocket.Conn,
	cols, rows uint16,
) {
	t.Helper()
	payload, err := json.Marshal(clientMessage{Type: "resize", Cols: cols, Rows: rows})
	if err != nil {
		t.Fatalf("encode resize: %v", err)
	}
	if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("Write(resize %dx%d) error = %v", cols, rows, err)
	}
}

func readTerminalMessage(
	t *testing.T,
	ctx context.Context,
	connection *websocket.Conn,
	messageType string,
) struct {
	Type string `json:"type"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
} {
	t.Helper()
	for {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			t.Fatalf("Read(%s) error = %v", messageType, err)
		}
		var message struct {
			Type string `json:"type"`
			Cols uint16 `json:"cols"`
			Rows uint16 `json:"rows"`
		}
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatalf("decode %s message: %v", messageType, err)
		}
		if message.Type == messageType {
			return message
		}
	}
}

func assertTerminalResize(
	t *testing.T,
	message struct {
		Type string `json:"type"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	},
	cols, rows uint16,
) {
	t.Helper()
	if message.Cols != cols || message.Rows != rows {
		t.Fatalf("resize = %dx%d, want %dx%d", message.Cols, message.Rows, cols, rows)
	}
}

func TestTerminalWebSocketUpdatesCurrentWorkingDirectory(t *testing.T) {
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
	connection := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	defer connection.CloseNow()

	cwd := t.TempDir()
	payload, _ := json.Marshal(clientMessage{Type: "cwd", Data: cwd})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("Write(cwd) error = %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		listed := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
		var sessions []session.Metadata
		decodeResponse(t, listed, &sessions)
		if len(sessions) == 1 && sessions[0].CWD == cwd {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sessions after cwd update = %#v, want cwd %q", sessions, cwd)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTerminalWebSocketTracksPlainShellCD(t *testing.T) {
	initialCWD := t.TempDir()
	intermediateCWD := t.TempDir()
	nextCWD := t.TempDir()
	resolvedNextCWD, err := filepath.EvalSymlinks(nextCWD)
	if err != nil {
		t.Fatalf("EvalSymlinks(next cwd) error = %v", err)
	}
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	created := performRequest(t, srv, http.MethodPost, "/api/sessions",
		`{"name":"Terminal","cwd":`+strconv.Quote(initialCWD)+`}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)
	connection := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	defer connection.CloseNow()

	payload, _ := json.Marshal(clientMessage{
		Type: "input",
		Data: "cd " + strconv.Quote(intermediateCWD) +
			"; sleep 0.5; cd " + strconv.Quote(nextCWD) + "\n",
	})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("Write(cd) error = %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		listed := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
		var sessions []session.Metadata
		decodeResponse(t, listed, &sessions)
		if len(sessions) == 1 && sessions[0].CWD == resolvedNextCWD {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sessions after plain cd = %#v, want cwd %q", sessions, resolvedNextCWD)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestTerminalWebSocketIgnoresTitlesThatAreNotDirectories(t *testing.T) {
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
	connection := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	defer connection.CloseNow()

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	for _, title := range []string{"/missing/one", "/missing/two", "/missing/three"} {
		payload, _ := json.Marshal(clientMessage{Type: "cwd", Data: title})
		if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
			t.Fatalf("Write(invalid cwd %q) error = %v", title, err)
		}
	}
	cwd := t.TempDir()
	payload, _ := json.Marshal(clientMessage{Type: "cwd", Data: cwd})
	if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("Write(valid cwd) error = %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		listed := performRequest(t, srv, http.MethodGet, "/api/sessions", "")
		var sessions []session.Metadata
		decodeResponse(t, listed, &sessions)
		if len(sessions) == 1 && sessions[0].CWD == cwd {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sessions after invalid titles = %#v, want cwd %q", sessions, cwd)
		}
		time.Sleep(10 * time.Millisecond)
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

func TestTerminalWebSocketDoesNotReportExitForLaggingClient(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	created := performRequest(t, srv, http.MethodPost, "/api/sessions", `{"name":"Burst"}`)
	var metadata session.Metadata
	decodeResponse(t, created, &metadata)

	connection := dialTerminal(t, srv, httpServer.URL, metadata.ID)
	defer connection.CloseNow()
	connection.SetReadLimit(8 * 1024 * 1024)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()

	burst, _ := json.Marshal(clientMessage{Type: "input", Data: "seq 1 100000; printf 'burst-done\\n'\n"})
	if err := connection.Write(ctx, websocket.MessageText, burst); err != nil {
		t.Fatalf("Write(burst) error = %v", err)
	}
	// Stop reading the way a busy browser tab does, then catch up.
	time.Sleep(500 * time.Millisecond)

	var output strings.Builder
	for !strings.Contains(output.String(), "burst-done\r\n") {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			t.Fatalf("Read() error = %v; output tail = %q", err, tail(output.String(), 200))
		}
		var message serverMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatalf("decode message: %v", err)
		}
		if message.Type == "exit" {
			t.Fatalf("received exit message while the terminal is running; output tail = %q",
				tail(output.String(), 200))
		}
		if message.Type == "output" || message.Type == "history" {
			output.Write(message.Data)
		}
	}
}

func tail(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[len(text)-limit:]
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
			configured.Write(message.Data)
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
	assertTerminalResize(t, readTerminalMessage(t, ctx, second, "resize"), 80, 24)
	_, historyPayload, err := second.Read(ctx)
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	var historyMessage serverMessage
	if err := json.Unmarshal(historyPayload, &historyMessage); err != nil {
		t.Fatalf("decode history: %v", err)
	}
	if historyMessage.Type != "history" {
		t.Fatalf("replayed message type = %q, want history", historyMessage.Type)
	}
	output.Write(historyMessage.Data)
	for !strings.Contains(output.String(), "after-reconnect\r\n") {
		_, payload, err := second.Read(ctx)
		if err != nil {
			t.Fatalf("second Read() error = %v; output = %q", err, output.String())
		}
		var message serverMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatalf("decode message: %v", err)
		}
		if message.Type == "output" || message.Type == "history" {
			output.Write(message.Data)
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
