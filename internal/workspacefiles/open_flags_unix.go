//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package workspacefiles

import (
	"os"
	"syscall"
)

const secureReadOnlyFlags = os.O_RDONLY | syscall.O_NONBLOCK
