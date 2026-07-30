//go:build !aix && !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd && !solaris

package workspacefiles

import "os"

const secureReadOnlyFlags = os.O_RDONLY
