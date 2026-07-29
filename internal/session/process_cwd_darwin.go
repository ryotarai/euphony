//go:build darwin

package session

import (
	"errors"
	"os/exec"
	"strconv"
	"strings"
)

func processWorkingDirectory(pid int) (string, error) {
	executable, err := exec.LookPath("lsof")
	if err != nil {
		executable = "/usr/sbin/lsof"
	}
	output, err := exec.Command(executable, "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn").Output()
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(output), "\n") {
		if strings.HasPrefix(line, "n") && len(line) > 1 {
			return strings.TrimPrefix(line, "n"), nil
		}
	}
	return "", errors.New("terminal process working directory was not reported")
}
