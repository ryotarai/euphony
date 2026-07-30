package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestV1StatusUsesStableEnvelope(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	response := performRequest(t, srv, http.MethodGet, "/api/v1/status", "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/status status = %d, body = %s",
			response.Code, response.Body.String())
	}
	const want = "{\"ok\":true,\"result\":{\"apiVersion\":\"v1\",\"status\":\"ok\"}}\n"
	if response.Body.String() != want {
		t.Fatalf("GET /api/v1/status body = %q, want %q", response.Body.String(), want)
	}
}

func TestV1SchemaIsRawOpenAPI(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	response := performRequest(t, srv, http.MethodGet, "/api/v1/schema", "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/v1/schema status = %d, body = %s",
			response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "application/vnd.oai.openapi+json" {
		t.Fatalf("Content-Type = %q", got)
	}
	var document struct {
		OpenAPI string `json:"openapi"`
		Info    struct {
			Title   string `json:"title"`
			Version string `json:"version"`
		} `json:"info"`
	}
	if err := json.NewDecoder(response.Body).Decode(&document); err != nil {
		t.Fatalf("decode schema: %v", err)
	}
	if document.OpenAPI != "3.1.0" ||
		document.Info.Title != "Euphony Automation API" ||
		document.Info.Version != "v1" {
		t.Fatalf("schema identity = %#v", document)
	}
}

func TestV1AuthenticationFailureUsesV1ErrorEnvelope(t *testing.T) {
	srv, err := New(Config{Token: "correct-token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	request := httptest.NewRequest(http.MethodGet, "/api/v1/selection", nil)
	response := httptest.NewRecorder()
	srv.Handler().ServeHTTP(response, request)
	var envelope struct {
		OK    bool `json:"ok"`
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeResponse(t, response, &envelope)
	if response.Code != http.StatusUnauthorized || envelope.OK ||
		envelope.Error.Code != "unauthorized" {
		t.Fatalf("response = %d %#v", response.Code, envelope)
	}
}

func TestV1SchemaDescribesTerminalSelectionAndEventOperations(t *testing.T) {
	var document struct {
		Paths map[string]map[string]any `json:"paths"`
	}
	if err := json.Unmarshal(openAPIDocument, &document); err != nil {
		t.Fatalf("decode embedded schema: %v", err)
	}
	for path, method := range map[string]string{
		"/api/v1/events":                     "get",
		"/api/v1/terminals":                  "post",
		"/api/v1/terminals/{id}":             "delete",
		"/api/v1/terminals/{id}/output":      "get",
		"/api/v1/terminals/{id}/input":       "post",
		"/api/v1/terminals/{id}/run":         "post",
		"/api/v1/terminals/{id}/wait-output": "post",
		"/api/v1/terminals/{id}/tickets":     "post",
		"/api/v1/terminals/{id}/stream":      "get",
		"/api/v1/agents":                     "get",
		"/api/v1/agents/{id}":                "get",
		"/api/v1/agents/{id}/start":          "post",
		"/api/v1/agents/{id}/output":         "get",
		"/api/v1/agents/{id}/input":          "post",
		"/api/v1/agents/{id}/prompt":         "post",
		"/api/v1/agents/{id}/wait":           "post",
		"/api/v1/selection":                  "put",
		"/api/v1/selection/actions":          "post",
	} {
		operations, ok := document.Paths[path]
		if !ok {
			t.Errorf("schema missing path %s", path)
			continue
		}
		if _, ok := operations[method]; !ok {
			t.Errorf("schema path %s missing method %s", path, method)
		}
	}
}
