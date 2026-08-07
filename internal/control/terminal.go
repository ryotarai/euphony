package control

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

const (
	DefaultTerminalReadBytes = 1024 * 1024
	MaxTerminalReadBytes     = 16 * 1024 * 1024
	MaxTerminalInputBytes    = 1024 * 1024
)

var (
	ErrTerminalNotFound       = errors.New("terminal not found")
	ErrTerminalBusy           = errors.New("terminal foreground is busy")
	ErrTerminalClosed         = errors.New("terminal output closed")
	ErrInvalidInput           = errors.New("invalid terminal input")
	ErrInvalidKey             = errors.New("invalid terminal key")
	ErrInvalidOutputMatch     = errors.New("invalid output match")
	ErrOutputSubscriberLagged = errors.New("terminal output subscriber lagged")
)

var (
	ansiCSI = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
	ansiOSC = regexp.MustCompile(`\x1b\][^\x07]*(?:\x07|\x1b\\)`)
)

type TerminalRead struct {
	TerminalID string `json:"terminalId"`
	DataBase64 string `json:"dataBase64"`
	Text       string `json:"text"`
	ByteCount  int    `json:"byteCount"`
	Truncated  bool   `json:"truncated"`
}

type TerminalInput struct {
	Text       *string  `json:"text,omitempty"`
	DataBase64 string   `json:"dataBase64,omitempty"`
	Keys       []string `json:"keys,omitempty"`
}

type OutputMatch struct {
	Literal  string
	Regex    string
	MaxBytes int
}

type WaitOutputResult struct {
	TerminalID  string       `json:"terminalId"`
	MatchedLine string       `json:"matchedLine"`
	Read        TerminalRead `json:"read"`
}

type SelectionMode string

const (
	SelectionNone    SelectionMode = "none"
	SelectionAdd     SelectionMode = "add"
	SelectionReplace SelectionMode = "replace"
)

func (s *Service) ListTerminals() []session.Metadata {
	return s.sessions.List()
}

func (s *Service) GetTerminal(id string) (session.Metadata, error) {
	metadata, ok := s.sessions.Metadata(id)
	if !ok {
		return session.Metadata{}, ErrTerminalNotFound
	}
	return metadata, nil
}

func (s *Service) RenameTerminal(id, name string) (session.Metadata, error) {
	metadata, err := s.sessions.Rename(id, name)
	if errors.Is(err, session.ErrNotFound) {
		return session.Metadata{}, ErrTerminalNotFound
	}
	return metadata, err
}

func (s *Service) CreateTerminal(
	ctx context.Context,
	name, cwd string,
	mode SelectionMode,
) (session.Metadata, selection.Snapshot, error) {
	if mode == "" {
		mode = SelectionNone
	}
	if mode != SelectionNone && mode != SelectionAdd && mode != SelectionReplace {
		return session.Metadata{}, selection.Snapshot{}, ErrInvalidInput
	}
	metadata, err := s.sessions.Create(ctx, name, cwd)
	if err != nil {
		return session.Metadata{}, selection.Snapshot{}, err
	}
	if mode == SelectionNone {
		return metadata, s.Selection(), nil
	}
	actionType := selection.ActionAdd
	if mode == SelectionReplace {
		actionType = selection.ActionReplace
	}
	snapshot, err := s.ApplySelection(ctx, selection.Action{
		Type:              actionType,
		TerminalIDs:       []string{metadata.ID},
		FocusedTerminalID: metadata.ID,
	})
	if err != nil {
		_ = s.sessions.Delete(metadata.ID)
		return session.Metadata{}, selection.Snapshot{}, err
	}
	return metadata, snapshot, nil
}

func (s *Service) DeleteTerminal(id string) (selection.Snapshot, error) {
	if err := s.sessions.Delete(id); err != nil {
		if errors.Is(err, session.ErrNotFound) {
			return selection.Snapshot{}, ErrTerminalNotFound
		}
		return selection.Snapshot{}, err
	}
	return s.Selection(), nil
}

func (s *Service) ReadTerminal(id string, maxBytes int) (TerminalRead, error) {
	terminal, ok := s.sessions.Get(id)
	if !ok {
		return TerminalRead{}, ErrTerminalNotFound
	}
	maxBytes = normalizeReadLimit(maxBytes)
	data, truncated := terminal.HistorySnapshot(maxBytes)
	return terminalRead(id, data, truncated), nil
}

func (s *Service) SendTerminalInput(id string, input TerminalInput) error {
	_, ok := s.sessions.Get(id)
	if !ok {
		return ErrTerminalNotFound
	}
	sources := 0
	if input.Text != nil {
		sources++
	}
	if input.DataBase64 != "" {
		sources++
	}
	if len(input.Keys) > 0 {
		sources++
	}
	if sources != 1 {
		return ErrInvalidInput
	}
	var data []byte
	var err error
	switch {
	case input.Text != nil:
		data = []byte(*input.Text)
	case input.DataBase64 != "":
		data, err = base64.RawStdEncoding.DecodeString(input.DataBase64)
		if err != nil {
			return fmt.Errorf("%w: invalid base64", ErrInvalidInput)
		}
	default:
		data, err = EncodeKeys(input.Keys)
		if err != nil {
			return err
		}
	}
	if len(data) == 0 || len(data) > MaxTerminalInputBytes {
		return ErrInvalidInput
	}
	return s.SendTerminalBytes(id, data)
}

// SendTerminalBytes writes raw terminal input and lets the session manager
// reconcile a Codex interrupt from its transcript. The WebSocket terminal path
// uses this too, so browser input and automation share the same lifecycle.
func (s *Service) SendTerminalBytes(id string, data []byte) error {
	if _, err := s.sessions.WriteTerminal(id, data); errors.Is(err, session.ErrNotFound) {
		return ErrTerminalNotFound
	} else if err != nil {
		return err
	}
	return nil
}

func (s *Service) RunTerminal(id, command string) error {
	if command == "" || strings.IndexByte(command, 0) >= 0 ||
		len(command) > MaxTerminalInputBytes {
		return ErrInvalidInput
	}
	terminal, ok := s.sessions.Get(id)
	if !ok {
		return ErrTerminalNotFound
	}
	available, err := terminal.ForegroundIsShell()
	if err != nil {
		return err
	}
	if !available {
		return ErrTerminalBusy
	}
	_, err = terminal.Write(append([]byte(command), '\r'))
	return err
}

func (s *Service) WaitOutput(
	ctx context.Context,
	id string,
	match OutputMatch,
) (WaitOutputResult, error) {
	terminal, ok := s.sessions.Get(id)
	if !ok {
		return WaitOutputResult{}, ErrTerminalNotFound
	}
	matcher, err := compileOutputMatcher(match)
	if err != nil {
		return WaitOutputResult{}, err
	}
	maxBytes := normalizeReadLimit(match.MaxBytes)
	history, output, lagged, unsubscribe := terminal.SubscribeWithStatus()
	defer unsubscribe()
	historyBytes := joinChunks(history)
	truncated := len(historyBytes) > maxBytes
	buffer := historyBytes
	if truncated {
		buffer = append([]byte(nil), historyBytes[len(historyBytes)-maxBytes:]...)
	}
	if line, ok := matcher(buffer); ok {
		return waitResult(id, buffer, truncated, line), nil
	}
	for {
		select {
		case data, open := <-output:
			if !open {
				select {
				case <-lagged:
					return WaitOutputResult{}, ErrOutputSubscriberLagged
				default:
				}
				return WaitOutputResult{}, ErrTerminalClosed
			}
			buffer = append(buffer, data...)
			if len(buffer) > maxBytes {
				buffer = append([]byte(nil), buffer[len(buffer)-maxBytes:]...)
				truncated = true
			}
			if line, matched := matcher(buffer); matched {
				return waitResult(id, buffer, truncated, line), nil
			}
		case <-lagged:
			return WaitOutputResult{}, ErrOutputSubscriberLagged
		case <-ctx.Done():
			return WaitOutputResult{}, ctx.Err()
		}
	}
}

func EncodeKeys(keys []string) ([]byte, error) {
	result := make([]byte, 0, len(keys)*3)
	for _, key := range keys {
		lower := strings.ToLower(strings.TrimSpace(key))
		switch lower {
		case "enter", "return":
			result = append(result, '\r')
		case "esc", "escape":
			result = append(result, 0x1b)
		case "tab":
			result = append(result, '\t')
		case "backspace":
			result = append(result, 0x7f)
		case "up":
			result = append(result, "\x1b[A"...)
		case "down":
			result = append(result, "\x1b[B"...)
		case "right":
			result = append(result, "\x1b[C"...)
		case "left":
			result = append(result, "\x1b[D"...)
		case "home":
			result = append(result, "\x1b[H"...)
		case "end":
			result = append(result, "\x1b[F"...)
		case "delete":
			result = append(result, "\x1b[3~"...)
		case "pageup":
			result = append(result, "\x1b[5~"...)
		case "pagedown":
			result = append(result, "\x1b[6~"...)
		default:
			if len(lower) == len("ctrl+a") &&
				strings.HasPrefix(lower, "ctrl+") &&
				lower[len(lower)-1] >= 'a' &&
				lower[len(lower)-1] <= 'z' {
				result = append(result, lower[len(lower)-1]-'a'+1)
				continue
			}
			return nil, fmt.Errorf("%w: %q", ErrInvalidKey, key)
		}
	}
	if len(result) == 0 {
		return nil, ErrInvalidKey
	}
	return result, nil
}

func compileOutputMatcher(match OutputMatch) (func([]byte) (string, bool), error) {
	if (match.Literal == "") == (match.Regex == "") {
		return nil, ErrInvalidOutputMatch
	}
	var expression *regexp.Regexp
	if match.Regex != "" {
		var err error
		expression, err = regexp.Compile(match.Regex)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidOutputMatch, err)
		}
	}
	return func(data []byte) (string, bool) {
		text := stripANSIText(data)
		text = strings.ReplaceAll(text, "\r", "")
		for _, line := range strings.Split(text, "\n") {
			if (expression != nil && expression.MatchString(line)) ||
				(expression == nil && strings.Contains(line, match.Literal)) {
				return line, true
			}
		}
		return "", false
	}, nil
}

func stripANSIText(data []byte) string {
	withoutOSC := ansiOSC.ReplaceAll(data, nil)
	withoutCSI := ansiCSI.ReplaceAll(withoutOSC, nil)
	return strings.ToValidUTF8(string(withoutCSI), "\uFFFD")
}

func normalizeReadLimit(limit int) int {
	if limit <= 0 {
		return DefaultTerminalReadBytes
	}
	if limit > MaxTerminalReadBytes {
		return MaxTerminalReadBytes
	}
	return limit
}

func terminalRead(id string, data []byte, truncated bool) TerminalRead {
	return TerminalRead{
		TerminalID: id,
		DataBase64: base64.RawStdEncoding.EncodeToString(data),
		Text:       stripANSIText(data),
		ByteCount:  len(data),
		Truncated:  truncated,
	}
}

func waitResult(id string, data []byte, truncated bool, line string) WaitOutputResult {
	return WaitOutputResult{
		TerminalID:  id,
		MatchedLine: line,
		Read:        terminalRead(id, data, truncated),
	}
}

func joinChunks(chunks [][]byte) []byte {
	return bytes.Join(chunks, nil)
}
