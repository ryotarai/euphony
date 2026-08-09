package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

func TestV1TerminalCreateListGetAndDelete(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	cwd := t.TempDir()

	created := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"API","cwd":`+strconv.Quote(cwd)+`,"selectionMode":"replace"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	var createEnvelope struct {
		OK     bool `json:"ok"`
		Result struct {
			Terminal  session.Metadata   `json:"terminal"`
			Selection selection.Snapshot `json:"selection"`
		} `json:"result"`
	}
	decodeResponse(t, created, &createEnvelope)
	terminal := createEnvelope.Result.Terminal
	if !createEnvelope.OK || terminal.ID == "" || terminal.CWD != cwd ||
		createEnvelope.Result.Selection.FocusedTerminalID != terminal.ID {
		t.Fatalf("create envelope = %#v", createEnvelope)
	}

	listed := performRequest(t, srv, http.MethodGet, "/api/v1/terminals", "")
	var listEnvelope struct {
		OK     bool `json:"ok"`
		Result struct {
			Terminals []session.Metadata `json:"terminals"`
		} `json:"result"`
	}
	decodeResponse(t, listed, &listEnvelope)
	if len(listEnvelope.Result.Terminals) != 1 ||
		listEnvelope.Result.Terminals[0].ID != terminal.ID {
		t.Fatalf("list envelope = %#v", listEnvelope)
	}

	got := performRequest(t, srv, http.MethodGet,
		"/api/v1/terminals/"+terminal.ID, "")
	if got.Code != http.StatusOK || !strings.Contains(got.Body.String(), terminal.ID) {
		t.Fatalf("get status = %d, body = %s", got.Code, got.Body.String())
	}

	deleted := performRequest(t, srv, http.MethodDelete,
		"/api/v1/terminals/"+terminal.ID, "")
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", deleted.Code, deleted.Body.String())
	}
	missing := performRequest(t, srv, http.MethodGet,
		"/api/v1/terminals/"+terminal.ID, "")
	var errorEnvelope struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeResponse(t, missing, &errorEnvelope)
	if missing.Code != http.StatusNotFound || errorEnvelope.OK ||
		errorEnvelope.Error.Code != "terminal_not_found" {
		t.Fatalf("missing response = %d %#v", missing.Code, errorEnvelope)
	}
}

func TestV1TerminalInputReturnsConflictWhileInboxAutomationOwnsTerminal(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	created := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Locked","cwd":`+strconv.Quote(t.TempDir())+`,"selectionMode":"none"}`)
	var createEnvelope struct {
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, created, &createEnvelope)
	id := createEnvelope.Result.Terminal.ID
	automationDone := make(chan error, 1)
	go func() {
		automationDone <- srv.control.RunTerminalAutomation(
			context.Background(), id, []byte("sleep 0.25; printf 'v1-busy\\n'\r"),
		)
	}()
	deadline := time.Now().Add(time.Second)
	for !srv.control.IsTerminalLocked(id) && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !srv.control.IsTerminalLocked(id) {
		t.Fatal("automation did not acquire terminal lock")
	}
	response := performRequest(t, srv, http.MethodPost, "/api/v1/terminals/"+id+"/input",
		`{"text":"ordinary\\r"}`)
	if response.Code != http.StatusConflict {
		t.Fatalf("locked v1 input status = %d, body = %s", response.Code, response.Body.String())
	}
	var envelope struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeResponse(t, response, &envelope)
	if envelope.OK || envelope.Error.Code != "terminal_locked" {
		t.Fatalf("locked v1 input envelope = %#v, want terminal_locked", envelope)
	}
	if err := <-automationDone; err != nil {
		t.Fatalf("background automation error = %v", err)
	}
}

func TestV1TerminalRename(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"API","cwd":`+strconv.Quote(t.TempDir())+`}`)
	var createEnvelope struct {
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, created, &createEnvelope)
	id := createEnvelope.Result.Terminal.ID

	for _, name := range []string{"   ", strings.Repeat("あ", 81)} {
		response := performRequest(t, srv, http.MethodPatch,
			"/api/v1/terminals/"+id, `{"name":`+strconv.Quote(name)+`}`)
		var envelope struct {
			OK    bool `json:"ok"`
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		decodeResponse(t, response, &envelope)
		if response.Code != http.StatusBadRequest || envelope.OK || envelope.Error.Code != "invalid_name" {
			t.Fatalf("invalid rename %q response = %d %#v", name, response.Code, envelope)
		}
	}

	renamed := performRequest(t, srv, http.MethodPatch,
		"/api/v1/terminals/"+id, `{"name":"  Renamed API  "}`)
	if renamed.Code != http.StatusOK {
		t.Fatalf("rename status = %d, body = %s", renamed.Code, renamed.Body.String())
	}
	var renameEnvelope struct {
		OK     bool `json:"ok"`
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, renamed, &renameEnvelope)
	if !renameEnvelope.OK || renameEnvelope.Result.Terminal.Name != "Renamed API" ||
		!renameEnvelope.Result.Terminal.CustomName {
		t.Fatalf("rename envelope = %#v", renameEnvelope)
	}

	missing := performRequest(t, srv, http.MethodPatch,
		"/api/v1/terminals/missing", `{"name":"Renamed"}`)
	var errorEnvelope struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeResponse(t, missing, &errorEnvelope)
	if missing.Code != http.StatusNotFound || errorEnvelope.OK ||
		errorEnvelope.Error.Code != "terminal_not_found" {
		t.Fatalf("missing rename response = %d %#v", missing.Code, errorEnvelope)
	}
}

func TestV1TerminalInputWaitAndReadPreserveBytes(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Bytes","cwd":`+strconv.Quote(t.TempDir())+`,"selectionMode":"none"}`)
	var createEnvelope struct {
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, created, &createEnvelope)
	id := createEnvelope.Result.Terminal.ID

	command := []byte("printf '\\377\\033[31mV1_RAW_OK\\033[0m\\n'\r")
	input := performRequest(t, srv, http.MethodPost,
		"/api/v1/terminals/"+id+"/input",
		`{"dataBase64":`+strconv.Quote(base64.RawStdEncoding.EncodeToString(command))+`}`)
	if input.Code != http.StatusOK {
		t.Fatalf("input status = %d, body = %s", input.Code, input.Body.String())
	}
	waited := performRequest(t, srv, http.MethodPost,
		"/api/v1/terminals/"+id+"/wait-output",
		`{"match":"V1_RAW_OK","timeoutMs":3000,"maxBytes":1048576}`)
	if waited.Code != http.StatusOK {
		t.Fatalf("wait status = %d, body = %s", waited.Code, waited.Body.String())
	}
	var waitEnvelope struct {
		Result control.WaitOutputResult `json:"result"`
	}
	decodeResponse(t, waited, &waitEnvelope)
	if !strings.Contains(waitEnvelope.Result.MatchedLine, "V1_RAW_OK") {
		t.Fatalf("wait result = %#v", waitEnvelope.Result)
	}

	read := performRequest(t, srv, http.MethodGet,
		"/api/v1/terminals/"+id+"/output?maxBytes=1048576", "")
	var readEnvelope struct {
		Result control.TerminalRead `json:"result"`
	}
	decodeResponse(t, read, &readEnvelope)
	raw, err := base64.RawStdEncoding.DecodeString(readEnvelope.Result.DataBase64)
	if err != nil || !strings.Contains(string(raw), "V1_RAW_OK") ||
		strings.Contains(readEnvelope.Result.Text, "\x1b[31m") {
		t.Fatalf("read result = %#v, decode error = %v", readEnvelope.Result, err)
	}
}

func TestV1TerminalRequestRejectsUnknownFields(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	response := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Invalid","selectionMode":"none","extra":true}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var envelope map[string]any
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil ||
		envelope["ok"] != false {
		t.Fatalf("error envelope = %#v, %v", envelope, err)
	}
}

func TestV1TerminalWaitRejectsNegativeTimeout(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	created := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Wait","cwd":`+strconv.Quote(t.TempDir())+`}`)
	var createEnvelope struct {
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, created, &createEnvelope)

	response := performRequest(t, srv, http.MethodPost,
		"/api/v1/terminals/"+createEnvelope.Result.Terminal.ID+"/wait-output",
		`{"match":"never","timeoutMs":-1}`)
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeResponse(t, response, &envelope)
	if response.Code != http.StatusBadRequest || envelope.Error.Code != "invalid_timeout" {
		t.Fatalf("response = %d %#v", response.Code, envelope)
	}

	response = performRequest(t, srv, http.MethodPost,
		"/api/v1/terminals/"+createEnvelope.Result.Terminal.ID+"/wait-output",
		`{"match":"never","maxBytes":-1}`)
	decodeResponse(t, response, &envelope)
	if response.Code != http.StatusBadRequest || envelope.Error.Code != "invalid_max_bytes" {
		t.Fatalf("negative maxBytes response = %d %#v", response.Code, envelope)
	}
}

func TestV1RequestRejectsOversizedTrailingWhitespace(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	body := `{"command":"true"}` + strings.Repeat(" ", maxV1RequestBody)
	response := performRequest(t, srv, http.MethodPost,
		"/api/v1/terminals/missing/run", body)
	var envelope struct {
		Error struct {
			Code    string         `json:"code"`
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	decodeResponse(t, response, &envelope)
	if response.Code != http.StatusRequestEntityTooLarge ||
		envelope.Error.Code != "request_too_large" ||
		envelope.Error.Details == nil {
		t.Fatalf("response = %d %#v", response.Code, envelope)
	}
}

func TestV1TerminalObserveWebSocketStreamsRawBase64Frames(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	created := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Observe","cwd":`+strconv.Quote(t.TempDir())+`,"selectionMode":"none"}`)
	var createEnvelope struct {
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, created, &createEnvelope)
	id := createEnvelope.Result.Terminal.ID
	command := base64.RawStdEncoding.EncodeToString([]byte("printf 'V1_STREAM_OK\\n'\r"))
	input := performRequest(t, srv, http.MethodPost, "/api/v1/terminals/"+id+"/input",
		`{"dataBase64":`+strconv.Quote(command)+`}`)
	if input.Code != http.StatusOK {
		t.Fatalf("input status = %d, body = %s", input.Code, input.Body.String())
	}
	waited := performRequest(t, srv, http.MethodPost,
		"/api/v1/terminals/"+id+"/wait-output",
		`{"match":"V1_STREAM_OK","timeoutMs":3000}`)
	if waited.Code != http.StatusOK {
		t.Fatalf("wait status = %d, body = %s", waited.Code, waited.Body.String())
	}
	ticketResponse := performRequest(t, srv, http.MethodPost,
		"/api/v1/terminals/"+id+"/tickets", `{"mode":"observe"}`)
	var ticketEnvelope struct {
		Result struct {
			Ticket string `json:"ticket"`
		} `json:"result"`
	}
	decodeResponse(t, ticketResponse, &ticketEnvelope)
	if ticketResponse.Code != http.StatusCreated || ticketEnvelope.Result.Ticket == "" {
		t.Fatalf("ticket response = %d %#v", ticketResponse.Code, ticketEnvelope)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") +
		"/api/v1/terminals/" + id + "/stream?ticket=" + ticketEnvelope.Result.Ticket
	connection, response, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		status := 0
		if response != nil {
			status = response.StatusCode
		}
		t.Fatalf("websocket.Dial() status = %d, error = %v", status, err)
	}
	defer connection.CloseNow()

	var combined []byte
	for {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			t.Fatalf("Read() error = %v, output = %q", err, combined)
		}
		var frame struct {
			Type       string `json:"type"`
			DataBase64 string `json:"dataBase64"`
		}
		if err := json.Unmarshal(payload, &frame); err != nil {
			t.Fatalf("decode frame: %v", err)
		}
		if frame.DataBase64 != "" {
			data, err := base64.RawStdEncoding.DecodeString(frame.DataBase64)
			if err != nil {
				t.Fatalf("decode frame bytes: %v", err)
			}
			combined = append(combined, data...)
		}
		if frame.Type == "history_end" {
			break
		}
	}
	if !bytes.Contains(combined, []byte("V1_STREAM_OK")) {
		t.Fatalf("stream history = %q", combined)
	}
}
