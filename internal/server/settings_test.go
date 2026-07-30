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
		defaults.SidebarWidth != 304 || defaults.InterfaceFontSize != 16 ||
		defaults.TerminalFontSize != 14 || defaults.AgentLogFontSize != 14 ||
		defaults.TerminalHistoryLimit != 1048576 || !defaults.AutoSelectAttention {
		t.Fatalf("default settings = %#v", defaults)
	}

	response = performRequest(t, srv, http.MethodPatch, "/api/settings",
		`{"prefix":"Ctrl+A","paneTabShortcut":"Ctrl+J","sidebarWidth":420,"sidebarCollapsed":true,"interfaceFontSize":18,"terminalFontSize":17,"agentLogFontSize":16,"terminalHistoryLimit":0,"autoSelectAttention":false}`)
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH /api/settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var updated session.Settings
	decodeResponse(t, response, &updated)
	if updated != (session.Settings{
		Prefix: "Ctrl+A", PaneTabShortcut: "Ctrl+J",
		SidebarWidth: 420, SidebarCollapsed: true,
		InterfaceFontSize: 18, TerminalFontSize: 17, AgentLogFontSize: 16,
		TerminalHistoryLimit: 0, AutoSelectAttention: false,
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
		`{"prefix":"","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+Shift+J","paneTabShortcut":"Shift+Ctrl+J","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+J","paneTabShortcut":"Ctrl+Ctrl+J","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":100,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":700,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":9,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":25,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":14.5,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":9,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":25,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14.5,"agentLogFontSize":14,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":9,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":25,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14.5,"terminalHistoryLimit":1048576,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1.5,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":-1,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048575,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048577,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":4293918721,"autoSelectAttention":true}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
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
		`{"prefix":"Ctrl+Q","paneTabShortcut":"Meta+L","sidebarWidth":229.96875,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":8388608,"autoSelectAttention":true}`)
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
