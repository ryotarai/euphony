package agentsummary

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/session"
)

const (
	commandTimeout                 = 90 * time.Second
	maxCommandOutputBytes          = 64 << 10
	maxGeneratedDescriptionRunes   = 2400
	openAIModel                    = "gpt-5.6-luna"
	openAIEndpoint                 = "https://api.openai.com/v1/responses"
	openAISchemaName               = "agent_summary"
	openAITerminalActionSchemaName = "terminal_action"
)

type Generation struct {
	Summary  string                       `json:"summary"`
	Action   string                       `json:"action"`
	Priority string                       `json:"priority"`
	Options  []session.AgentSummaryOption `json:"options"`
}

type TerminalActionGeneration struct {
	Input string `json:"input"`
}

type TaskRefinement struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    string `json:"priority"`
	Status      string `json:"status"`
	Rationale   string `json:"rationale"`
}

type Runner interface {
	Generate(context.Context, string, string) (Generation, error)
}

type EffortRunner interface {
	GenerateWithEffort(context.Context, string, string, string) (Generation, error)
}

type ActionRunner interface {
	GenerateTerminalAction(context.Context, string, string, string) (TerminalActionGeneration, error)
}

type Refiner interface {
	Refine(context.Context, string, string) (TaskRefinement, error)
}

type commandFactory func(context.Context, string, ...string) *exec.Cmd

type CommandRunner struct {
	commandContext commandFactory
	timeout        time.Duration
	httpClient     *http.Client
	openAIEndpoint string
}

func NewCommandRunner() *CommandRunner {
	return &CommandRunner{
		commandContext: exec.CommandContext,
		timeout:        commandTimeout,
		httpClient:     http.DefaultClient,
		openAIEndpoint: openAIEndpoint,
	}
}

func commandSpec(provider string, schemaPath ...string) (string, []string, error) {
	switch provider {
	case "claude":
		return "claude", []string{
			"-p", "--bare", "--json-schema", string(sharedSummarySchemaJSON()),
			"--model", "haiku", "--effort", "low",
		}, nil
	case "codex":
		path := "<summary-schema>"
		if len(schemaPath) > 0 && schemaPath[0] != "" {
			path = schemaPath[0]
		}
		return "codex", []string{
			"-c", "model_reasoning_effort=low", "-c", "service_tier=standard",
			"exec", "--ephemeral", "--model", openAIModel, "--output-schema", path,
		}, nil
	default:
		return "", nil, fmt.Errorf("unsupported summary provider %q", provider)
	}
}

func actionCommandSpec(provider string, schemaPath ...string) (string, []string, error) {
	schemaPathValue := "<terminal-action-schema>"
	if len(schemaPath) > 0 && schemaPath[0] != "" {
		schemaPathValue = schemaPath[0]
	}
	switch provider {
	case "claude":
		return "claude", []string{
			"-p", "--bare", "--json-schema", string(sharedTerminalActionSchemaJSON()),
			"--model", "haiku", "--effort", "low",
		}, nil
	case "codex":
		return "codex", []string{
			"-c", "model_reasoning_effort=low", "-c", "service_tier=standard",
			"exec", "--ephemeral", "--model", openAIModel, "--output-schema", schemaPathValue,
		}, nil
	default:
		return "", nil, fmt.Errorf("unsupported action provider %q", provider)
	}
}

func refinementCommandSpec(provider string) (string, []string, error) {
	switch provider {
	case "claude":
		return "claude", []string{"-p", "--model", "haiku", "--effort", "low"}, nil
	case "codex":
		return "codex", []string{"-c", "model_reasoning_effort=low", "-c", "service_tier=standard", "exec", "--model", openAIModel}, nil
	default:
		return "", nil, fmt.Errorf("unsupported summary provider %q", provider)
	}
}

func (r *CommandRunner) Generate(ctx context.Context, provider, prompt string) (Generation, error) {
	return r.GenerateWithEffort(ctx, provider, prompt, session.DefaultAgentSummaryOpenAIEffort)
}

func (r *CommandRunner) GenerateWithEffort(ctx context.Context, provider, prompt, effort string) (Generation, error) {
	if provider == "openai" {
		return r.generateOpenAI(ctx, prompt, effort)
	}
	return r.generateCommand(ctx, provider, prompt)
}

func (r *CommandRunner) GenerateTerminalAction(ctx context.Context, provider, prompt, effort string) (TerminalActionGeneration, error) {
	if provider == "openai" {
		output, err := r.generateOpenAIJSON(ctx, prompt, effort, openAITerminalActionSchemaName, sharedTerminalActionSchema())
		if err != nil {
			return TerminalActionGeneration{}, err
		}
		return ParseTerminalAction(output)
	}

	schema := sharedTerminalActionSchemaJSON()
	schemaPath := ""
	if provider == "codex" {
		file, err := os.CreateTemp("", "euphony-terminal-action-*.json")
		if err != nil {
			return TerminalActionGeneration{}, fmt.Errorf("create terminal action schema: %w", err)
		}
		schemaPath = file.Name()
		defer os.Remove(schemaPath)
		if _, err := file.Write(schema); err != nil {
			_ = file.Close()
			return TerminalActionGeneration{}, fmt.Errorf("write terminal action schema: %w", err)
		}
		if err := file.Close(); err != nil {
			return TerminalActionGeneration{}, fmt.Errorf("close terminal action schema: %w", err)
		}
	}
	name, args, err := actionCommandSpec(provider, schemaPath)
	if err != nil {
		return TerminalActionGeneration{}, err
	}
	output, err := r.runCommandOutput(ctx, provider, prompt, name, args, "terminal action")
	if err != nil {
		return TerminalActionGeneration{}, err
	}
	return ParseTerminalAction(output)
}

func (r *CommandRunner) generateCommand(ctx context.Context, provider, prompt string) (Generation, error) {
	schemaPath := ""
	if provider == "codex" {
		file, err := os.CreateTemp("", "euphony-agent-summary-*.json")
		if err != nil {
			return Generation{}, fmt.Errorf("create summary schema: %w", err)
		}
		schemaPath = file.Name()
		defer os.Remove(schemaPath)
		if _, err := file.Write(sharedSummarySchemaJSON()); err != nil {
			_ = file.Close()
			return Generation{}, fmt.Errorf("write summary schema: %w", err)
		}
		if err := file.Close(); err != nil {
			return Generation{}, fmt.Errorf("close summary schema: %w", err)
		}
	}
	name, args, err := commandSpec(provider, schemaPath)
	if err != nil {
		return Generation{}, err
	}
	return r.runCommand(ctx, provider, prompt, name, args)
}

func (r *CommandRunner) runCommand(ctx context.Context, provider, prompt, name string, args []string) (Generation, error) {
	output, err := r.runCommandOutput(ctx, provider, prompt, name, args, "summary")
	if err != nil {
		return Generation{}, err
	}
	return ParseGeneration(output, "")
}

func (r *CommandRunner) runCommandOutput(ctx context.Context, provider, prompt, name string, args []string, outputKind string) (string, error) {
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
		return "", fmt.Errorf("%s %s command failed: %s", provider, outputKind, message)
	}
	if stdout.truncated {
		return "", fmt.Errorf("%s command output exceeded the limit", outputKind)
	}
	return stdout.String(), nil
}

func (r *CommandRunner) Refine(ctx context.Context, provider, prompt string) (TaskRefinement, error) {
	name, args, err := refinementCommandSpec(provider)
	if err != nil {
		return TaskRefinement{}, err
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
		return TaskRefinement{}, fmt.Errorf("%s refinement command failed: %s", provider, message)
	}
	if stdout.truncated {
		return TaskRefinement{}, errors.New("refinement command output exceeded the limit")
	}
	return ParseRefinement(stdout.String())
}

func sharedSummarySchema() map[string]any {
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"summary": map[string]any{"type": "string"},
			"action":  map[string]any{"type": "string"},
			"priority": map[string]any{
				"type": "string",
				"enum": []string{"high", "medium", "low", ""},
			},
			"options": map[string]any{
				"type":     "array",
				"maxItems": 4,
				"items": map[string]any{
					"type":                 "object",
					"additionalProperties": false,
					"properties": map[string]any{
						"label": map[string]any{"type": "string"},
						"input": map[string]any{"type": "string"},
					},
					"required": []string{"label", "input"},
				},
			},
		},
		"required": []string{"summary", "action", "priority", "options"},
	}
}

func sharedSummarySchemaJSON() []byte {
	encoded, _ := json.Marshal(sharedSummarySchema())
	return encoded
}

func sharedTerminalActionSchema() map[string]any {
	return map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"input": map[string]any{"type": "string", "minLength": 1},
		},
		"required": []string{"input"},
	}
}

func sharedTerminalActionSchemaJSON() []byte {
	encoded, _ := json.Marshal(sharedTerminalActionSchema())
	return encoded
}

func (r *CommandRunner) generateOpenAI(ctx context.Context, prompt, effort string) (Generation, error) {
	output, err := r.generateOpenAIJSON(ctx, prompt, effort, openAISchemaName, sharedSummarySchema())
	if err != nil {
		return Generation{}, err
	}
	return ParseGeneration(output, "")
}

func (r *CommandRunner) generateOpenAIJSON(
	ctx context.Context,
	prompt string,
	effort string,
	schemaName string,
	schema map[string]any,
) (string, error) {
	apiKey := strings.TrimSpace(os.Getenv("OPENAI_API_KEY"))
	if apiKey == "" {
		return "", errors.New("OPENAI_API_KEY is not configured")
	}
	if effort == "" {
		effort = session.DefaultAgentSummaryOpenAIEffort
	}
	requestBody := struct {
		Model     string `json:"model"`
		Input     string `json:"input"`
		Store     bool   `json:"store"`
		Reasoning struct {
			Effort string `json:"effort"`
		} `json:"reasoning"`
		Text struct {
			Format struct {
				Type   string         `json:"type"`
				Name   string         `json:"name"`
				Strict bool           `json:"strict"`
				Schema map[string]any `json:"schema"`
			} `json:"format"`
		} `json:"text"`
	}{
		Model: openAIModel,
		Input: prompt,
		Store: false,
	}
	requestBody.Reasoning.Effort = effort
	requestBody.Text.Format.Type = "json_schema"
	requestBody.Text.Format.Name = schemaName
	requestBody.Text.Format.Strict = true
	requestBody.Text.Format.Schema = schema
	body, err := json.Marshal(requestBody)
	if err != nil {
		return "", fmt.Errorf("encode OpenAI request: %w", err)
	}
	timeout := r.timeout
	if timeout <= 0 {
		timeout = commandTimeout
	}
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, r.openAIURL(), bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create OpenAI request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+apiKey)
	request.Header.Set("Content-Type", "application/json")
	client := r.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return "", fmt.Errorf("OpenAI Responses request failed: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return "", fmt.Errorf("OpenAI Responses API returned status %d", response.StatusCode)
	}
	var decoded struct {
		OutputText string `json:"output_text"`
		Output     []struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, maxCommandOutputBytes))
	if err := decoder.Decode(&decoded); err != nil {
		return "", fmt.Errorf("decode OpenAI response: %w", err)
	}
	output := decoded.OutputText
	if output == "" {
		for _, item := range decoded.Output {
			for _, content := range item.Content {
				if content.Type == "output_text" || content.Type == "" {
					output = content.Text
					if output != "" {
						break
					}
				}
			}
			if output != "" {
				break
			}
		}
	}
	if strings.TrimSpace(output) == "" {
		return "", errors.New("OpenAI Responses API returned no structured output")
	}
	return output, nil
}

func (r *CommandRunner) openAIURL() string {
	if r.openAIEndpoint != "" {
		return r.openAIEndpoint
	}
	return openAIEndpoint
}

func ParseGeneration(output, status string) (Generation, error) {
	cleaned, err := extractJSONObject(output, "summary command")
	if err != nil {
		return Generation{}, err
	}
	var generation Generation
	if err := json.Unmarshal([]byte(cleaned), &generation); err != nil {
		return Generation{}, fmt.Errorf("decode summary command output: %w", err)
	}
	return normalizeGeneration(generation, status)
}

func ParseTerminalAction(output string) (TerminalActionGeneration, error) {
	cleaned, err := extractJSONObject(output, "terminal action")
	if err != nil {
		return TerminalActionGeneration{}, err
	}
	var generation TerminalActionGeneration
	if err := json.Unmarshal([]byte(cleaned), &generation); err != nil {
		return TerminalActionGeneration{}, fmt.Errorf("decode terminal action output: %w", err)
	}
	if strings.TrimSpace(generation.Input) == "" {
		return TerminalActionGeneration{}, errors.New("terminal action returned empty input")
	}
	if strings.IndexByte(generation.Input, 0) >= 0 {
		return TerminalActionGeneration{}, errors.New("terminal action returned input containing NUL")
	}
	generation.Input = normalizeTerminalActionInput(generation.Input)
	if len(generation.Input) > control.MaxTerminalInputBytes {
		return TerminalActionGeneration{}, errors.New("terminal action returned input exceeding the limit")
	}
	return generation, nil
}

func normalizeTerminalActionInput(input string) string {
	if strings.HasSuffix(input, "\r") {
		return input
	}
	if strings.HasSuffix(input, "\n") {
		return strings.TrimSuffix(input, "\n") + "\r"
	}
	if len(input) > 0 && input[0] < 0x20 && input[0] != '\t' {
		return input
	}
	return input + "\r"
}

func extractJSONObject(output, source string) (string, error) {
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
		return "", fmt.Errorf("%s did not return a JSON object", source)
	}
	return cleaned[start : end+1], nil
}

func normalizeGeneration(generation Generation, status string) (Generation, error) {
	generation.Summary = normalizeGeneratedText(generation.Summary, maxGeneratedSummaryRunes)
	generation.Action = normalizeGeneratedText(generation.Action, maxGeneratedActionRunes)
	generation.Priority = strings.ToLower(strings.TrimSpace(generation.Priority))
	options, err := normalizeGenerationOptions(generation.Options)
	if err != nil {
		return Generation{}, err
	}
	generation.Options = options
	if generation.Summary == "" {
		return Generation{}, errors.New("summary command returned an empty summary")
	}
	if status == "running" {
		generation.Action = ""
		generation.Priority = ""
		generation.Options = nil
	} else if status != "" {
		if generation.Action == "" {
			return Generation{}, errors.New("summary command returned no required action")
		}
		if !validActionPriority(generation.Priority) {
			return Generation{}, fmt.Errorf("summary command returned invalid action priority %q", generation.Priority)
		}
		if len(generation.Options) == 0 {
			return Generation{}, errors.New("summary command returned no required options")
		}
	}
	return generation, nil
}

func normalizeGenerationOptions(options []session.AgentSummaryOption) ([]session.AgentSummaryOption, error) {
	if len(options) == 0 {
		return nil, nil
	}
	if len(options) > 4 {
		return nil, errors.New("summary command returned too many options")
	}
	result := make([]session.AgentSummaryOption, len(options))
	for index, option := range options {
		option.Label = normalizeGeneratedText(option.Label, maxGeneratedActionRunes)
		if option.Label == "" {
			return nil, errors.New("summary command returned an empty option label")
		}
		if option.Input == "" {
			return nil, errors.New("summary command returned an empty option input")
		}
		if strings.IndexByte(option.Input, 0) >= 0 {
			return nil, errors.New("summary command returned an option input containing NUL")
		}
		if len(option.Input) > control.MaxTerminalInputBytes {
			return nil, errors.New("summary command returned an option input exceeding the limit")
		}
		option.ID = fmt.Sprintf("option-%d", index+1)
		result[index] = option
	}
	return result, nil
}

func validActionPriority(value string) bool {
	switch value {
	case "high", "medium", "low":
		return true
	default:
		return false
	}
}

func ParseRefinement(output string) (TaskRefinement, error) {
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
		return TaskRefinement{}, errors.New("refinement command did not return a JSON object")
	}
	var raw struct {
		Title       *string `json:"title"`
		Description *string `json:"description"`
		Priority    *string `json:"priority"`
		Status      *string `json:"status"`
		Rationale   string  `json:"rationale"`
	}
	if err := json.Unmarshal([]byte(cleaned[start:end+1]), &raw); err != nil {
		return TaskRefinement{}, fmt.Errorf("decode refinement command output: %w", err)
	}
	if raw.Title == nil || raw.Description == nil || raw.Priority == nil || raw.Status == nil {
		return TaskRefinement{}, errors.New("refinement command omitted a required field")
	}
	refinement := TaskRefinement{
		Title:       normalizeGeneratedText(*raw.Title, maxGeneratedSummaryRunes),
		Description: normalizeGeneratedText(*raw.Description, maxGeneratedDescriptionRunes),
		Priority:    strings.TrimSpace(*raw.Priority),
		Status:      strings.TrimSpace(*raw.Status),
		Rationale:   normalizeGeneratedText(raw.Rationale, maxGeneratedActionRunes),
	}
	if refinement.Title == "" {
		return TaskRefinement{}, errors.New("refinement command returned an empty title")
	}
	if refinement.Priority != "low" && refinement.Priority != "medium" && refinement.Priority != "high" {
		return TaskRefinement{}, fmt.Errorf("refinement command returned invalid priority %q", refinement.Priority)
	}
	if refinement.Status != "todo" && refinement.Status != "in_progress" &&
		refinement.Status != "blocked" && refinement.Status != "done" {
		return TaskRefinement{}, fmt.Errorf("refinement command returned invalid status %q", refinement.Status)
	}
	return refinement, nil
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
