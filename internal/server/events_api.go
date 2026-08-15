package server

import (
	"encoding/json"
	"net/http"
	"time"
)

const eventHeartbeatInterval = 15 * time.Second

func (s *Server) apiEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPIError(w, http.StatusInternalServerError, "streaming_unsupported",
			"The HTTP response does not support streaming.", nil)
		return
	}
	events, unsubscribe := s.control.SubscribeEvents(r.URL.Query()["type"])
	defer unsubscribe()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ticker := time.NewTicker(eventHeartbeatInterval)
	defer ticker.Stop()
	encoder := json.NewEncoder(w)
	for {
		select {
		case event, open := <-events:
			if !open {
				return
			}
			if err := encoder.Encode(event); err != nil {
				return
			}
			flusher.Flush()
		case <-ticker.C:
			if err := encoder.Encode(s.control.Heartbeat()); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			return
		}
	}
}
