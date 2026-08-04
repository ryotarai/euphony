package server

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/ryotarai/euphony/internal/session"
)

var prefixPattern = regexp.MustCompile(`(?i)^(?:(?:ctrl|alt|shift|meta)\+)+(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$`)

func (s *Server) getSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.sessions.Settings())
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Prefix                    string   `json:"prefix"`
		PaneTabShortcut           string   `json:"paneTabShortcut"`
		SidebarWidth              float64  `json:"sidebarWidth"`
		SidebarCollapsed          bool     `json:"sidebarCollapsed"`
		InterfaceFontSize         float64  `json:"interfaceFontSize"`
		TerminalFontSize          float64  `json:"terminalFontSize"`
		TerminalFontFamily        string   `json:"terminalFontFamily"`
		AgentLogFontSize          float64  `json:"agentLogFontSize"`
		TerminalHistoryLimit      *float64 `json:"terminalHistoryLimit"`
		TerminalLineHeight        float64  `json:"terminalLineHeight"`
		TerminalCursorStyle       string   `json:"terminalCursorStyle"`
		TerminalCursorBlink       *bool    `json:"terminalCursorBlink"`
		TerminalScrollSensitivity float64  `json:"terminalScrollSensitivity"`
		TerminalOptionAsAlt       *bool    `json:"terminalOptionAsAlt"`
		AgentSummaryProvider      string   `json:"agentSummaryProvider"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	decodeErr := decoder.Decode(&input)
	terminalFontFamily := strings.TrimSpace(input.TerminalFontFamily)
	if input.AgentSummaryProvider == "" {
		input.AgentSummaryProvider = s.sessions.Settings().AgentSummaryProvider
		if input.AgentSummaryProvider == "" {
			input.AgentSummaryProvider = session.DefaultAgentSummaryProvider
		}
	}
	if decodeErr != nil || ensureJSONEnd(decoder) != nil ||
		!prefixPattern.MatchString(input.Prefix) ||
		!prefixPattern.MatchString(input.PaneTabShortcut) ||
		shortcutsEqual(input.Prefix, input.PaneTabShortcut) ||
		math.IsNaN(input.SidebarWidth) || math.IsInf(input.SidebarWidth, 0) ||
		input.SidebarWidth < 180 || input.SidebarWidth > 600 ||
		!validFontSize(input.InterfaceFontSize) ||
		!validFontSize(input.TerminalFontSize) ||
		!validFontSize(input.AgentLogFontSize) ||
		terminalFontFamily == "" || utf8.RuneCountInString(terminalFontFamily) > 256 ||
		!validTerminalHistoryLimit(input.TerminalHistoryLimit) ||
		!validTerminalLineHeight(input.TerminalLineHeight) ||
		!validTerminalCursorStyle(input.TerminalCursorStyle) ||
		input.TerminalCursorBlink == nil ||
		!validTerminalScrollSensitivity(input.TerminalScrollSensitivity) ||
		input.TerminalOptionAsAlt == nil ||
		!validAgentSummaryProvider(input.AgentSummaryProvider) {
		writeError(w, http.StatusBadRequest, "invalid_settings", "Provide valid Euphony settings.")
		return
	}
	settings := session.Settings{
		Prefix:                    input.Prefix,
		PaneTabShortcut:           input.PaneTabShortcut,
		SidebarWidth:              int(math.Round(input.SidebarWidth)),
		SidebarCollapsed:          input.SidebarCollapsed,
		InterfaceFontSize:         int(input.InterfaceFontSize),
		TerminalFontSize:          int(input.TerminalFontSize),
		TerminalFontFamily:        terminalFontFamily,
		AgentLogFontSize:          int(input.AgentLogFontSize),
		TerminalHistoryLimit:      int(*input.TerminalHistoryLimit),
		TerminalLineHeight:        input.TerminalLineHeight,
		TerminalCursorStyle:       input.TerminalCursorStyle,
		TerminalCursorBlink:       *input.TerminalCursorBlink,
		TerminalScrollSensitivity: int(input.TerminalScrollSensitivity),
		TerminalOptionAsAlt:       *input.TerminalOptionAsAlt,
		AgentSummaryProvider:      input.AgentSummaryProvider,
	}
	if err := s.sessions.UpdateSettings(r.Context(), settings); err != nil {
		writeError(w, http.StatusInternalServerError, "settings_save_failed", "The settings could not be saved.")
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func validTerminalHistoryLimit(value *float64) bool {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) || math.Trunc(*value) != *value {
		return false
	}
	return *value == 0 ||
		(*value >= session.MinTerminalHistoryLimit &&
			*value <= session.MaxTerminalHistoryLimit &&
			math.Mod(*value, session.MinTerminalHistoryLimit) == 0)
}

func validFontSize(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) &&
		value >= 10 && value <= 24 && math.Trunc(value) == value
}

func validTerminalLineHeight(value float64) bool {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 1 || value > 2 {
		return false
	}
	scaled := value * 20
	return math.Abs(scaled-math.Round(scaled)) < 1e-9
}

func validTerminalCursorStyle(value string) bool {
	return value == "bar" || value == "block" || value == "underline"
}

func validTerminalScrollSensitivity(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) &&
		math.Trunc(value) == value && value >= 1 && value <= 5
}

func validAgentSummaryProvider(value string) bool {
	return value == "claude" || value == "codex"
}

func shortcutsEqual(left, right string) bool {
	identity := func(value string) string {
		parts := strings.Split(strings.ToLower(value), "+")
		key := parts[len(parts)-1]
		present := make(map[string]bool, len(parts)-1)
		for _, modifier := range parts[:len(parts)-1] {
			present[modifier] = true
		}
		modifiers := make([]string, 0, len(present))
		for _, modifier := range []string{"ctrl", "alt", "shift", "meta"} {
			if present[modifier] {
				modifiers = append(modifiers, modifier)
			}
		}
		return strings.Join(modifiers, "+") + "+" + key
	}
	return identity(left) == identity(right)
}
