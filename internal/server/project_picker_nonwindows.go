//go:build !windows

package server

import "context"

func pickDirectoryNativeWindows(context.Context) (string, error) {
	return "", errDirectoryPickerUnavailable
}
