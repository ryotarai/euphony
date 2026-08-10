package control

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/ryotarai/euphony/internal/session"
)

const MaxAgentInputBytes = 1024 * 1024

// EncodeBracketedPaste wraps text in the terminal protocol used to distinguish
// pasted content from a burst of individually typed key events.
func EncodeBracketedPaste(data []byte) []byte {
	encoded := make([]byte, 0, len(data)+len("\x1b[200~")+len("\x1b[201~"))
	encoded = append(encoded, "\x1b[200~"...)
	encoded = append(encoded, data...)
	encoded = append(encoded, "\x1b[201~"...)
	return encoded
}

var (
	ErrUnsupportedAgent    = errors.New("unsupported agent")
	ErrAgentNotRunning     = errors.New("agent not running")
	ErrAgentAlreadyRunning = errors.New("agent already running")
	ErrInvalidAgentState   = errors.New("invalid agent state")
	ErrInvalidAgentInput   = errors.New("invalid agent input")
)

func (s *Service) ListAgents() []session.Metadata {
	terminals := s.sessions.List()
	result := make([]session.Metadata, 0, len(terminals))
	for _, terminal := range terminals {
		if terminal.Agent != "" {
			result = append(result, terminal)
		}
	}
	return result
}

func (s *Service) GetAgent(terminalID string) (session.Metadata, error) {
	metadata, ok := s.sessions.Metadata(terminalID)
	if !ok {
		return session.Metadata{}, ErrTerminalNotFound
	}
	if metadata.Agent == "" {
		return session.Metadata{}, ErrAgentNotRunning
	}
	return metadata, nil
}

func (s *Service) StartAgent(
	ctx context.Context,
	terminalID, kind string,
	args []string,
) (session.Metadata, error) {
	if kind != "codex" && kind != "claude" {
		return session.Metadata{}, ErrUnsupportedAgent
	}
	metadata, err := s.GetTerminal(terminalID)
	if err != nil {
		return session.Metadata{}, err
	}
	if metadata.Agent != "" {
		return session.Metadata{}, ErrAgentAlreadyRunning
	}
	command, err := agentCommand(kind, args)
	if err != nil {
		return session.Metadata{}, err
	}
	events, unsubscribe := s.SubscribeEvents([]string{"agent.updated", "terminal.deleted"})
	defer unsubscribe()
	if err := s.runCommand(terminalID, command); err != nil {
		return session.Metadata{}, err
	}
	return s.waitAgentEvents(ctx, events, terminalID, kind, []string{"waiting", "blocked"}, false)
}

func (s *Service) PromptAgent(
	ctx context.Context,
	terminalID, prompt string,
	wait bool,
	until []string,
) (session.Metadata, error) {
	current, err := s.GetAgent(terminalID)
	if err != nil {
		return session.Metadata{}, err
	}
	if err := s.agentForeground(terminalID, current.Agent); err != nil {
		return session.Metadata{}, err
	}
	if prompt == "" || strings.IndexByte(prompt, 0) >= 0 ||
		len(prompt) > MaxAgentInputBytes {
		return session.Metadata{}, ErrInvalidAgentInput
	}
	accepted, err := normalizeAgentStates(until)
	if err != nil {
		return session.Metadata{}, err
	}
	events, unsubscribe := s.SubscribeEvents([]string{"agent.updated", "terminal.deleted"})
	defer unsubscribe()
	data := EncodeBracketedPaste([]byte(prompt))
	data = append(data, '\r')
	if err := s.sendInput(terminalID, TerminalInput{
		DataBase64: base64.RawStdEncoding.EncodeToString(data),
	}); err != nil {
		return session.Metadata{}, err
	}
	if !wait {
		return current, nil
	}
	return s.waitAgentEvents(
		ctx,
		events,
		terminalID,
		current.Agent,
		accepted,
		current.AgentStatus != "running",
	)
}

func (s *Service) SendAgentKeys(terminalID string, keys []string) (session.Metadata, error) {
	current, err := s.GetAgent(terminalID)
	if err != nil {
		return session.Metadata{}, err
	}
	if err := s.agentForeground(terminalID, current.Agent); err != nil {
		return session.Metadata{}, err
	}
	if err := s.sendInput(terminalID, TerminalInput{Keys: keys}); err != nil {
		return session.Metadata{}, err
	}
	return current, nil
}

func (s *Service) requireAgentForeground(terminalID, kind string) error {
	terminal, ok := s.sessions.Get(terminalID)
	if !ok {
		return ErrTerminalNotFound
	}
	command, err := terminal.ForegroundCommand()
	if errors.Is(err, session.ErrForegroundUnsupported) {
		isShell, shellErr := terminal.ForegroundIsShell()
		if shellErr != nil {
			return shellErr
		}
		if isShell {
			return ErrAgentNotRunning
		}
		return nil
	}
	if err != nil {
		return err
	}
	if !strings.Contains(strings.ToLower(command), kind) {
		return ErrAgentNotRunning
	}
	return nil
}

func (s *Service) WaitAgent(
	ctx context.Context,
	terminalID string,
	until []string,
) (session.Metadata, error) {
	accepted, err := normalizeAgentStates(until)
	if err != nil {
		return session.Metadata{}, err
	}
	events, unsubscribe := s.SubscribeEvents([]string{"agent.updated", "terminal.deleted"})
	defer unsubscribe()
	current, err := s.GetAgent(terminalID)
	if err != nil {
		return session.Metadata{}, err
	}
	if containsString(accepted, current.AgentStatus) {
		return current, nil
	}
	return s.waitAgentEvents(ctx, events, terminalID, current.Agent, accepted, false)
}

func (s *Service) waitAgentEvents(
	ctx context.Context,
	events <-chan Event,
	terminalID, expectedAgent string,
	accepted []string,
	requireRunning bool,
) (session.Metadata, error) {
	sawRunning := !requireRunning
	for {
		select {
		case event, open := <-events:
			if !open {
				return session.Metadata{}, ErrAgentNotRunning
			}
			switch event.Type {
			case "agent.updated":
				metadata, ok := event.Data.(session.Metadata)
				if !ok || metadata.ID != terminalID {
					continue
				}
				if metadata.Agent == "" {
					return session.Metadata{}, ErrAgentNotRunning
				}
				if metadata.Agent != expectedAgent {
					continue
				}
				if metadata.AgentStatus == "running" {
					sawRunning = true
				}
				if sawRunning && containsString(accepted, metadata.AgentStatus) {
					return metadata, nil
				}
			case "terminal.deleted":
				deleted, ok := event.Data.(map[string]string)
				if ok && deleted["id"] == terminalID {
					return session.Metadata{}, ErrAgentNotRunning
				}
			case "subscriber_lagged":
				return session.Metadata{}, ErrOutputSubscriberLagged
			}
		case <-ctx.Done():
			return session.Metadata{}, ctx.Err()
		}
	}
}

func normalizeAgentStates(states []string) ([]string, error) {
	if len(states) == 0 {
		return []string{"waiting", "blocked"}, nil
	}
	result := make([]string, 0, len(states))
	for _, state := range states {
		if state != "running" && state != "waiting" && state != "blocked" {
			return nil, fmt.Errorf("%w: %q", ErrInvalidAgentState, state)
		}
		if !containsString(result, state) {
			result = append(result, state)
		}
	}
	return result, nil
}

func agentCommand(kind string, args []string) (string, error) {
	if kind != "codex" && kind != "claude" {
		return "", ErrUnsupportedAgent
	}
	var command strings.Builder
	command.WriteString(kind)
	for _, argument := range args {
		if strings.IndexByte(argument, 0) >= 0 {
			return "", ErrInvalidAgentInput
		}
		command.WriteByte(' ')
		command.WriteByte('\'')
		command.WriteString(strings.ReplaceAll(argument, "'", "'\"'\"'"))
		command.WriteByte('\'')
		if command.Len() > MaxAgentInputBytes {
			return "", ErrInvalidAgentInput
		}
	}
	return command.String(), nil
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
