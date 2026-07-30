//go:build !darwin && !linux

package session

func (s *Session) ForegroundIsShell() (bool, error) {
	return false, ErrForegroundUnsupported
}

func (s *Session) ForegroundCommand() (string, error) {
	return "", ErrForegroundUnsupported
}
