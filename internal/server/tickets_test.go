package server

import (
	"testing"
	"time"
)

func TestTicketIsScopedAndSingleUse(t *testing.T) {
	now := time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC)
	store := newTicketStore(func() time.Time { return now })

	ticket, err := store.create("session-one")
	if err != nil {
		t.Fatalf("create() error = %v", err)
	}
	if store.consume(ticket, "session-two") {
		t.Fatal("consume() accepted ticket for another session")
	}
	if !store.consume(ticket, "session-one") {
		t.Fatal("consume() rejected valid ticket")
	}
	if store.consume(ticket, "session-one") {
		t.Fatal("consume() accepted reused ticket")
	}
}

func TestTicketExpiresAfterThirtySeconds(t *testing.T) {
	now := time.Date(2026, 7, 28, 0, 0, 0, 0, time.UTC)
	store := newTicketStore(func() time.Time { return now })
	ticket, err := store.create("session")
	if err != nil {
		t.Fatalf("create() error = %v", err)
	}

	now = now.Add(31 * time.Second)
	if store.consume(ticket, "session") {
		t.Fatal("consume() accepted expired ticket")
	}
}
