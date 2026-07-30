package control

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

func TestServiceInitializesSelectionFromFirstExistingTerminal(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	first, err := manager.Create(t.Context(), "First", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := manager.Create(t.Context(), "Second", t.TempDir()); err != nil {
		t.Fatalf("Create() second error = %v", err)
	}

	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	snapshot := service.Selection()
	if !reflect.DeepEqual(snapshot.TerminalIDs, []string{first.ID}) ||
		snapshot.FocusedTerminalID != first.ID ||
		snapshot.Revision != 1 {
		t.Fatalf("initial Selection() = %#v", snapshot)
	}
}

func TestServicePublishesSelectionWhenAgentStatusEntersDynamicFilter(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	first, err := manager.Create(t.Context(), "First", t.TempDir())
	if err != nil {
		t.Fatalf("Create() first error = %v", err)
	}
	second, err := manager.Create(t.Context(), "Second", t.TempDir())
	if err != nil {
		t.Fatalf("Create() second error = %v", err)
	}
	if _, err := manager.UpdateAgent(first.ID, session.AgentUpdate{
		Agent: "codex", Status: "running",
	}); err != nil {
		t.Fatalf("UpdateAgent(first) error = %v", err)
	}
	if _, err := manager.UpdateAgent(second.ID, session.AgentUpdate{
		Agent: "codex", Status: "waiting",
	}); err != nil {
		t.Fatalf("UpdateAgent(second) error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := service.ApplySelection(context.Background(), selection.Action{
		Type:        selection.ActionReplace,
		TerminalIDs: nil,
	}); err != nil {
		t.Fatalf("ApplySelection(replace) error = %v", err)
	}
	if _, err := service.ApplySelection(context.Background(), selection.Action{
		Type:     selection.ActionFilterStatusSet,
		Statuses: []string{"running"},
	}); err != nil {
		t.Fatalf("ApplySelection(filter) error = %v", err)
	}
	events, unsubscribe := service.SubscribeEvents([]string{"selection.changed"})
	defer unsubscribe()

	if _, err := manager.UpdateAgent(second.ID, session.AgentUpdate{
		Agent: "codex", Status: "running",
	}); err != nil {
		t.Fatalf("UpdateAgent(second running) error = %v", err)
	}

	select {
	case event := <-events:
		snapshot, ok := event.Data.(selection.Snapshot)
		if !ok {
			t.Fatalf("event Data = %T, want selection.Snapshot", event.Data)
		}
		if !reflect.DeepEqual(snapshot.TerminalIDs, []string{first.ID, second.ID}) {
			t.Fatalf("event selection = %#v", snapshot)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for selection.changed")
	}
}

func TestServiceIgnoresOutOfOrderSessionChanges(t *testing.T) {
	manager := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(t.Context()) })
	terminal, err := manager.Create(t.Context(), "Terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	service, err := New(manager)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	events, unsubscribe := service.SubscribeEvents([]string{"terminal.updated"})
	defer unsubscribe()

	newer := terminal
	newer.Name = "Newer"
	older := terminal
	older.Name = "Older"
	service.handleSessionChange(session.Change{
		Sequence: 2,
		Kind:     session.ChangeUpdated,
		Before:   &terminal,
		After:    &newer,
	})
	service.handleSessionChange(session.Change{
		Sequence: 1,
		Kind:     session.ChangeUpdated,
		Before:   &terminal,
		After:    &older,
	})

	event := <-events
	metadata, ok := event.Data.(session.Metadata)
	if !ok || metadata.Name != "Newer" {
		t.Fatalf("event = %#v", event)
	}
	select {
	case event := <-events:
		t.Fatalf("stale change was published: %#v", event)
	default:
	}
}
