package server

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"os"

	"github.com/ryotarai/euphony/internal/agentlog"
)

func (s *Server) agentLog(w http.ResponseWriter, r *http.Request) {
	metadata, ok := s.sessions.Metadata(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "session_not_found", "The terminal session does not exist.")
		return
	}
	agent := metadata.Agent
	if agent == "" {
		agent = metadata.ResumeAgent
	}
	if agent == "" || metadata.AgentSessionID == "" {
		writeError(w, http.StatusNotFound, "agent_log_not_found", "No agent log is linked to this terminal yet.")
		return
	}
	path, err := s.agentLogs.Resolve(agent, metadata.AgentSessionID, metadata.AgentTranscriptPath)
	if err != nil {
		writeError(w, http.StatusNotFound, "agent_log_not_found", "The linked agent log is not available yet.")
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeError(w, http.StatusNotFound, "agent_log_not_found", "The linked agent log is not available yet.")
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent_log_read_failed", "The agent log could not be read.")
		return
	}
	identity := sha256.Sum256([]byte(agent + "\x00" + metadata.AgentSessionID + "\x00" + path))
	etag := fmt.Sprintf(
		`W/"%x-%x-%x"`, identity[:8], info.Size(), info.ModTime().UnixNano(),
	)
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", etag)
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	entries, err := agentlog.Parse(agent, file)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "agent_log_read_failed", "The agent log could not be read.")
		return
	}
	writeJSON(w, http.StatusOK, agentlog.Transcript{
		Agent: agent, SessionID: metadata.AgentSessionID, Entries: entries,
	})
}
