package server

import (
	"net/http"
	"path/filepath"
	"strings"
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
	response = performRequest(t, srv, http.MethodGet, "/api/settings", "")
	var defaultJSON map[string]any
	decodeResponse(t, response, &defaultJSON)
	if _, ok := defaultJSON["autoSelectAttention"]; ok {
		t.Fatal("GET /api/settings includes removed autoSelectAttention setting")
	}
	if _, ok := defaultJSON["autoDeselectRunning"]; ok {
		t.Fatal("GET /api/settings includes removed autoDeselectRunning setting")
	}
	if defaults.Prefix != "Ctrl+B" || defaults.PaneTabShortcut != "Meta+L" ||
		defaults.SidebarWidth != 304 || defaults.InterfaceFontSize != 16 ||
		defaults.TerminalFontSize != 14 || defaults.AgentLogFontSize != 14 ||
		defaults.TerminalFontFamily != session.DefaultTerminalFontFamily ||
		defaults.TerminalHistoryLimit != 1048576 ||
		defaults.TerminalLineHeight != 1.25 || defaults.TerminalCursorStyle != "bar" ||
		defaults.TerminalCursorBlink || defaults.TerminalScrollSensitivity != 3 ||
		!defaults.TerminalOptionAsAlt {
		t.Fatalf("default settings = %#v", defaults)
	}

	response = performRequest(t, srv, http.MethodPatch, "/api/settings",
		`{"prefix":"Ctrl+A","paneTabShortcut":"Ctrl+J","sidebarWidth":420,"sidebarCollapsed":true,"interfaceFontSize":18,"terminalFontSize":17,"terminalFontFamily":"  JetBrains Mono, monospace  ","agentLogFontSize":16,"terminalHistoryLimit":0,"terminalLineHeight":1.5,"terminalCursorStyle":"underline","terminalCursorBlink":true,"terminalScrollSensitivity":5,"terminalOptionAsAlt":false}`)
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH /api/settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var updated session.Settings
	decodeResponse(t, response, &updated)
	if updated != (session.Settings{
		Prefix: "Ctrl+A", PaneTabShortcut: "Ctrl+J",
		SidebarWidth: 420, SidebarCollapsed: true,
		InterfaceFontSize: 18, TerminalFontSize: 17, AgentLogFontSize: 16,
		TerminalFontFamily:   "JetBrains Mono, monospace",
		TerminalHistoryLimit: 0,
		TerminalLineHeight:   1.5, TerminalCursorStyle: "underline",
		TerminalCursorBlink: true, TerminalScrollSensitivity: 5, TerminalOptionAsAlt: false,
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
		`{"prefix":"","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+Shift+J","paneTabShortcut":"Shift+Ctrl+J","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+J","paneTabShortcut":"Ctrl+Ctrl+J","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":100,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":700,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":9,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":25,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":14.5,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":9,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":25,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14.5,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":9,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":25,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14.5,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1.5}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":-1}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048575}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048577}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":4293918721}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"   ","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"` + strings.Repeat("界", 257) + `","agentLogFontSize":14,"terminalHistoryLimit":1048576}`,
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576,"terminalLineHeight":1.25,"terminalCursorStyle":"bar","terminalCursorBlink":false,"terminalScrollSensitivity":3}`,
	} {
		response := performRequest(t, srv, http.MethodPatch, "/api/settings", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("PATCH body %s status = %d, want 400", body, response.Code)
		}
	}

	validBody := `{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576,"terminalLineHeight":1.25,"terminalCursorStyle":"bar","terminalCursorBlink":false,"terminalScrollSensitivity":3,"terminalOptionAsAlt":true}`
	for _, body := range []string{
		strings.Replace(validBody, `"terminalLineHeight":1.25`, `"terminalLineHeight":0.95`, 1),
		strings.Replace(validBody, `"terminalLineHeight":1.25`, `"terminalLineHeight":2.05`, 1),
		strings.Replace(validBody, `"terminalLineHeight":1.25`, `"terminalLineHeight":1.01`, 1),
		strings.Replace(validBody, `"terminalCursorStyle":"bar"`, `"terminalCursorStyle":"dot"`, 1),
		strings.Replace(validBody, `"terminalCursorStyle":"bar"`, `"terminalCursorStyle":""`, 1),
		strings.Replace(validBody, `"terminalCursorBlink":false`, `"terminalCursorBlink":"yes"`, 1),
		strings.Replace(validBody, `"terminalScrollSensitivity":3`, `"terminalScrollSensitivity":0`, 1),
		strings.Replace(validBody, `"terminalScrollSensitivity":3`, `"terminalScrollSensitivity":6`, 1),
		strings.Replace(validBody, `"terminalScrollSensitivity":3`, `"terminalScrollSensitivity":3.5`, 1),
		strings.Replace(validBody, `,"terminalLineHeight":1.25`, "", 1),
		strings.Replace(validBody, `,"terminalCursorStyle":"bar"`, "", 1),
		strings.Replace(validBody, `,"terminalCursorBlink":false`, "", 1),
		strings.Replace(validBody, `,"terminalScrollSensitivity":3`, "", 1),
		strings.Replace(validBody, `,"terminalOptionAsAlt":true`, "", 1),
	} {
		response := performRequest(t, srv, http.MethodPatch, "/api/settings", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("terminal appearance body %s status = %d, want 400", body, response.Code)
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
		`{"prefix":"Ctrl+Q","paneTabShortcut":"Meta+L","sidebarWidth":229.96875,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":8388608,"terminalLineHeight":1.25,"terminalCursorStyle":"bar","terminalCursorBlink":false,"terminalScrollSensitivity":3,"terminalOptionAsAlt":true}`)
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
