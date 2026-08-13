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

	"github.com/ryotarai/euphony/internal/agentlog"
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
			"The session history could not be loaded.")
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) allSessions(ctx context.Context) ([]allSession, error) {
	current := s.sessions.List()
	history, err := s.agentLogs.DiscoverHistory()
	if err != nil {
		if len(current) == 0 {
			return nil, err
		}
		history = nil
	}
	projects, err := s.projects.List(ctx)
	if err != nil {
		return nil, err
	}
	projectsByID := make(map[string]project.Project, len(projects))
	for _, item := range projects {
		projectsByID[item.ID] = item
	}

	historyByKey := make(map[string]agentlog.HistorySession, len(history))
	for _, item := range history {
		historyByKey[allSessionAgentKey(item.Agent, item.SessionID)] = item
	}
	usedHistory := make(map[string]struct{}, len(history))
	summaries := make(map[string]session.AgentSummary)
	for _, item := range s.sessions.AgentSummaries() {
		summaries[item.TerminalID] = item
	}

	items := make([]allSession, 0, len(current)+len(history))
	for _, metadata := range current {
		item := allSessionFromCurrent(metadata, projectsByID, summaries[metadata.ID])
		if item.Agent != "" && item.SessionID != "" {
			key := allSessionAgentKey(item.Agent, item.SessionID)
			if saved, ok := historyByKey[key]; ok {
				item = mergeCurrentAllSession(item, saved)
				usedHistory[key] = struct{}{}
			}
		}
		items = append(items, item)
	}
	for _, saved := range history {
		key := allSessionAgentKey(saved.Agent, saved.SessionID)
		if _, ok := usedHistory[key]; ok {
			continue
		}
		items = append(items, allSessionFromHistory(saved))
	}
	sort.SliceStable(items, func(i, j int) bool {
		if !items[i].UpdatedAt.Equal(items[j].UpdatedAt) {
			return items[i].UpdatedAt.After(items[j].UpdatedAt)
		}
		return items[i].ID < items[j].ID
	})
	return items, nil
}

func allSessionFromCurrent(
	metadata session.Metadata,
	projects map[string]project.Project,
	summary session.AgentSummary,
) allSession {
	item := allSession{
		ID:         metadata.ID,
		TerminalID: metadata.ID,
		Title:      metadata.Name,
		CWD:        metadata.CWD,
		UpdatedAt:  metadata.UpdatedAt,
		State:      allSessionOpen,
	}
	agent := metadata.Agent
	if agent == "" {
		agent = metadata.ResumeAgent
	}
	if agent == "codex" || agent == "claude" {
		item.Agent = agent
		item.SessionID = metadata.AgentSessionID
	}
	if metadata.AgentTitle != "" {
		item.Title = metadata.AgentTitle
	}
	if item.Agent == "" && metadata.RepoRoot != "" {
		item.Project = metadata.RepoRoot
	}
	if item.Agent != "" && metadata.AgentSessionID == "" {
		item.Agent = ""
	}
	if metadata.ProjectID != "" {
		if project, ok := projects[metadata.ProjectID]; ok {
			item.Project = project.Path
		}
	}
	if summary.TerminalID != "" {
		item.Purpose = summary.Purpose
		item.Summary = summary.Summary
		if summary.GeneratedAt.After(item.UpdatedAt) {
			item.UpdatedAt = summary.GeneratedAt
		}
	}
	return item
}

func allSessionFromHistory(saved agentlog.HistorySession) allSession {
	title := strings.TrimSpace(saved.Title)
	if title == "" {
		title = strings.TrimSpace(saved.Purpose)
	}
	if title == "" {
		title = strings.TrimSpace(saved.Agent + " session")
	}
	return allSession{
		ID:        allSessionHistoryID(saved.Agent, saved.SessionID),
		Agent:     saved.Agent,
		SessionID: saved.SessionID,
		Title:     title,
		Purpose:   saved.Purpose,
		Summary:   saved.Summary,
		CWD:       saved.CWD,
		Project:   saved.Project,
		UpdatedAt: saved.UpdatedAt,
		State:     allSessionResume,
	}
}

func mergeCurrentAllSession(current allSession, saved agentlog.HistorySession) allSession {
	if current.Title == "" || current.Title == "Terminal" {
		if saved.Title != "" {
			current.Title = saved.Title
		}
	}
	if current.CWD == "" {
		current.CWD = saved.CWD
	}
	if current.Project == "" {
		current.Project = saved.Project
	}
	if current.Purpose == "" {
		current.Purpose = saved.Purpose
	}
	if current.Summary == "" {
		current.Summary = saved.Summary
	}
	if saved.UpdatedAt.After(current.UpdatedAt) {
		current.UpdatedAt = saved.UpdatedAt
	}
	return current
}

func allSessionAgentKey(agent, sessionID string) string {
	return agent + "\x00" + sessionID
}

func allSessionHistoryID(agent, sessionID string) string {
	return agent + ":" + sessionID
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

	for _, metadata := range s.sessions.ListCurrent() {
		if metadata.AgentSessionID != sessionID ||
			(metadata.Agent != agent && metadata.ResumeAgent != agent) ||
			(metadata.State != session.StateStarting && metadata.State != session.StateRunning) {
			continue
		}
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

	history, err := s.agentLogs.DiscoverHistory()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "all_sessions_list_failed",
			"The session history could not be loaded.")
		return
	}
	var saved *agentlog.HistorySession
	for index := range history {
		if history[index].Agent == agent && history[index].SessionID == sessionID {
			saved = &history[index]
			break
		}
	}
	if saved == nil {
		writeError(w, http.StatusNotFound, "session_history_not_found",
			"The agent session history no longer exists.")
		return
	}
	name := truncateAllSessionName(saved.Title)
	if name == "" {
		name = truncateAllSessionName(saved.Purpose)
	}
	if name == "" {
		name = strings.ToUpper(agent[:1]) + agent[1:] + " session"
	}
	command := agent
	args := []string{"resume", sessionID}
	if agent == "claude" {
		args = []string{"--resume", sessionID}
	}
	cwd, err := resumeWorkingDirectory(saved.CWD)
	if err != nil {
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
	if utf8.RuneCountInString(value) <= 80 {
		return value
	}
	runes := []rune(value)
	return strings.TrimSpace(string(runes[:80]))
}
