package server

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"regexp"
	"strings"

	"github.com/ryotarai/euphony/internal/session"
)

var prefixPattern = regexp.MustCompile(`(?i)^(?:(?:ctrl|alt|shift|meta)\+)+(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$`)

func (s *Server) getSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.sessions.Settings())
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Prefix            string  `json:"prefix"`
		PaneTabShortcut   string  `json:"paneTabShortcut"`
		SidebarWidth      float64 `json:"sidebarWidth"`
		SidebarCollapsed  bool    `json:"sidebarCollapsed"`
		InterfaceFontSize float64 `json:"interfaceFontSize"`
		TerminalFontSize  float64 `json:"terminalFontSize"`
		AgentLogFontSize  float64 `json:"agentLogFontSize"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || ensureJSONEnd(decoder) != nil ||
		!prefixPattern.MatchString(input.Prefix) ||
		!prefixPattern.MatchString(input.PaneTabShortcut) ||
		shortcutsEqual(input.Prefix, input.PaneTabShortcut) ||
		math.IsNaN(input.SidebarWidth) || math.IsInf(input.SidebarWidth, 0) ||
		input.SidebarWidth < 180 || input.SidebarWidth > 600 ||
		!validFontSize(input.InterfaceFontSize) ||
		!validFontSize(input.TerminalFontSize) ||
		!validFontSize(input.AgentLogFontSize) {
		writeError(w, http.StatusBadRequest, "invalid_settings", "Provide valid Euphony settings.")
		return
	}
	settings := session.Settings{
		Prefix:            input.Prefix,
		PaneTabShortcut:   input.PaneTabShortcut,
		SidebarWidth:      int(math.Round(input.SidebarWidth)),
		SidebarCollapsed:  input.SidebarCollapsed,
		InterfaceFontSize: int(input.InterfaceFontSize),
		TerminalFontSize:  int(input.TerminalFontSize),
		AgentLogFontSize:  int(input.AgentLogFontSize),
	}
	if err := s.sessions.UpdateSettings(r.Context(), settings); err != nil {
		writeError(w, http.StatusInternalServerError, "settings_save_failed", "The settings could not be saved.")
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func validFontSize(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) &&
		value >= 10 && value <= 24 && math.Trunc(value) == value
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
