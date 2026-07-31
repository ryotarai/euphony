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
	apply := func(cols, rows uint16, notify func()) error {
		applied = append(applied, terminalDimensions{Cols: cols, Rows: rows})
		notify()
		return nil
	}
	coordinator := newTerminalSizeCoordinator()
	reportLarge, _, largeUpdates, stopLarge := coordinator.subscribe(
		"terminal",
		terminalDimensions{Cols: 80, Rows: 24},
		apply,
	)
	defer stopLarge()
	reportSmall, _, smallUpdates, stopSmall := coordinator.subscribe(
		"terminal",
		terminalDimensions{Cols: 80, Rows: 24},
		apply,
	)

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
	report, _, updates, stop := coordinator.subscribe(
		"terminal",
		terminalDimensions{Cols: 80, Rows: 24},
		func(uint16, uint16, func()) error { return nil },
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
	apply := func(cols, rows uint16, notify func()) error {
		dimensions := terminalDimensions{Cols: cols, Rows: rows}
		applied = append(applied, dimensions)
		if dimensions == (terminalDimensions{Cols: 80, Rows: 24}) {
			return resizeFailure
		}
		notify()
		return nil
	}
	coordinator := newTerminalSizeCoordinator()
	reportLarge, _, largeUpdates, stopLarge := coordinator.subscribe(
		"terminal",
		terminalDimensions{Cols: 120, Rows: 40},
		apply,
	)
	defer stopLarge()
	reportSmall, _, smallUpdates, stopSmall := coordinator.subscribe(
		"terminal",
		terminalDimensions{Cols: 120, Rows: 40},
		apply,
	)
	defer stopSmall()

	if err := reportLarge(120, 40); err != nil {
		t.Fatalf("reportLarge(120, 40) error = %v", err)
	}
	_ = readTerminalDimensions(t, largeUpdates)

	if err := reportSmall(80, 24); !errors.Is(err, resizeFailure) {
		t.Fatalf("reportSmall(80, 24) error = %v, want resize failure", err)
	}
	for name, updates := range map[string]<-chan terminalDimensions{
		"large": largeUpdates,
		"small": smallUpdates,
	} {
		t.Run(name, func(t *testing.T) {
			assertNoTerminalDimensions(t, updates)
		})
	}

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
		{Cols: 80, Rows: 24},
		{Cols: 100, Rows: 30},
	}
	if !reflect.DeepEqual(applied, wantApplied) {
		t.Fatalf("applied dimensions = %#v, want %#v", applied, wantApplied)
	}
}

func TestTerminalSizeCoordinatorReleasesAndRestoresClientClaim(t *testing.T) {
	var applied []terminalDimensions
	apply := func(cols, rows uint16, notify func()) error {
		applied = append(applied, terminalDimensions{Cols: cols, Rows: rows})
		notify()
		return nil
	}
	coordinator := newTerminalSizeCoordinator()
	reportLarge, _, largeUpdates, stopLarge := coordinator.subscribe(
		"terminal",
		terminalDimensions{Cols: 80, Rows: 24},
		apply,
	)
	defer stopLarge()
	reportSmall, releaseSmall, smallUpdates, stopSmall := coordinator.subscribe(
		"terminal",
		terminalDimensions{Cols: 80, Rows: 24},
		apply,
	)
	defer stopSmall()

	if err := reportLarge(120, 40); err != nil {
		t.Fatalf("reportLarge(120, 40) error = %v", err)
	}
	_ = readTerminalDimensions(t, largeUpdates)
	if err := reportSmall(80, 24); err != nil {
		t.Fatalf("reportSmall(80, 24) error = %v", err)
	}
	_ = readTerminalDimensions(t, largeUpdates)
	_ = readTerminalDimensions(t, smallUpdates)

	if err := releaseSmall(); err != nil {
		t.Fatalf("releaseSmall() error = %v", err)
	}
	if got := readTerminalDimensions(t, largeUpdates); got != (terminalDimensions{Cols: 120, Rows: 40}) {
		t.Fatalf("large dimensions after release = %#v, want 120x40", got)
	}
	if got := readTerminalDimensions(t, smallUpdates); got != (terminalDimensions{Cols: 120, Rows: 40}) {
		t.Fatalf("small dimensions after release = %#v, want 120x40", got)
	}

	if err := reportSmall(70, 20); err != nil {
		t.Fatalf("reportSmall(70, 20) error = %v", err)
	}
	for name, updates := range map[string]<-chan terminalDimensions{
		"large": largeUpdates,
		"small": smallUpdates,
	} {
		if got := readTerminalDimensions(t, updates); got != (terminalDimensions{Cols: 70, Rows: 20}) {
			t.Fatalf("%s dimensions after restore = %#v, want 70x20", name, got)
		}
	}

	wantApplied := []terminalDimensions{
		{Cols: 120, Rows: 40},
		{Cols: 80, Rows: 24},
		{Cols: 120, Rows: 40},
		{Cols: 70, Rows: 20},
	}
	if !reflect.DeepEqual(applied, wantApplied) {
		t.Fatalf("applied dimensions = %#v, want %#v", applied, wantApplied)
	}
}

func TestTerminalSizeCoordinatorPublishesAcceptedSizeDuringResize(t *testing.T) {
	coordinator := newTerminalSizeCoordinator()
	var updates <-chan terminalDimensions
	apply := func(cols, rows uint16, notify func()) error {
		notify()
		select {
		case got := <-updates:
			want := terminalDimensions{Cols: cols, Rows: rows}
			if got != want {
				t.Fatalf("published dimensions = %#v, want %#v", got, want)
			}
		default:
			t.Fatal("accepted dimensions were not published by the resize transaction")
		}
		return nil
	}
	report, _, accepted, stop := coordinator.subscribe(
		"terminal",
		terminalDimensions{Cols: 80, Rows: 24},
		apply,
	)
	updates = accepted
	defer stop()

	if err := report(120, 40); err != nil {
		t.Fatalf("report(120, 40) error = %v", err)
	}
	assertNoTerminalDimensions(t, updates)
}

func TestTerminalSizeCoordinatorDoesNotBlockDifferentTerminalsWhileResizeIsPending(t *testing.T) {
	applyStarted := make(chan struct{})
	releaseApply := make(chan struct{})
	apply := func(terminal string) func(uint16, uint16, func()) error {
		return func(cols, rows uint16, notify func()) error {
			if terminal == "a" {
				close(applyStarted)
				<-releaseApply
			}
			notify()
			return nil
		}
	}
	coordinator := newTerminalSizeCoordinator()
	reportA, _, _, stopA := coordinator.subscribe(
		"a",
		terminalDimensions{Cols: 80, Rows: 24},
		apply("a"),
	)
	defer stopA()

	aDone := make(chan error, 1)
	go func() {
		aDone <- reportA(120, 40)
	}()
	select {
	case <-applyStarted:
	case <-time.After(time.Second):
		t.Fatal("terminal A resize did not start")
	}

	type subscription struct {
		report  func(uint16, uint16) error
		updates <-chan terminalDimensions
		stop    func()
	}
	bDone := make(chan subscription, 1)
	go func() {
		reportB, _, updatesB, stopB := coordinator.subscribe(
			"b",
			terminalDimensions{Cols: 80, Rows: 24},
			apply("b"),
		)
		bDone <- subscription{report: reportB, updates: updatesB, stop: stopB}
	}()
	var b subscription
	select {
	case b = <-bDone:
	case <-time.After(100 * time.Millisecond):
		close(releaseApply)
		select {
		case <-aDone:
		case <-time.After(time.Second):
			t.Fatal("terminal A report did not finish after release")
		}
		select {
		case b = <-bDone:
			b.stop()
		case <-time.After(time.Second):
			t.Fatal("terminal B subscription did not finish after terminal A was released")
		}
		t.Fatal("terminal B report was blocked by terminal A resize")
	}
	defer b.stop()
	if err := b.report(100, 30); err != nil {
		t.Fatalf("terminal B report error = %v", err)
	}

	close(releaseApply)
	select {
	case err := <-aDone:
		if err != nil {
			t.Fatalf("terminal A report error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("terminal A report did not finish after release")
	}
	if got := readTerminalDimensions(t, b.updates); got != (terminalDimensions{Cols: 100, Rows: 30}) {
		t.Fatalf("terminal B dimensions = %#v, want 100x30", got)
	}
}
