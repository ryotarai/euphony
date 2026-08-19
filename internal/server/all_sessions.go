package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/project"
	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

const (
	allSessionOpen   = "open"
	allSessionResume = "resume"
)

type allSession struct {
	ID         string    `json:"id"`
	TerminalID string    `json:"terminalId,omitempty"`
	Agent      string    `json:"agent,omitempty"`
	SessionID  string    `json:"sessionId,omitempty"`
	Title      string    `json:"title"`
	Purpose    string    `json:"purpose,omitempty"`
	Summary    string    `json:"summary,omitempty"`
	Status     string    `json:"status,omitempty"`
	Archived   bool      `json:"archived"`
	CWD        string    `json:"cwd"`
	Project    string    `json:"project,omitempty"`
	UpdatedAt  time.Time `json:"updatedAt"`
	State      string    `json:"state"`
}

type allSessionsResumeRequest struct {
	SelectionMode control.SelectionMode `json:"selectionMode"`
}

func (s *Server) listAllSessions(w http.ResponseWriter, r *http.Request) {
	items, err := s.allSessions(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "all_sessions_list_failed",
			"The saved sessions could not be loaded.")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) allSessions(ctx context.Context) ([]allSession, error) {
	stored := s.sessions.ListPersisted()
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
		summaries[item.TerminalID] = item
	}

	byKey := make(map[string]allSession, len(stored))
	for _, metadata := range stored {
		item := allSessionFromMetadata(metadata, projectsByID, summaries[metadata.ID])
		if item.Agent == "" || item.SessionID == "" {
			continue
		}
		key := allSessionAgentKey(item.Agent, item.SessionID)
		previous, ok := byKey[key]
		if !ok || preferAllSession(item, previous) {
			byKey[key] = item
		}
	}
	items := make([]allSession, 0, len(byKey))
	for _, item := range byKey {
		items = append(items, item)
	}
	sort.SliceStable(items, func(i, j int) bool {
		if !items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
			return items[i].UpdatedAt.After(items[j].UpdatedAt)
		}
		return items[i].ID < items[j].ID
	})
	return items, nil
}

func allSessionFromMetadata(
	metadata session.Metadata,
	projects map[string]project.Project,
	summary session.AgentSummary,
) allSession {
	agent := metadata.Agent
	if agent == "" {
		agent = metadata.ResumeAgent
	}
	if agent != "codex" && agent != "claude" {
		return allSession{}
	}
	state := allSessionResume
	terminalID := ""
	if metadata.State == session.StateStarting || metadata.State == session.StateRunning {
		state = allSessionOpen
		terminalID = metadata.ID
	}
	item := allSession{
		ID:         metadata.ID,
		TerminalID: terminalID,
		Agent:      agent,
		SessionID:  metadata.AgentSessionID,
		Title:      metadata.Name,
		Status:     metadata.AgentStatus,
		Archived:   metadata.Archived,
		CWD:        metadata.CWD,
		UpdatedAt:  metadata.UpdatedAt,
		State:      state,
	}
	if metadata.AgentTitle != "" {
		item.Title = metadata.AgentTitle
	}
	if metadata.RepoRoot != "" {
		item.Project = metadata.RepoRoot
	}
	if metadata.ProjectID != "" {
		if project, ok := projects[metadata.ProjectID]; ok {
			item.Project = project.Path
		}
	}
	if summary.TerminalID != "" {
		item.Purpose = summary.Purpose
		item.Summary = summary.Summary
		if item.Status == "" {
			item.Status = summary.Status
		}
		if summary.GeneratedAt.After(item.UpdatedAt) {
			item.UpdatedAt = summary.GeneratedAt
		}
	}
	return item
}

func allSessionAgentKey(agent, sessionID string) string {
	return agent + "\x00" + sessionID
}

func preferAllSession(candidate, previous allSession) bool {
	if candidate.State == allSessionOpen && previous.State != allSessionOpen {
		return true
	}
	if candidate.State != allSessionOpen && previous.State == allSessionOpen {
		return false
	}
	if !candidate.UpdatedAt.Equal(previous.UpdatedAt) {
		return candidate.UpdatedAt.After(previous.UpdatedAt)
	}
	return candidate.ID < previous.ID
}

func (s *Server) resumeAllSession(w http.ResponseWriter, r *http.Request) {
	agent := r.PathValue("agent")
	if agent != "codex" && agent != "claude" {
		writeError(w, http.StatusBadRequest, "invalid_agent", "The agent must be codex or claude.")
		return
	}
	selectionMode, err := decodeAllSessionsSelectionMode(r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", "Provide a valid selection mode.")
		return
	}
	sessionID := r.PathValue("sessionID")
	if sessionID == "" {
		writeError(w, http.StatusBadRequest, "invalid_session", "The agent session ID is required.")
		return
	}

	var saved *session.Metadata
	queryOnly := false
	for _, metadata := range s.sessions.ListPersisted() {
		metadataAgent := metadata.Agent
		if metadataAgent == "" {
			metadataAgent = metadata.ResumeAgent
		}
		if metadata.AgentSessionID != sessionID || metadataAgent != agent {
			continue
		}
		if metadata.State == session.StateStarting || metadata.State == session.StateRunning {
			selectionSnapshot, err := s.selectResumedTerminal(r.Context(), metadata.ID, selectionMode)
			if err != nil {
				writeError(w, http.StatusInternalServerError, "selection_update_failed",
					"The terminal selection could not be updated.")
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"terminal":  metadata,
				"selection": selectionSnapshot,
			})
			return
		}
		if saved == nil || metadata.UpdatedAt.After(saved.UpdatedAt) {
			copy := metadata
			saved = &copy
		}
	}
	if saved == nil {
		requestedCWD := strings.TrimSpace(r.URL.Query().Get("cwd"))
		if requestedCWD == "" {
			writeError(w, http.StatusNotFound, "session_history_not_found",
				"The saved agent session no longer exists.")
			return
		}
		queryOnly = true
		saved = &session.Metadata{
			Agent:          agent,
			ResumeAgent:    agent,
			AgentSessionID: sessionID,
			CWD:            requestedCWD,
		}
	}
	name := truncateAllSessionName(saved.AgentTitle)
	if name == "" {
		name = truncateAllSessionName(saved.Name)
	}
	if name == "" {
		name = strings.ToUpper(agent[:1]) + agent[1:] + " session"
	}
	command := agent
	args := []string{"resume", sessionID}
	if agent == "claude" {
		args = []string{"--resume", sessionID}
	}
	var cwd string
	if queryOnly {
		cwd, err = queryResumeWorkingDirectory(saved.CWD)
	} else {
		cwd, err = resumeWorkingDirectory(saved.CWD)
	}
	if err != nil {
		if queryOnly {
			writeError(w, http.StatusBadRequest, "invalid_cwd", "The query working directory must exist.")
			return
		}
		writeError(w, http.StatusInternalServerError, "resume_failed",
			"The working directory for the agent session could not be resolved.")
		return
	}
	metadata, selectionSnapshot, err := s.control.CreateTerminalWithCommandArgs(
		r.Context(), name, cwd, selectionMode, command, args...,
	)
	if err != nil {
		if strings.Contains(err.Error(), "working directory") {
			writeError(w, http.StatusBadRequest, "invalid_cwd", "The saved working directory no longer exists.")
			return
		}
		writeError(w, http.StatusInternalServerError, "resume_failed",
			"The agent session could not be resumed.")
		return
	}
	if queryOnly {
		metadata, err = s.sessions.UpdateAgent(metadata.ID, session.AgentUpdate{
			Agent:          agent,
			ResumeAgent:    agent,
			AgentSessionID: sessionID,
		})
		if err != nil {
			_, _ = s.control.DeleteTerminal(metadata.ID)
			writeError(w, http.StatusInternalServerError, "resume_failed",
				"The agent session could not be resumed.")
			return
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"terminal":  metadata,
		"selection": selectionSnapshot,
	})
}

func resumeWorkingDirectory(requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested != "" {
		if info, err := os.Stat(requested); err == nil && info.IsDir() {
			return requested, nil
		}
	}
	return os.UserHomeDir()
}

func queryResumeWorkingDirectory(requested string) (string, error) {
	requested = strings.TrimSpace(requested)
	if requested == "" {
		return "", errors.New("working directory is required")
	}
	info, err := os.Stat(requested)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("working directory is not a directory")
	}
	return requested, nil
}

func decodeAllSessionsSelectionMode(r *http.Request) (control.SelectionMode, error) {
	selectionMode := control.SelectionReplace
	if r.Body == nil {
		return selectionMode, nil
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	var request allSessionsResumeRequest
	if err := decoder.Decode(&request); err != nil {
		if errors.Is(err, io.EOF) {
			return selectionMode, nil
		}
		return "", err
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return "", err
	}
	if request.SelectionMode != "" {
		selectionMode = request.SelectionMode
	}
	switch selectionMode {
	case control.SelectionNone, control.SelectionAdd, control.SelectionReplace:
		return selectionMode, nil
	default:
		return "", errors.New("invalid selection mode")
	}
}

func (s *Server) selectResumedTerminal(
	ctx context.Context, terminalID string, mode control.SelectionMode,
) (selection.Snapshot, error) {
	if mode == control.SelectionNone {
		return s.control.Selection(), nil
	}
	actionType := selection.ActionAdd
	if mode == control.SelectionReplace {
		actionType = selection.ActionReplace
	}
	return s.control.ApplySelection(ctx, selection.Action{
		Type:              actionType,
		TerminalIDs:       []string{terminalID},
		FocusedTerminalID: terminalID,
	})
}

func truncateAllSessionName(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if len(value) <= 80 {
		return value
	}
	limit := 80
	for limit > 0 && !utf8.RuneStart(value[limit]) {
		limit--
	}
	return strings.TrimSpace(value[:limit])
}
