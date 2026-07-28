package setup

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	HomeDir    string
	CodexDir   string
	ClaudeDir  string
	Executable string
	Path       string
}

type Result struct {
	Installed []string
}

type hookSpec struct {
	event  string
	status string
}

var agentHooks = map[string][]hookSpec{
	"codex": {
		{event: "SessionStart", status: "waiting"},
		{event: "UserPromptSubmit", status: "running"},
		{event: "PreToolUse", status: "running"},
		{event: "PermissionRequest", status: "blocked"},
		{event: "Stop", status: "waiting"},
	},
	"claude": {
		{event: "SessionStart", status: "waiting"},
		{event: "UserPromptSubmit", status: "running"},
		{event: "PreToolUse", status: "running"},
		{event: "PermissionRequest", status: "blocked"},
		{event: "Stop", status: "waiting"},
		{event: "SessionEnd", status: "idle"},
	},
}

func Install(config Config) (Result, error) {
	if config.HomeDir == "" || config.Executable == "" {
		return Result{}, errors.New("home directory and executable are required")
	}
	var result Result
	for _, agent := range []string{"codex", "claude"} {
		if _, err := findExecutable(agent, config.Path); err != nil {
			continue
		}
		if err := installAgent(config, agent); err != nil {
			return result, fmt.Errorf("install %s hooks: %w", agent, err)
		}
		result.Installed = append(result.Installed, agent)
	}
	return result, nil
}

func installAgent(config Config, agent string) error {
	var path string
	if agent == "codex" {
		directory := config.CodexDir
		if directory == "" {
			directory = filepath.Join(config.HomeDir, ".codex")
		}
		path = filepath.Join(directory, "hooks.json")
	} else {
		directory := config.ClaudeDir
		if directory == "" {
			directory = filepath.Join(config.HomeDir, ".claude")
		}
		path = filepath.Join(directory, "settings.json")
	}
	document, mode, err := readJSONObject(path)
	if err != nil {
		return err
	}
	hooksValue, exists := document["hooks"]
	hooks, valid := hooksValue.(map[string]any)
	if exists && !valid {
		return fmt.Errorf("%s hooks must be a JSON object", agent)
	}
	if !exists {
		hooks = make(map[string]any)
		document["hooks"] = hooks
	}
	for _, spec := range agentHooks[agent] {
		command := shellQuote(config.Executable) + " hook " + agent + " " + spec.status
		entries, _ := hooks[spec.event].([]any)
		if containsCommand(entries, command) {
			continue
		}
		hooks[spec.event] = append(entries, map[string]any{
			"hooks": []any{map[string]any{
				"type":    "command",
				"command": command,
				"timeout": float64(10),
			}},
		})
	}
	data, err := json.MarshalIndent(document, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := writeAtomic(path, data, mode); err != nil {
		return err
	}
	if agent == "codex" {
		return enableCodexHooks(filepath.Join(filepath.Dir(path), "config.toml"))
	}
	return nil
}

func readJSONObject(path string) (map[string]any, os.FileMode, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return make(map[string]any), 0o600, nil
	}
	if err != nil {
		return nil, 0, err
	}
	var document map[string]any
	if err := json.Unmarshal(data, &document); err != nil {
		return nil, 0, fmt.Errorf("parse %s: %w", path, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, 0, err
	}
	return document, info.Mode().Perm(), nil
}

func containsCommand(entries []any, command string) bool {
	for _, entry := range entries {
		group, _ := entry.(map[string]any)
		handlers, _ := group["hooks"].([]any)
		for _, handler := range handlers {
			value, _ := handler.(map[string]any)
			if value["command"] == command {
				return true
			}
		}
	}
	return false
}

func enableCodexHooks(path string) error {
	data, err := os.ReadFile(path)
	mode := os.FileMode(0o600)
	if err == nil {
		if info, statErr := os.Stat(path); statErr == nil {
			mode = info.Mode().Perm()
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	lines := strings.Split(strings.TrimSuffix(string(data), "\n"), "\n")
	features := -1
	nextSection := len(lines)
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "[features]" {
			features = index
			continue
		}
		if features >= 0 && index > features && strings.HasPrefix(trimmed, "[") {
			nextSection = index
			break
		}
	}
	if features < 0 {
		if len(lines) == 1 && lines[0] == "" {
			lines = nil
		}
		lines = append(lines, "", "[features]", "hooks = true")
	} else {
		found := false
		for index := features + 1; index < nextSection; index++ {
			if strings.HasPrefix(strings.TrimSpace(lines[index]), "hooks =") {
				lines[index] = "hooks = true"
				found = true
				break
			}
		}
		if !found {
			lines = append(lines[:features+1], append([]string{"hooks = true"}, lines[features+1:]...)...)
		}
	}
	return writeAtomic(path, []byte(strings.TrimLeft(strings.Join(lines, "\n"), "\n")+"\n"), mode)
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".euphony-setup-*")
	if err != nil {
		return err
	}
	tempPath := file.Name()
	defer os.Remove(tempPath)
	if _, err := file.Write(data); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, path)
}

func findExecutable(name, pathValue string) (string, error) {
	for _, directory := range filepath.SplitList(pathValue) {
		candidate := filepath.Join(directory, name)
		info, err := os.Stat(candidate)
		if err == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", os.ErrNotExist
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}
