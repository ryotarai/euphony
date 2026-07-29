//go:build linux

package session

import (
	"os"
	"strconv"
)

func processWorkingDirectory(pid int) (string, error) {
	return os.Readlink("/proc/" + strconv.Itoa(pid) + "/cwd")
}
