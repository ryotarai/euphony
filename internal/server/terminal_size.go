package server

import (
	"errors"
	"sync"
)

var errInvalidTerminalDimensions = errors.New(
	"terminal dimensions must be between 1 and 1000",
)

type terminalDimensions struct {
	Cols uint16
	Rows uint16
}

type terminalSizeClient struct {
	dimensions terminalDimensions
	reported   bool
	updates    chan terminalDimensions
}

type terminalSizeGroup struct {
	apply       func(uint16, uint16) error
	clients     map[uint64]*terminalSizeClient
	accepted    terminalDimensions
	hasAccepted bool
}

type terminalSizeCoordinator struct {
	mu     sync.Mutex
	groups map[string]*terminalSizeGroup
	nextID uint64
}

func newTerminalSizeCoordinator() *terminalSizeCoordinator {
	return &terminalSizeCoordinator{
		groups: make(map[string]*terminalSizeGroup),
	}
}

func (c *terminalSizeCoordinator) subscribe(
	terminalID string,
	initial terminalDimensions,
	apply func(uint16, uint16) error,
) (
	func(uint16, uint16) error,
	func() error,
	<-chan terminalDimensions,
	func(),
) {
	c.mu.Lock()
	group, ok := c.groups[terminalID]
	if !ok {
		group = &terminalSizeGroup{
			apply:       apply,
			clients:     make(map[uint64]*terminalSizeClient),
			accepted:    initial,
			hasAccepted: validTerminalDimensions(initial),
		}
		c.groups[terminalID] = group
	}
	clientID := c.nextID
	c.nextID++
	client := &terminalSizeClient{
		updates: make(chan terminalDimensions, 1),
	}
	group.clients[clientID] = client
	c.mu.Unlock()

	report := func(cols, rows uint16) error {
		return c.report(terminalID, clientID, terminalDimensions{
			Cols: cols,
			Rows: rows,
		})
	}
	release := func() error {
		return c.release(terminalID, clientID)
	}
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			c.unsubscribe(terminalID, clientID)
		})
	}
	return report, release, client.updates, stop
}

func (c *terminalSizeCoordinator) report(
	terminalID string,
	clientID uint64,
	dimensions terminalDimensions,
) error {
	if !validTerminalDimensions(dimensions) {
		return errInvalidTerminalDimensions
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	group, ok := c.groups[terminalID]
	if !ok {
		return errors.New("terminal size subscription is closed")
	}
	client, ok := group.clients[clientID]
	if !ok {
		return errors.New("terminal size subscription is closed")
	}

	previousDimensions := client.dimensions
	previouslyReported := client.reported
	client.dimensions = dimensions
	client.reported = true
	next, hasNext := minimumTerminalDimensions(group.clients)
	if !hasNext {
		return nil
	}
	if group.hasAccepted && next == group.accepted {
		if !previouslyReported {
			publishTerminalDimensions(client.updates, group.accepted)
		}
		return nil
	}
	previousAccepted := group.accepted
	previouslyAccepted := group.hasAccepted
	group.accepted = next
	group.hasAccepted = true
	publishAcceptedTerminalDimensions(group)
	if err := group.apply(next.Cols, next.Rows); err != nil {
		client.dimensions = previousDimensions
		client.reported = previouslyReported
		group.accepted = previousAccepted
		group.hasAccepted = previouslyAccepted
		if group.hasAccepted {
			publishAcceptedTerminalDimensions(group)
			if !previouslyReported {
				publishTerminalDimensions(client.updates, group.accepted)
			}
		}
		return err
	}
	return nil
}

func (c *terminalSizeCoordinator) release(
	terminalID string,
	clientID uint64,
) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	group, ok := c.groups[terminalID]
	if !ok {
		return errors.New("terminal size subscription is closed")
	}
	client, ok := group.clients[clientID]
	if !ok {
		return errors.New("terminal size subscription is closed")
	}
	if !client.reported {
		return nil
	}

	previousAccepted := group.accepted
	previouslyAccepted := group.hasAccepted
	client.reported = false
	next, hasNext := minimumTerminalDimensions(group.clients)
	if !hasNext || (group.hasAccepted && next == group.accepted) {
		return nil
	}
	group.accepted = next
	group.hasAccepted = true
	publishAcceptedTerminalDimensions(group)
	if err := group.apply(next.Cols, next.Rows); err != nil {
		client.reported = true
		group.accepted = previousAccepted
		group.hasAccepted = previouslyAccepted
		if group.hasAccepted {
			publishAcceptedTerminalDimensions(group)
		}
		return err
	}
	return nil
}

func (c *terminalSizeCoordinator) unsubscribe(terminalID string, clientID uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	group, ok := c.groups[terminalID]
	if !ok {
		return
	}
	client, ok := group.clients[clientID]
	if !ok {
		return
	}
	delete(group.clients, clientID)
	if len(group.clients) == 0 {
		delete(c.groups, terminalID)
		return
	}
	if !client.reported {
		return
	}
	next, hasNext := minimumTerminalDimensions(group.clients)
	if !hasNext || (group.hasAccepted && next == group.accepted) {
		return
	}
	previousAccepted := group.accepted
	previouslyAccepted := group.hasAccepted
	group.accepted = next
	group.hasAccepted = true
	publishAcceptedTerminalDimensions(group)
	if err := group.apply(next.Cols, next.Rows); err != nil {
		group.accepted = previousAccepted
		group.hasAccepted = previouslyAccepted
		if group.hasAccepted {
			publishAcceptedTerminalDimensions(group)
		}
		return
	}
}

func validTerminalDimensions(dimensions terminalDimensions) bool {
	return dimensions.Cols >= 1 &&
		dimensions.Cols <= 1000 &&
		dimensions.Rows >= 1 &&
		dimensions.Rows <= 1000
}

func minimumTerminalDimensions(
	clients map[uint64]*terminalSizeClient,
) (terminalDimensions, bool) {
	var minimum terminalDimensions
	found := false
	for _, client := range clients {
		if !client.reported {
			continue
		}
		if !found || client.dimensions.Cols < minimum.Cols {
			minimum.Cols = client.dimensions.Cols
		}
		if !found || client.dimensions.Rows < minimum.Rows {
			minimum.Rows = client.dimensions.Rows
		}
		found = true
	}
	return minimum, found
}

func publishAcceptedTerminalDimensions(group *terminalSizeGroup) {
	for _, client := range group.clients {
		if client.reported {
			publishTerminalDimensions(client.updates, group.accepted)
		}
	}
}

func publishTerminalDimensions(
	updates chan terminalDimensions,
	dimensions terminalDimensions,
) {
	select {
	case <-updates:
	default:
	}
	updates <- dimensions
}
