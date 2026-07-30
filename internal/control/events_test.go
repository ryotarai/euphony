package control

import (
	"testing"
	"time"
)

func TestEventHubPreservesOrderAndFiltersTypes(t *testing.T) {
	now := time.Date(2026, 7, 30, 10, 0, 0, 0, time.UTC)
	hub := newEventHub(4, func() time.Time { return now })
	events, unsubscribe := hub.subscribe([]string{"selection.changed"})
	defer unsubscribe()

	hub.publish("terminal.updated", map[string]string{"id": "ignored"})
	hub.publish("selection.changed", map[string]uint64{"revision": 1})
	hub.publish("selection.changed", map[string]uint64{"revision": 2})

	first := <-events
	second := <-events
	if first.Sequence != 2 || second.Sequence != 3 ||
		first.Type != "selection.changed" || second.Type != "selection.changed" ||
		!first.OccurredAt.Equal(now) || !second.OccurredAt.Equal(now) {
		t.Fatalf("events = %#v, %#v", first, second)
	}
}

func TestEventHubClosesLaggingSubscriberWithFinalRecord(t *testing.T) {
	hub := newEventHub(1, time.Now)
	events, unsubscribe := hub.subscribe(nil)
	defer unsubscribe()

	hub.publish("terminal.created", map[string]string{"id": "first"})
	hub.publish("terminal.updated", map[string]string{"id": "second"})

	event, ok := <-events
	if !ok || event.Type != "subscriber_lagged" {
		t.Fatalf("lag event = %#v, %t", event, ok)
	}
	if _, open := <-events; open {
		t.Fatal("events remained open after subscriber lagged")
	}
}

func TestEventHubHeartbeatIsScopedToItsRequestStream(t *testing.T) {
	hub := newEventHub(2, time.Now)
	events, unsubscribe := hub.subscribe(nil)
	defer unsubscribe()

	heartbeat := hub.heartbeat()
	if heartbeat.Type != "heartbeat" || heartbeat.Sequence == 0 {
		t.Fatalf("heartbeat = %#v", heartbeat)
	}
	select {
	case event := <-events:
		t.Fatalf("heartbeat was broadcast to another subscriber: %#v", event)
	default:
	}
}
