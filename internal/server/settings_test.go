package server

import (
	"net/http"
	"path/filepath"
	"testing"

	"github.com/ryotarai/euphony/internal/session"
)

func TestSettingsAPIReadsAndPersistsSettings(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		DatabasePath: filepath.Join(t.TempDir(), "euphony.sqlite3"),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	response := performRequest(t, srv, http.MethodGet, "/api/settings", "")
	if response.Code != http.StatusOK {
		t.Fatalf("GET /api/settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var defaults session.Settings
	decodeResponse(t, response, &defaults)
	if defaults.Prefix != "Ctrl+B" || defaults.PaneTabShortcut != "Meta+L" ||
		defaults.SidebarWidth != 304 || defaults.TerminalHistoryLimit != 1048576 {
		t.Fatalf("default settings = %#v", defaults)
	}

	response = performRequest(t, srv, http.MethodPatch, "/api/settings",
		`{"prefix":"Ctrl+A","paneTabShortcut":"Ctrl+J","sidebarWidth":420,"sidebarCollapsed":true,"terminalHistoryLimit":0}`)
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH /api/settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var updated session.Settings
	decodeResponse(t, response, &updated)
	if updated != (session.Settings{
		Prefix: "Ctrl+A", PaneTabShortcut: "Ctrl+J",
		SidebarWidth: 420, SidebarCollapsed: true, TerminalHistoryLimit: 0,
	}) {
		t.Fatalf("updated settings = %#v", updated)
	}
}

func TestSettingsAPIRejectsInvalidSettings(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		DatabasePath: filepath.Join(t.TempDir(), "euphony.sqlite3"),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	for _, body := range []string{
		`{"prefix":"","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"","sidebarWidth":304,"sidebarCollapsed":false,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"L","sidebarWidth":304,"sidebarCollapsed":false,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+Shift+J","paneTabShortcut":"Shift+Ctrl+J","sidebarWidth":304,"sidebarCollapsed":false,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+J","paneTabShortcut":"Ctrl+Ctrl+J","sidebarWidth":304,"sidebarCollapsed":false,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":100,"sidebarCollapsed":false,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":700,"sidebarCollapsed":false,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"terminalHistoryLimit":1.5}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"terminalHistoryLimit":-1}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"terminalHistoryLimit":1048575}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"terminalHistoryLimit":4293918721}`,
	} {
		response := performRequest(t, srv, http.MethodPatch, "/api/settings", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("PATCH body %s status = %d, want 400", body, response.Code)
		}
	}
}

func TestSettingsAPIRoundsFractionalSidebarWidth(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		DatabasePath: filepath.Join(t.TempDir(), "euphony.sqlite3"),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	response := performRequest(t, srv, http.MethodPatch, "/api/settings",
		`{"prefix":"Ctrl+Q","paneTabShortcut":"Meta+L","sidebarWidth":229.96875,"sidebarCollapsed":false,"terminalHistoryLimit":8388608}`)
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH /api/settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var updated session.Settings
	decodeResponse(t, response, &updated)
	if updated.SidebarWidth != 230 {
		t.Fatalf("sidebar width = %d, want 230", updated.SidebarWidth)
	}
	if updated.TerminalHistoryLimit != 8388608 {
		t.Fatalf("terminal history limit = %d, want 8388608", updated.TerminalHistoryLimit)
	}
}
