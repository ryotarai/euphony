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
	if _, ok := defaultJSON["codingAgent"]; !ok {
		t.Fatal("GET /api/settings omits codingAgent setting")
	}
	if defaults.Prefix != "Ctrl+B" || defaults.PaneTabShortcut != "Meta+L" || defaults.KanbanShortcut != "Meta+Alt+K" ||
		defaults.SidebarWidth != 304 || defaults.InterfaceFontSize != 16 ||
		defaults.TerminalFontSize != 14 || defaults.AgentLogFontSize != 14 ||
		defaults.TerminalFontFamily != session.DefaultTerminalFontFamily ||
		defaults.TerminalHistoryLimit != 1048576 ||
		defaults.TerminalLineHeight != 1.25 || defaults.TerminalCursorStyle != "bar" ||
		defaults.TerminalCursorBlink || defaults.TerminalScrollSensitivity != 3 ||
		!defaults.TerminalOptionAsAlt || defaults.CodingAgent != session.DefaultCodingAgent ||
		defaults.AgentSummaryOpenAIEffort != "low" {
		t.Fatalf("default settings = %#v", defaults)
	}

	response = performRequest(t, srv, http.MethodPatch, "/api/settings",
		`{"prefix":"Ctrl+A","paneTabShortcut":"Ctrl+J","kanbanShortcut":"Ctrl+Alt+K","sidebarWidth":420,"sidebarCollapsed":true,"interfaceFontSize":18,"terminalFontSize":17,"terminalFontFamily":"  JetBrains Mono, monospace  ","agentLogFontSize":16,"terminalHistoryLimit":0,"terminalLineHeight":1.5,"terminalCursorStyle":"underline","terminalCursorBlink":true,"terminalScrollSensitivity":5,"terminalOptionAsAlt":false,"agentSummaryProvider":"codex"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH /api/settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var updated session.Settings
	decodeResponse(t, response, &updated)
	if updated != (session.Settings{
		Prefix: "Ctrl+A", PaneTabShortcut: "Ctrl+J", KanbanShortcut: "Ctrl+Alt+K",
		SidebarWidth: 420, SidebarCollapsed: true,
		InterfaceFontSize: 18, TerminalFontSize: 17, AgentLogFontSize: 16,
		TerminalFontFamily:   "JetBrains Mono, monospace",
		TerminalHistoryLimit: 0,
		TerminalLineHeight:   1.5, TerminalCursorStyle: "underline",
		TerminalCursorBlink: true, TerminalScrollSensitivity: 5, TerminalOptionAsAlt: false,
		CodingAgent: "codex", AgentSummaryProvider: "codex", AgentSummaryPrompt: "",
		AgentSummaryOpenAIEffort: "low",
	}) {
		t.Fatalf("updated settings = %#v", updated)
	}
}

func TestSettingsAPIConfiguresCodingAgent(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		DatabasePath: filepath.Join(t.TempDir(), "euphony.sqlite3"),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	response := performRequest(t, srv, http.MethodPatch, "/api/settings",
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576,"terminalLineHeight":1.25,"terminalCursorStyle":"bar","terminalCursorBlink":false,"terminalScrollSensitivity":3,"terminalOptionAsAlt":true,"codingAgent":"claude"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH /api/settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var updated map[string]any
	decodeResponse(t, response, &updated)
	if updated["codingAgent"] != "claude" {
		t.Fatalf("codingAgent = %#v, want claude", updated["codingAgent"])
	}

	response = performRequest(t, srv, http.MethodGet, "/api/settings", "")
	var reloaded map[string]any
	decodeResponse(t, response, &reloaded)
	if reloaded["codingAgent"] != "claude" {
		t.Fatalf("reloaded codingAgent = %#v, want claude", reloaded["codingAgent"])
	}
}

func TestSettingsAPIValidatesAndPersistsOpenAIProviderAndEffort(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		DatabasePath: filepath.Join(t.TempDir(), "euphony.sqlite3"),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	body := `{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576,"terminalLineHeight":1.25,"terminalCursorStyle":"bar","terminalCursorBlink":false,"terminalScrollSensitivity":3,"terminalOptionAsAlt":true,"agentSummaryProvider":"openai","agentSummaryOpenAIEffort":"max"}`
	response := performRequest(t, srv, http.MethodPatch, "/api/settings", body)
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH OpenAI settings status = %d, body = %s", response.Code, response.Body.String())
	}
	var saved session.Settings
	decodeResponse(t, response, &saved)
	if saved.AgentSummaryProvider != "openai" || saved.AgentSummaryOpenAIEffort != "max" {
		t.Fatalf("saved OpenAI settings = %#v", saved)
	}
	response = performRequest(t, srv, http.MethodGet, "/api/settings", "")
	var reloaded session.Settings
	decodeResponse(t, response, &reloaded)
	if reloaded.AgentSummaryProvider != "openai" || reloaded.AgentSummaryOpenAIEffort != "max" {
		t.Fatalf("reloaded OpenAI settings = %#v", reloaded)
	}

	for _, effort := range []string{"", "minimal", "ultra"} {
		invalid := strings.Replace(body, `"agentSummaryOpenAIEffort":"max"`, `"agentSummaryOpenAIEffort":"`+effort+`"`, 1)
		response = performRequest(t, srv, http.MethodPatch, "/api/settings", invalid)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("effort %q status = %d, want 400", effort, response.Code)
		}
	}
	invalid := strings.Replace(body, `"agentSummaryProvider":"openai"`, `"agentSummaryProvider":"ollama"`, 1)
	response = performRequest(t, srv, http.MethodPatch, "/api/settings", invalid)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid provider status = %d, want 400", response.Code)
	}
	invalid = strings.Replace(body, `"agentSummaryProvider":"openai"`, `"agentSummaryProvider":""`, 1)
	response = performRequest(t, srv, http.MethodPatch, "/api/settings", invalid)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("explicit empty provider status = %d, want 400", response.Code)
	}
	omittedProvider := strings.Replace(body, `,"agentSummaryProvider":"openai"`, "", 1)
	response = performRequest(t, srv, http.MethodPatch, "/api/settings", omittedProvider)
	if response.Code != http.StatusOK {
		t.Fatalf("omitted provider status = %d, want 200", response.Code)
	}
}

func TestSettingsAPIPreservesOmittedSummaryPrompt(t *testing.T) {
	srv, err := New(Config{
		Token: "token", Shell: "/bin/sh",
		DatabasePath: filepath.Join(t.TempDir(), "euphony.sqlite3"),
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	const prompt = "Keep the summary focused.\nCall out blockers and next steps."
	response := performRequest(t, srv, http.MethodPatch, "/api/settings",
		`{"prefix":"Ctrl+A","paneTabShortcut":"Ctrl+J","sidebarWidth":420,"sidebarCollapsed":true,"interfaceFontSize":18,"terminalFontSize":17,"terminalFontFamily":"  JetBrains Mono, monospace  ","agentLogFontSize":16,"terminalHistoryLimit":0,"terminalLineHeight":1.5,"terminalCursorStyle":"underline","terminalCursorBlink":true,"terminalScrollSensitivity":5,"terminalOptionAsAlt":false,"agentSummaryProvider":"codex","agentSummaryPrompt":"Keep the summary focused.\nCall out blockers and next steps."}`)
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH /api/settings with prompt status = %d, body = %s", response.Code, response.Body.String())
	}
	var saved session.Settings
	decodeResponse(t, response, &saved)
	if saved.AgentSummaryPrompt != prompt {
		t.Fatalf("saved prompt = %q, want %q", saved.AgentSummaryPrompt, prompt)
	}

	response = performRequest(t, srv, http.MethodPatch, "/api/settings",
		`{"prefix":"Ctrl+A","paneTabShortcut":"Ctrl+J","sidebarWidth":420,"sidebarCollapsed":true,"interfaceFontSize":18,"terminalFontSize":17,"terminalFontFamily":"  JetBrains Mono, monospace  ","agentLogFontSize":16,"terminalHistoryLimit":0,"terminalLineHeight":1.5,"terminalCursorStyle":"underline","terminalCursorBlink":true,"terminalScrollSensitivity":5,"terminalOptionAsAlt":false,"agentSummaryProvider":"codex"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("PATCH /api/settings without prompt status = %d, body = %s", response.Code, response.Body.String())
	}
	var preserved session.Settings
	decodeResponse(t, response, &preserved)
	if preserved.AgentSummaryPrompt != prompt {
		t.Fatalf("preserved prompt = %q, want %q", preserved.AgentSummaryPrompt, prompt)
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
		`{"prefix":"Ctrl+B","paneTabShortcut":"Meta+L","sidebarWidth":304,"sidebarCollapsed":false,"interfaceFontSize":16,"terminalFontSize":14,"terminalFontFamily":"Menlo, monospace","agentLogFontSize":14,"terminalHistoryLimit":1048576,"terminalLineHeight":1.25,"terminalCursorStyle":"bar","terminalCursorBlink":false,"terminalScrollSensitivity":3,"agentSummaryProvider":"ollama"}`,
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

	overlongPromptBody := strings.Replace(validBody,
		`"terminalOptionAsAlt":true}`,
		`"terminalOptionAsAlt":true,"agentSummaryPrompt":"`+strings.Repeat("x", 8001)+`"}`,
		1)
	response := performRequest(t, srv, http.MethodPatch, "/api/settings", overlongPromptBody)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("overlong summary prompt status = %d, want 400", response.Code)
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
