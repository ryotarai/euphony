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
	readOnly  bool
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
	return s.createWithMode(sessionID, false)
}

func (s *ticketStore) createWithMode(sessionID string, readOnly bool) (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	ticket := base64.RawURLEncoding.EncodeToString(value)
	s.mu.Lock()
	s.tickets[ticket] = ticketEntry{
		sessionID: sessionID,
		expiresAt: s.now().Add(30 * time.Second),
		readOnly:  readOnly,
	}
	s.mu.Unlock()
	return ticket, nil
}

func (s *ticketStore) consume(ticket, sessionID string) bool {
	_, ok := s.consumeEntry(ticket, sessionID)
	return ok
}

func (s *ticketStore) consumeEntry(ticket, sessionID string) (ticketEntry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.tickets[ticket]
	if !ok || entry.sessionID != sessionID {
		return ticketEntry{}, false
	}
	delete(s.tickets, ticket)
	if s.now().After(entry.expiresAt) {
		return ticketEntry{}, false
	}
	return entry, true
}
