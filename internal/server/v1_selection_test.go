package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

func TestV1SelectionActionsReturnAuthoritativeSnapshot(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Selected","cwd":`+strconv.Quote(t.TempDir())+`,"selectionMode":"none"}`)
	var createEnvelope struct {
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, created, &createEnvelope)
	id := createEnvelope.Result.Terminal.ID

	added := performRequest(t, srv, http.MethodPost, "/api/v1/selection/actions",
		`{"type":"add","terminalIds":["`+id+`"]}`)
	if added.Code != http.StatusOK {
		t.Fatalf("add status = %d, body = %s", added.Code, added.Body.String())
	}
	pinned := performRequest(t, srv, http.MethodPost, "/api/v1/selection/actions",
		`{"type":"pin","terminalIds":["`+id+`"]}`)
	if pinned.Code != http.StatusOK {
		t.Fatalf("pin status = %d, body = %s", pinned.Code, pinned.Body.String())
	}
	got := performRequest(t, srv, http.MethodGet, "/api/v1/selection", "")
	var envelope struct {
		Result selection.Snapshot `json:"result"`
	}
	decodeResponse(t, got, &envelope)
	if len(envelope.Result.TerminalIDs) != 1 ||
		len(envelope.Result.PinnedTerminalIDs) != 1 ||
		envelope.Result.TerminalIDs[0] != id ||
		envelope.Result.PinnedTerminalIDs[0] != id ||
		envelope.Result.FocusedTerminalID != id {
		t.Fatalf("selection = %#v", envelope.Result)
	}
}

func TestV1SelectionPutReplacesAllSourcesWithRevisionCheck(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	created := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Pinned","cwd":`+strconv.Quote(t.TempDir())+`,"selectionMode":"none"}`)
	var createEnvelope struct {
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, created, &createEnvelope)
	id := createEnvelope.Result.Terminal.ID
	current := srv.control.Selection()
	body, err := json.Marshal(map[string]any{
		"manualTerminalIds": []string{},
		"pinnedTerminalIds": []string{id},
		"focusedTerminalId": id,
		"filters": map[string]any{
			"statuses": []string{},
			"cwds":     []selection.CWDFilter{},
		},
		"expectedRevision": current.Revision,
	})
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	response := performRequest(t, srv, http.MethodPut, "/api/v1/selection", string(body))
	if response.Code != http.StatusOK {
		t.Fatalf("PUT selection status = %d, body = %s",
			response.Code, response.Body.String())
	}
	var envelope struct {
		Result selection.Snapshot `json:"result"`
	}
	decodeResponse(t, response, &envelope)
	if len(envelope.Result.PinnedTerminalIDs) != 1 ||
		envelope.Result.PinnedTerminalIDs[0] != id ||
		envelope.Result.FocusedTerminalID != id ||
		envelope.Result.Revision != current.Revision+1 {
		t.Fatalf("selection = %#v", envelope.Result)
	}

	stale := performRequest(t, srv, http.MethodPut, "/api/v1/selection", string(body))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale PUT status = %d, body = %s", stale.Code, stale.Body.String())
	}
}
