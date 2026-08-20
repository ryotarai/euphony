package server

import (
	"time"
)

const staleAgentArchiveInterval = time.Minute

func (s *Server) startStaleAgentArchiver() {
	s.archiveStop = make(chan struct{})
	s.archiveDone = make(chan struct{})
	// Handle records restored from the database before the first timer tick.
	s.sessions.ArchiveStaleWaitingAgents(time.Now().UTC())
	go func() {
		ticker := time.NewTicker(staleAgentArchiveInterval)
		defer ticker.Stop()
		defer close(s.archiveDone)
		for {
			select {
			case <-ticker.C:
				s.sessions.ArchiveStaleWaitingAgents(time.Now().UTC())
			case <-s.archiveStop:
				return
			}
		}
	}()
}

func (s *Server) stopStaleAgentArchiver() {
	if s.archiveStop == nil {
		return
	}
	s.archiveStopOnce.Do(func() { close(s.archiveStop) })
	<-s.archiveDone
}
