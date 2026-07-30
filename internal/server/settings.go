package server

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"regexp"

	"github.com/ryotarai/euphony/internal/session"
)

var prefixPattern = regexp.MustCompile(`(?i)^(?:(?:ctrl|alt|shift|meta)\+)+(?:[a-z0-9]|f(?:[1-9]|1[0-2]))$`)

func (s *Server) getSettings(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.sessions.Settings())
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Prefix           string  `json:"prefix"`
		PaneTabShortcut  string  `json:"paneTabShortcut"`
		SidebarWidth     float64 `json:"sidebarWidth"`
		SidebarCollapsed bool    `json:"sidebarCollapsed"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || ensureJSONEnd(decoder) != nil ||
		!prefixPattern.MatchString(input.Prefix) ||
		!prefixPattern.MatchString(input.PaneTabShortcut) ||
		math.IsNaN(input.SidebarWidth) || math.IsInf(input.SidebarWidth, 0) ||
		input.SidebarWidth < 180 || input.SidebarWidth > 600 {
		writeError(w, http.StatusBadRequest, "invalid_settings", "Provide valid Euphony settings.")
		return
	}
	settings := session.Settings{
		Prefix:           input.Prefix,
		PaneTabShortcut:  input.PaneTabShortcut,
		SidebarWidth:     int(math.Round(input.SidebarWidth)),
		SidebarCollapsed: input.SidebarCollapsed,
	}
	if err := s.sessions.UpdateSettings(r.Context(), settings); err != nil {
		writeError(w, http.StatusInternalServerError, "settings_save_failed", "The settings could not be saved.")
		return
	}
	writeJSON(w, http.StatusOK, settings)
}
