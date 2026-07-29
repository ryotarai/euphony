//go:build !darwin && !linux

package session

import "errors"

func processWorkingDirectory(_ int) (string, error) {
	return "", errors.New("terminal process working directory is unsupported on this platform")
}
