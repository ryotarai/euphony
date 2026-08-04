package agentsummary

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	commandTimeout        = 90 * time.Second
	maxCommandOutputBytes = 64 << 10
)

type Generation struct {
	Summary string `json:"summary"`
	Action  string `json:"action"`
}

type Runner interface {
	Generate(context.Context, string, string) (Generation, error)
}

type commandFactory func(context.Context, string, ...string) *exec.Cmd

type CommandRunner struct {
	commandContext commandFactory
	timeout        time.Duration
}

func NewCommandRunner() *CommandRunner {
	return &CommandRunner{
		commandContext: exec.CommandContext,
		timeout:        commandTimeout,
	}
}

func commandSpec(provider string) (string, []string, error) {
	switch provider {
	case "claude":
		return "claude", []string{"-p", "--model", "haiku", "--effort", "none"}, nil
	case "codex":
		return "codex", []string{"exec", "--model", "gpt-5.6-low", "--effort", "none"}, nil
	default:
		return "", nil, fmt.Errorf("unsupported summary provider %q", provider)
	}
}

func (r *CommandRunner) Generate(ctx context.Context, provider, prompt string) (Generation, error) {
	name, args, err := commandSpec(provider)
	if err != nil {
		return Generation{}, err
	}
	timeout := r.timeout
	if timeout <= 0 {
		timeout = commandTimeout
	}
	commandContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := r.commandContext(commandContext, name, args...)
	command.Stdin = strings.NewReader(prompt)
	stdout := &cappedBuffer{limit: maxCommandOutputBytes}
	stderr := &cappedBuffer{limit: maxCommandOutputBytes}
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return Generation{}, fmt.Errorf("%s summary command failed: %s", provider, message)
	}
	if stdout.truncated {
		return Generation{}, errors.New("summary command output exceeded the limit")
	}
	return ParseGeneration(stdout.String(), "")
}

func ParseGeneration(output, status string) (Generation, error) {
	cleaned := strings.TrimSpace(output)
	if strings.HasPrefix(cleaned, "```") {
		lines := strings.Split(cleaned, "\n")
		if len(lines) >= 3 {
			cleaned = strings.Join(lines[1:len(lines)-1], "\n")
		}
	}
	start := strings.IndexByte(cleaned, '{')
	end := strings.LastIndexByte(cleaned, '}')
	if start < 0 || end <= start {
		return Generation{}, errors.New("summary command did not return a JSON object")
	}
	var generation Generation
	if err := json.Unmarshal([]byte(cleaned[start:end+1]), &generation); err != nil {
		return Generation{}, fmt.Errorf("decode summary command output: %w", err)
	}
	generation.Summary = normalizeGeneratedText(generation.Summary, maxGeneratedSummaryRunes)
	generation.Action = normalizeGeneratedText(generation.Action, maxGeneratedActionRunes)
	if generation.Summary == "" {
		return Generation{}, errors.New("summary command returned an empty summary")
	}
	if status == "running" {
		generation.Action = ""
	} else if status != "" && generation.Action == "" {
		return Generation{}, errors.New("summary command returned no required action")
	}
	return generation, nil
}

func normalizeGeneratedText(value string, limit int) string {
	value = strings.Join(strings.Fields(value), " ")
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}

type cappedBuffer struct {
	bytes.Buffer
	limit     int
	truncated bool
}

func (b *cappedBuffer) Write(data []byte) (int, error) {
	remaining := b.limit - b.Len()
	if remaining > 0 {
		if len(data) > remaining {
			_, _ = b.Buffer.Write(data[:remaining])
			b.truncated = true
		} else {
			_, _ = b.Buffer.Write(data)
		}
	} else if len(data) > 0 {
		b.truncated = true
	}
	return len(data), nil
}
