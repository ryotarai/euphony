package server

import (
	"crypto/rand"
	"encoding/base64"
	"sync"
	"time"
)

type ticketEntry struct {
	sessionID string
	expiresAt time.Time
}

type ticketStore struct {
	mu      sync.Mutex
	now     func() time.Time
	tickets map[string]ticketEntry
}

func newTicketStore(now func() time.Time) *ticketStore {
	return &ticketStore{now: now, tickets: make(map[string]ticketEntry)}
}

func (s *ticketStore) create(sessionID string) (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	ticket := base64.RawURLEncoding.EncodeToString(value)
	s.mu.Lock()
	s.tickets[ticket] = ticketEntry{
		sessionID: sessionID,
		expiresAt: s.now().Add(30 * time.Second),
	}
	s.mu.Unlock()
	return ticket, nil
}

func (s *ticketStore) consume(ticket, sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.tickets[ticket]
	if !ok || entry.sessionID != sessionID {
		return false
	}
	delete(s.tickets, ticket)
	return !s.now().After(entry.expiresAt)
}
