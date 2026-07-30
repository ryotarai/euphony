package server

import (
	"encoding/json"
	"net/http"
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
