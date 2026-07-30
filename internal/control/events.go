package control

import (
	"sync"
	"time"
)

type Event struct {
	Sequence   uint64    `json:"sequence"`
	OccurredAt time.Time `json:"occurredAt"`
	Type       string    `json:"type"`
	Data       any       `json:"data"`
}

type eventSubscriber struct {
	events chan Event
	types  map[string]bool
}

type eventHub struct {
	mu          sync.Mutex
	bufferSize  int
	now         func() time.Time
	sequence    uint64
	nextID      uint64
	subscribers map[uint64]*eventSubscriber
}

func newEventHub(bufferSize int, now func() time.Time) *eventHub {
	if bufferSize < 1 {
		bufferSize = 1
	}
	return &eventHub{
		bufferSize:  bufferSize,
		now:         now,
		subscribers: make(map[uint64]*eventSubscriber),
	}
}

func (h *eventHub) subscribe(types []string) (<-chan Event, func()) {
	filter := make(map[string]bool, len(types))
	for _, eventType := range types {
		if eventType != "" {
			filter[eventType] = true
		}
	}
	h.mu.Lock()
	id := h.nextID
	h.nextID++
	subscriber := &eventSubscriber{
		events: make(chan Event, h.bufferSize),
		types:  filter,
	}
	h.subscribers[id] = subscriber
	h.mu.Unlock()

	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			h.mu.Lock()
			if current, ok := h.subscribers[id]; ok {
				delete(h.subscribers, id)
				close(current.events)
			}
			h.mu.Unlock()
		})
	}
	return subscriber.events, unsubscribe
}

func (h *eventHub) publish(eventType string, data any) Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sequence++
	event := Event{
		Sequence:   h.sequence,
		OccurredAt: h.now().UTC(),
		Type:       eventType,
		Data:       data,
	}
	for id, subscriber := range h.subscribers {
		if eventType != "heartbeat" &&
			len(subscriber.types) > 0 &&
			!subscriber.types[eventType] {
			continue
		}
		select {
		case subscriber.events <- event:
		default:
			for len(subscriber.events) > 0 {
				<-subscriber.events
			}
			subscriber.events <- Event{
				Sequence:   event.Sequence,
				OccurredAt: event.OccurredAt,
				Type:       "subscriber_lagged",
				Data: map[string]string{
					"message": "The event subscriber fell behind.",
				},
			}
			delete(h.subscribers, id)
			close(subscriber.events)
		}
	}
	return event
}

func (h *eventHub) heartbeat() Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sequence++
	return Event{
		Sequence:   h.sequence,
		OccurredAt: h.now().UTC(),
		Type:       "heartbeat",
		Data:       map[string]string{"status": "ok"},
	}
}
