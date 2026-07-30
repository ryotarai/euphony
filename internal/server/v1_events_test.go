package server

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/control"
)

func TestV1EventsStreamsFilteredNDJSONRecords(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	httpServer := httptest.NewServer(srv.Handler())
	t.Cleanup(httpServer.Close)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet,
		httpServer.URL+"/api/v1/events?type=terminal.created", nil)
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer token")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("events request error = %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK ||
		response.Header.Get("Content-Type") != "application/x-ndjson" {
		t.Fatalf("events response = %d %q", response.StatusCode,
			response.Header.Get("Content-Type"))
	}

	if _, _, err := srv.control.CreateTerminal(
		context.Background(), "Event", t.TempDir(), control.SelectionNone,
	); err != nil {
		t.Fatalf("CreateTerminal() error = %v", err)
	}
	record := make(chan control.Event, 1)
	scanError := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(response.Body)
		if !scanner.Scan() {
			scanError <- scanner.Err()
			return
		}
		var event control.Event
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			scanError <- err
			return
		}
		record <- event
	}()
	select {
	case event := <-record:
		if event.Type != "terminal.created" || event.Sequence == 0 {
			t.Fatalf("event = %#v", event)
		}
	case err := <-scanError:
		t.Fatalf("scan event: %v", err)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for terminal.created")
	}
}
