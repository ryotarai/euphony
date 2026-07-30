package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/annotation"
	"github.com/ryotarai/euphony/internal/session"
)

func TestV1AnnotationCreateCurrentCompleteAndWait(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminalID := createAnnotationTestTerminal(t, srv)

	before := performRequest(t, srv, http.MethodGet,
		"/api/v1/terminals/"+terminalID+"/annotation", "")
	if before.Code != http.StatusOK || before.Body.String() !=
		"{\"ok\":true,\"result\":{\"annotation\":null}}\n" {
		t.Fatalf("current before create = %d %s", before.Code, before.Body.String())
	}

	events, unsubscribe := srv.control.SubscribeEvents([]string{"annotation.created"})
	defer unsubscribe()
	created := performRequest(t, srv, http.MethodPost, "/api/v1/annotations",
		`{"terminalId":`+strconv.Quote(terminalID)+
			`,"filename":"review.md","format":"markdown","content":"# Review"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	var createEnvelope struct {
		Result struct {
			Annotation annotation.Session `json:"annotation"`
		} `json:"result"`
	}
	decodeResponse(t, created, &createEnvelope)
	review := createEnvelope.Result.Annotation
	if review.ID == "" || review.TerminalID != terminalID ||
		review.Filename != "review.md" || review.Format != annotation.FormatMarkdown ||
		review.Content != "# Review" || review.CreatedAt.IsZero() {
		t.Fatalf("created annotation = %#v", review)
	}
	select {
	case event := <-events:
		data, ok := event.Data.(map[string]string)
		if event.Type != "annotation.created" || !ok ||
			data["id"] != review.ID || data["terminalId"] != terminalID ||
			len(data) != 2 {
			t.Fatalf("created event = %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("annotation.created event was not published")
	}

	current := performRequest(t, srv, http.MethodGet,
		"/api/v1/terminals/"+terminalID+"/annotation", "")
	var currentEnvelope struct {
		Result struct {
			Annotation *annotation.Session `json:"annotation"`
		} `json:"result"`
	}
	decodeResponse(t, current, &currentEnvelope)
	if currentEnvelope.Result.Annotation == nil ||
		currentEnvelope.Result.Annotation.ID != review.ID {
		t.Fatalf("current annotation = %#v", currentEnvelope)
	}

	complete := performRequest(t, srv, http.MethodPost,
		"/api/v1/annotations/"+review.ID+"/complete",
		`{"comments":[{"kind":"selection","body":"Clarify this.","quote":"Review","startOffset":2,"endOffset":8},{"kind":"global","body":"Good structure."}]}`)
	if complete.Code != http.StatusOK {
		t.Fatalf("complete status = %d, body = %s", complete.Code, complete.Body.String())
	}
	var completeEnvelope struct {
		Result annotation.Result `json:"result"`
	}
	decodeResponse(t, complete, &completeEnvelope)
	if completeEnvelope.Result.AnnotationID != review.ID ||
		len(completeEnvelope.Result.Comments) != 2 ||
		completeEnvelope.Result.Comments[0].Quote != "Review" {
		t.Fatalf("complete result = %#v", completeEnvelope.Result)
	}

	waited := performRequest(t, srv, http.MethodGet,
		"/api/v1/annotations/"+review.ID+"/wait", "")
	var waitEnvelope struct {
		Result annotation.Result `json:"result"`
	}
	decodeResponse(t, waited, &waitEnvelope)
	if waited.Code != http.StatusOK ||
		waitEnvelope.Result.AnnotationID != review.ID ||
		len(waitEnvelope.Result.Comments) != 2 {
		t.Fatalf("wait response = %d %#v", waited.Code, waitEnvelope)
	}

	after := performRequest(t, srv, http.MethodGet,
		"/api/v1/terminals/"+terminalID+"/annotation", "")
	if after.Body.String() != "{\"ok\":true,\"result\":{\"annotation\":null}}\n" {
		t.Fatalf("current after completion = %s", after.Body.String())
	}
}

func TestV1AnnotationValidatesTerminalDocumentAndComments(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminalID := createAnnotationTestTerminal(t, srv)

	tests := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{
			name:   "missing terminal",
			body:   `{"terminalId":"missing","filename":"review.md","format":"markdown","content":"Review"}`,
			status: http.StatusNotFound,
			code:   "terminal_not_found",
		},
		{
			name:   "empty filename",
			body:   `{"terminalId":` + strconv.Quote(terminalID) + `,"filename":" ","format":"markdown","content":"Review"}`,
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:   "unknown format",
			body:   `{"terminalId":` + strconv.Quote(terminalID) + `,"filename":"review.txt","format":"text","content":"Review"}`,
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
		{
			name:   "empty content",
			body:   `{"terminalId":` + strconv.Quote(terminalID) + `,"filename":"review.md","format":"markdown","content":""}`,
			status: http.StatusBadRequest,
			code:   "invalid_request",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performRequest(t, srv, http.MethodPost, "/api/v1/annotations", test.body)
			var envelope struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			decodeResponse(t, response, &envelope)
			if response.Code != test.status || envelope.Error.Code != test.code {
				t.Fatalf("response = %d %#v", response.Code, envelope)
			}
		})
	}

	created := performRequest(t, srv, http.MethodPost, "/api/v1/annotations",
		`{"terminalId":`+strconv.Quote(terminalID)+
			`,"filename":"review.html","format":"html","content":"<p>Review</p>"}`)
	var envelope struct {
		Result struct {
			Annotation annotation.Session `json:"annotation"`
		} `json:"result"`
	}
	decodeResponse(t, created, &envelope)
	id := envelope.Result.Annotation.ID
	conflict := performRequest(t, srv, http.MethodPost, "/api/v1/annotations",
		`{"terminalId":`+strconv.Quote(terminalID)+
			`,"filename":"other.html","format":"html","content":"<p>Other</p>"}`)
	assertV1Error(t, conflict, http.StatusConflict, "annotation_active")

	for name, body := range map[string]string{
		"empty body":           `{"comments":[{"kind":"global","body":" "}]}`,
		"unknown kind":         `{"comments":[{"kind":"inline","body":"No"}]}`,
		"selection no quote":   `{"comments":[{"kind":"selection","body":"No","startOffset":0,"endOffset":1}]}`,
		"selection no offsets": `{"comments":[{"kind":"selection","body":"No","quote":"R"}]}`,
		"reversed offsets":     `{"comments":[{"kind":"selection","body":"No","quote":"R","startOffset":2,"endOffset":1}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			response := performRequest(t, srv, http.MethodPost,
				"/api/v1/annotations/"+id+"/complete", body)
			assertV1Error(t, response, http.StatusBadRequest, "invalid_request")
		})
	}
}

func TestV1AnnotationCancelRemovesCurrentAndWakesWaiter(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminalID := createAnnotationTestTerminal(t, srv)
	created := performRequest(t, srv, http.MethodPost, "/api/v1/annotations",
		`{"terminalId":`+strconv.Quote(terminalID)+
			`,"filename":"review.md","format":"markdown","content":"Review"}`)
	var envelope struct {
		Result struct {
			Annotation annotation.Session `json:"annotation"`
		} `json:"result"`
	}
	decodeResponse(t, created, &envelope)
	id := envelope.Result.Annotation.ID

	canceled := performRequest(t, srv, http.MethodDelete, "/api/v1/annotations/"+id, "")
	if canceled.Code != http.StatusOK {
		t.Fatalf("cancel status = %d, body = %s", canceled.Code, canceled.Body.String())
	}
	waited := performRequest(t, srv, http.MethodGet, "/api/v1/annotations/"+id+"/wait", "")
	assertV1Error(t, waited, http.StatusGone, "annotation_canceled")
	missing := performRequest(t, srv, http.MethodDelete, "/api/v1/annotations/"+id, "")
	assertV1Error(t, missing, http.StatusNotFound, "annotation_not_found")
}

func createAnnotationTestTerminal(t *testing.T, srv *Server) string {
	t.Helper()
	response := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Annotate","cwd":`+strconv.Quote(t.TempDir())+`}`)
	var envelope struct {
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, response, &envelope)
	if response.Code != http.StatusCreated || envelope.Result.Terminal.ID == "" {
		t.Fatalf("create terminal = %d %#v", response.Code, envelope)
	}
	return envelope.Result.Terminal.ID
}

func assertV1Error(
	t *testing.T,
	response interface {
		Result() *http.Response
	},
	status int,
	code string,
) {
	t.Helper()
	httpResponse := response.Result()
	defer httpResponse.Body.Close()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(httpResponse.Body).Decode(&envelope); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if httpResponse.StatusCode != status || envelope.Error.Code != code {
		t.Fatalf("response = %d %#v, want %d %s",
			httpResponse.StatusCode, envelope, status, code)
	}
}
