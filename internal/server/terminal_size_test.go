package server

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func readTerminalDimensions(
	t *testing.T,
	updates <-chan terminalDimensions,
) terminalDimensions {
	t.Helper()
	select {
	case dimensions := <-updates:
		return dimensions
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for terminal dimensions")
		return terminalDimensions{}
	}
}

func assertNoTerminalDimensions(
	t *testing.T,
	updates <-chan terminalDimensions,
) {
	t.Helper()
	select {
	case dimensions := <-updates:
		t.Fatalf("unexpected terminal dimensions: %#v", dimensions)
	default:
	}
}

func TestTerminalSizeCoordinatorUsesSmallestClaimAndGrowsAfterDisconnect(t *testing.T) {
	var applied []terminalDimensions
	apply := func(cols, rows uint16) error {
		applied = append(applied, terminalDimensions{Cols: cols, Rows: rows})
		return nil
	}
	coordinator := newTerminalSizeCoordinator()
	reportLarge, largeUpdates, stopLarge := coordinator.subscribe("terminal", apply)
	defer stopLarge()
	reportSmall, smallUpdates, stopSmall := coordinator.subscribe("terminal", apply)

	if err := reportLarge(120, 40); err != nil {
		t.Fatalf("reportLarge(120, 40) error = %v", err)
	}
	if got := readTerminalDimensions(t, largeUpdates); got != (terminalDimensions{Cols: 120, Rows: 40}) {
		t.Fatalf("large dimensions = %#v, want 120x40", got)
	}

	if err := reportSmall(80, 24); err != nil {
		t.Fatalf("reportSmall(80, 24) error = %v", err)
	}
	for name, updates := range map[string]<-chan terminalDimensions{
		"large": largeUpdates,
		"small": smallUpdates,
	} {
		if got := readTerminalDimensions(t, updates); got != (terminalDimensions{Cols: 80, Rows: 24}) {
			t.Fatalf("%s dimensions = %#v, want 80x24", name, got)
		}
	}

	if err := reportLarge(100, 30); err != nil {
		t.Fatalf("reportLarge(100, 30) error = %v", err)
	}
	assertNoTerminalDimensions(t, largeUpdates)
	assertNoTerminalDimensions(t, smallUpdates)

	stopSmall()
	stopSmall()
	if got := readTerminalDimensions(t, largeUpdates); got != (terminalDimensions{Cols: 100, Rows: 30}) {
		t.Fatalf("large dimensions after disconnect = %#v, want 100x30", got)
	}

	wantApplied := []terminalDimensions{
		{Cols: 120, Rows: 40},
		{Cols: 80, Rows: 24},
		{Cols: 100, Rows: 30},
	}
	if !reflect.DeepEqual(applied, wantApplied) {
		t.Fatalf("applied dimensions = %#v, want %#v", applied, wantApplied)
	}
}

func TestTerminalSizeCoordinatorRejectsInvalidClaimsWithoutChangingSize(t *testing.T) {
	coordinator := newTerminalSizeCoordinator()
	report, updates, stop := coordinator.subscribe(
		"terminal",
		func(uint16, uint16) error { return nil },
	)
	defer stop()

	for _, dimensions := range []terminalDimensions{
		{Cols: 0, Rows: 24},
		{Cols: 1001, Rows: 24},
		{Cols: 80, Rows: 0},
		{Cols: 80, Rows: 1001},
	} {
		if err := report(dimensions.Cols, dimensions.Rows); err == nil {
			t.Fatalf("report(%d, %d) error = nil", dimensions.Cols, dimensions.Rows)
		}
		assertNoTerminalDimensions(t, updates)
	}
}

func TestTerminalSizeCoordinatorRollsBackClaimWhenResizeFails(t *testing.T) {
	resizeFailure := errors.New("resize failed")
	var applied []terminalDimensions
	apply := func(cols, rows uint16) error {
		dimensions := terminalDimensions{Cols: cols, Rows: rows}
		applied = append(applied, dimensions)
		if dimensions == (terminalDimensions{Cols: 80, Rows: 24}) {
			return resizeFailure
		}
		return nil
	}
	coordinator := newTerminalSizeCoordinator()
	reportLarge, largeUpdates, stopLarge := coordinator.subscribe("terminal", apply)
	defer stopLarge()
	reportSmall, smallUpdates, stopSmall := coordinator.subscribe("terminal", apply)
	defer stopSmall()

	if err := reportLarge(120, 40); err != nil {
		t.Fatalf("reportLarge(120, 40) error = %v", err)
	}
	_ = readTerminalDimensions(t, largeUpdates)

	if err := reportSmall(80, 24); !errors.Is(err, resizeFailure) {
		t.Fatalf("reportSmall(80, 24) error = %v, want resize failure", err)
	}
	assertNoTerminalDimensions(t, largeUpdates)
	assertNoTerminalDimensions(t, smallUpdates)

	if err := reportSmall(100, 30); err != nil {
		t.Fatalf("reportSmall(100, 30) error = %v", err)
	}
	for name, updates := range map[string]<-chan terminalDimensions{
		"large": largeUpdates,
		"small": smallUpdates,
	} {
		if got := readTerminalDimensions(t, updates); got != (terminalDimensions{Cols: 100, Rows: 30}) {
			t.Fatalf("%s dimensions = %#v, want 100x30", name, got)
		}
	}

	wantApplied := []terminalDimensions{
		{Cols: 120, Rows: 40},
		{Cols: 80, Rows: 24},
		{Cols: 100, Rows: 30},
	}
	if !reflect.DeepEqual(applied, wantApplied) {
		t.Fatalf("applied dimensions = %#v, want %#v", applied, wantApplied)
	}
}
