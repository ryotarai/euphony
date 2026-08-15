package server

import (
	"context"
	"errors"
	"testing"
)

func TestPickDirectoryForWindowsUsesNativePicker(t *testing.T) {
	directory := t.TempDir()
	pickerCalls := 0

	path, err := pickDirectoryForOS("windows", context.Background(), func(context.Context) (string, error) {
		pickerCalls++
		return directory, nil
	})
	if err != nil {
		t.Fatalf("pickDirectoryForOS() error = %v", err)
	}
	if pickerCalls != 1 || path != directory {
		t.Fatalf("picker calls/path = %d/%q, want 1/%q", pickerCalls, path, directory)
	}
}

func TestPickDirectoryForWindowsPreservesNativeCancellation(t *testing.T) {
	_, err := pickDirectoryForOS("windows", context.Background(), func(context.Context) (string, error) {
		return "", errDirectoryPickerCanceled
	})
	if !errors.Is(err, errDirectoryPickerCanceled) {
		t.Fatalf("error = %v, want errDirectoryPickerCanceled", err)
	}
}
