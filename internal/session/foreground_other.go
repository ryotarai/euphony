//go:build !darwin && !linux

package session

func (s *Session) ForegroundIsShell() (bool, error) {
	return false, ErrForegroundUnsupported
}
