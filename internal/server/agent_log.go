package server

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"

	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/session"
)

var (
	errAgentLogNotLinked = errors.New("agent log not linked")
	errAgentLogNotFound  = errors.New("agent log not found")
)

const agentLogPageRecords = 100

func (s *Server) agentLog(w http.ResponseWriter, r *http.Request) {
	before, after, err := agentLogCursors(r)
	if err != nil {
		writeError(
			w,
			http.StatusBadRequest,
			"invalid_agent_log_cursor",
			"Use one non-negative before or after cursor.",
		)
		return
	}
	metadata, ok := s.sessions.Metadata(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "session_not_found", "The terminal session does not exist.")
		return
	}
	transcript, path, info, err := s.loadAgentTranscriptPage(metadata, before, after)
	if errors.Is(err, errAgentLogNotLinked) {
		writeError(w, http.StatusNotFound, "agent_log_not_found", "No agent log is linked to this terminal yet.")
		return
	}
	if errors.Is(err, errAgentLogNotFound) {
		writeError(w, http.StatusNotFound, "agent_log_not_found", "The linked agent log is not available yet.")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent_log_read_failed", "The agent log could not be read.")
		return
	}
	identity := sha256.Sum256([]byte(transcript.Agent + "\x00" + transcript.SessionID + "\x00" + path))
	etag := fmt.Sprintf(
		`W/"%x-%x-%x"`, identity[:8], info.Size(), info.ModTime().UnixNano(),
	)
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	writeJSON(w, http.StatusOK, transcript)
}

func agentLogCursors(r *http.Request) (*int64, *int64, error) {
	query := r.URL.Query()
	beforeValues, hasBefore := query["before"]
	afterValues, hasAfter := query["after"]
	if hasBefore && hasAfter {
		return nil, nil, errors.New("before and after are mutually exclusive")
	}
	parse := func(values []string) (*int64, error) {
		if len(values) != 1 {
			return nil, errors.New("cursor must have one value")
		}
		value, err := strconv.ParseInt(values[0], 10, 64)
		if err != nil || value < 0 {
			return nil, errors.New("cursor must be non-negative")
		}
		return &value, nil
	}
	if hasBefore {
		value, err := parse(beforeValues)
		return value, nil, err
	}
	if hasAfter {
		value, err := parse(afterValues)
		return nil, value, err
	}
	return nil, nil, nil
}

func (s *Server) loadAgentTranscriptPage(
	metadata session.Metadata,
	before *int64,
	after *int64,
) (agentlog.Transcript, string, os.FileInfo, error) {
	agent, path, file, info, err := s.openAgentTranscript(metadata)
	if err != nil {
		return agentlog.Transcript{}, "", nil, err
	}
	defer file.Close()

	var page agentlog.Page
	if after != nil && *after <= info.Size() {
		page, err = agentlog.ReadAfter(agent, file, *after)
	} else {
		end := info.Size()
		if before != nil {
			end = *before
		}
		page, err = agentlog.ReadPage(agent, file, end, agentLogPageRecords)
	}
	if err != nil {
		return agentlog.Transcript{}, "", nil, err
	}
	transcript := agentlog.Transcript{
		Agent:       agent,
		SessionID:   metadata.AgentSessionID,
		Entries:     page.Entries,
		StartCursor: strconv.FormatInt(page.StartCursor, 10),
		EndCursor:   strconv.FormatInt(page.EndCursor, 10),
	}
	if page.HasMore {
		transcript.NextCursor = transcript.StartCursor
	}
	return transcript, path, info, nil
}

func (s *Server) loadAgentTranscript(
	metadata session.Metadata,
) (agentlog.Transcript, string, os.FileInfo, error) {
	agent, path, file, info, err := s.openAgentTranscript(metadata)
	if err != nil {
		return agentlog.Transcript{}, "", nil, err
	}
	defer file.Close()
	entries, err := agentlog.Parse(agent, file)
	if err != nil {
		return agentlog.Transcript{}, "", nil, err
	}
	return agentlog.Transcript{
		Agent: agent, SessionID: metadata.AgentSessionID, Entries: entries,
	}, path, info, nil
}

func (s *Server) openAgentTranscript(
	metadata session.Metadata,
) (string, string, *os.File, os.FileInfo, error) {
	agent := metadata.Agent
	if agent == "" {
		agent = metadata.ResumeAgent
	}
	if agent == "" || metadata.AgentSessionID == "" {
		return "", "", nil, nil, errAgentLogNotLinked
	}
	path, err := s.agentLogs.Resolve(agent, metadata.AgentSessionID, metadata.AgentTranscriptPath)
	if err != nil {
		return "", "", nil, nil, errAgentLogNotFound
	}
	file, err := os.Open(path)
	if err != nil {
		return "", "", nil, nil, errAgentLogNotFound
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return "", "", nil, nil, err
	}
	return agent, path, file, info, nil
}
