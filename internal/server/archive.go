package server

import (
	"context"
	"time"
)

const staleAgentArchiveInterval = time.Minute

func (s *Server) startStaleAgentArchiver() {
	s.archiveStop = make(chan struct{})
	s.archiveDone = make(chan struct{})
	archiveContext, cancel := context.WithCancel(context.Background())
	s.archiveCancel = cancel
	go func() {
		ticker := time.NewTicker(staleAgentArchiveInterval)
		defer ticker.Stop()
		defer close(s.archiveDone)
		// Handle records restored from the database before the first timer tick
		// without delaying server construction or a sessions list request.
		s.sessions.ArchiveStaleWaitingAgentsContext(archiveContext, time.Now().UTC())
		for {
			select {
			case <-ticker.C:
				s.sessions.ArchiveStaleWaitingAgentsContext(archiveContext, time.Now().UTC())
			case <-s.archiveStop:
				return
			}
		}
	}()
}

func (s *Server) stopStaleAgentArchiver(ctx context.Context) error {
	if s.archiveStop == nil {
		return nil
	}
	s.archiveStopOnce.Do(func() {
		close(s.archiveStop)
		if s.archiveCancel != nil {
			s.archiveCancel()
		}
	})
	select {
	case <-s.archiveDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
