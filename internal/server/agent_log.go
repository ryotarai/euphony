package server

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/session"
)

var (
	errAgentLogNotLinked = errors.New("agent log not linked")
	errAgentLogNotFound  = errors.New("agent log not found")
)

func (s *Server) agentLog(w http.ResponseWriter, r *http.Request) {
	metadata, ok := s.sessions.Metadata(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "session_not_found", "The terminal session does not exist.")
		return
	}
	transcript, path, info, err := s.loadAgentTranscript(metadata)
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

func (s *Server) loadAgentTranscript(
	metadata session.Metadata,
) (agentlog.Transcript, string, os.FileInfo, error) {
	agent := metadata.Agent
	if agent == "" {
		agent = metadata.ResumeAgent
	}
	if agent == "" || metadata.AgentSessionID == "" {
		return agentlog.Transcript{}, "", nil, errAgentLogNotLinked
	}
	path, err := s.agentLogs.Resolve(agent, metadata.AgentSessionID, metadata.AgentTranscriptPath)
	if err != nil {
		return agentlog.Transcript{}, "", nil, errAgentLogNotFound
	}
	file, err := os.Open(path)
	if err != nil {
		return agentlog.Transcript{}, "", nil, errAgentLogNotFound
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return agentlog.Transcript{}, "", nil, err
	}
	entries, err := agentlog.Parse(agent, file)
	if err != nil {
		return agentlog.Transcript{}, "", nil, err
	}
	return agentlog.Transcript{
		Agent: agent, SessionID: metadata.AgentSessionID, Entries: entries,
	}, path, info, nil
}
