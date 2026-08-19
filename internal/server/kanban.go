package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/ryotarai/euphony/internal/project"
	"github.com/ryotarai/euphony/internal/session"
)

type kanbanArchiveRequest struct {
	Archived *bool `json:"archived"`
}

func (s *Server) listKanbanSessions(w http.ResponseWriter, r *http.Request) {
	items, err := s.kanbanSessions(r.Context(), false)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "kanban_sessions_list_failed",
			"The Kanban sessions could not be loaded.")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) listKanbanArchives(w http.ResponseWriter, r *http.Request) {
	items, err := s.kanbanSessions(r.Context(), true)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "kanban_archives_list_failed",
			"The Kanban archive records could not be loaded.")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) kanbanSessions(ctx context.Context, archivedOnly bool) ([]allSession, error) {
	projects, err := s.projects.List(ctx)
	if err != nil {
		return nil, err
	}
	projectsByID := make(map[string]project.Project, len(projects))
	for _, item := range projects {
		projectsByID[item.ID] = item
	}
	summaries := make(map[string]session.AgentSummary)
	for _, item := range s.sessions.AgentSummaries() {
		if item.Done {
			continue
		}
		summaries[item.TerminalID] = item
	}
	metadata := s.sessions.List()
	if archivedOnly {
		metadata = s.sessions.ListPersisted()
	}
	items := make([]allSession, 0, len(metadata))
	for _, item := range metadata {
		if !archivedOnly && item.State != session.StateStarting && item.State != session.StateRunning {
			continue
		}
		if item.Archived != archivedOnly {
			continue
		}
		kanbanItem := allSessionFromMetadata(item, projectsByID, summaries[item.ID])
		if kanbanItem.Agent == "" || kanbanItem.SessionID == "" {
			continue
		}
		items = append(items, kanbanItem)
	}
	sort.SliceStable(items, func(i, j int) bool {
		if !items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
			return items[i].UpdatedAt.After(items[j].UpdatedAt)
		}
		return items[i].ID < items[j].ID
	})
	return items, nil
}

func (s *Server) updateKanbanArchive(w http.ResponseWriter, r *http.Request) {
	var request kanbanArchiveRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Provide archived as a boolean.")
		return
	}
	if err := ensureJSONEnd(decoder); err != nil || request.Archived == nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Provide archived as a boolean.")
		return
	}
	terminalID := strings.TrimSpace(r.PathValue("terminalID"))
	sessionID := strings.TrimSpace(r.PathValue("sessionID"))
	metadata, err := s.sessions.SetAgentSessionArchived(terminalID, sessionID, *request.Archived)
	if err != nil {
		if errors.Is(err, session.ErrNotFound) {
			writeError(w, http.StatusNotFound, "session_not_found",
				"The terminal and agent session identity does not exist.")
			return
		}
		if errors.Is(err, session.ErrManagerClosing) {
			writeError(w, http.StatusServiceUnavailable, "session_manager_closing",
				"The session manager is closing.")
			return
		}
		writeError(w, http.StatusInternalServerError, "archive_update_failed",
			"The session archive state could not be saved.")
		return
	}
	item, err := s.allSessionForMetadata(r.Context(), metadata)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "archive_update_failed",
			"The session archive state could not be loaded.")
		return
	}
	if item.Agent == "" || item.SessionID == "" {
		writeError(w, http.StatusNotFound, "session_not_found",
			"The terminal and agent session identity does not exist.")
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) allSessionForMetadata(ctx context.Context, metadata session.Metadata) (allSession, error) {
	projects, err := s.projects.List(ctx)
	if err != nil {
		return allSession{}, err
	}
	projectsByID := make(map[string]project.Project, len(projects))
	for _, item := range projects {
		projectsByID[item.ID] = item
	}
	summaries := make(map[string]session.AgentSummary)
	for _, item := range s.sessions.AgentSummaries() {
		if item.Done {
			continue
		}
		summaries[item.TerminalID] = item
	}
	return allSessionFromMetadata(metadata, projectsByID, summaries[metadata.ID]), nil
}
