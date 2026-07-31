package setup

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInspectReportsAgentsWhenIntegrationIsMissing(t *testing.T) {
	config := setupTestConfig(t, "codex", "claude")

	status, err := Inspect(config)
	if err != nil {
		t.Fatalf("Inspect() error = %v", err)
	}
	if got := strings.Join(status.NeedsSetup, ","); got != "codex,claude" {
		t.Fatalf("NeedsSetup = %q, want codex,claude", got)
	}
}

func TestInspectReportsNoAgentsAfterInstall(t *testing.T) {
	config := setupTestConfig(t, "codex", "claude")
	if _, err := Install(config); err != nil {
		t.Fatalf("Install() error = %v", err)
	}

	status, err := Inspect(config)
	if err != nil {
		t.Fatalf("Inspect() error = %v", err)
	}
	if len(status.NeedsSetup) != 0 {
		t.Fatalf("NeedsSetup = %v, want none", status.NeedsSetup)
	}
}

func TestInspectReportsOutdatedSkillWithoutModifyingIt(t *testing.T) {
	config := setupTestConfig(t, "codex", "claude")
	if _, err := Install(config); err != nil {
		t.Fatalf("Install() error = %v", err)
	}
	skillPath := filepath.Join(
		config.ClaudeDir, "skills", "euphony-annotate", "SKILL.md",
	)
	outdated := []byte("outdated\n")
	if err := os.WriteFile(skillPath, outdated, 0o600); err != nil {
		t.Fatal(err)
	}

	status, err := Inspect(config)
	if err != nil {
		t.Fatalf("Inspect() error = %v", err)
	}
	if got := strings.Join(status.NeedsSetup, ","); got != "claude" {
		t.Fatalf("NeedsSetup = %q, want claude", got)
	}
	if got := readFile(t, skillPath); !bytes.Equal(got, outdated) {
		t.Fatalf("Inspect() changed skill to %q", got)
	}
}

func TestInstallDetectsAgentsPreservesSettingsAndIsIdempotent(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"codex", "claude"} {
		if err := os.WriteFile(filepath.Join(binDir, name), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "hooks.json"),
		[]byte(`{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"existing-codex"}]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".codex", "config.toml"),
		[]byte("model = \"gpt-test\"\n\n[features]\napps = true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude", "settings.json"),
		[]byte(`{"theme":"dark","hooks":{"Stop":[{"hooks":[{"type":"command","command":"existing-claude"}]}]}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	config := Config{
		HomeDir:    home,
		Executable: "/opt/euphony/bin/euphony",
		Path:       binDir,
	}
	first, err := Install(config)
	if err != nil {
		t.Fatalf("Install() error = %v", err)
	}
	if strings.Join(first.Installed, ",") != "codex,claude" {
		t.Fatalf("installed = %v, want codex and claude", first.Installed)
	}
	codexHooks := readJSON(t, filepath.Join(home, ".codex", "hooks.json"))
	claudeSettings := readJSON(t, filepath.Join(home, ".claude", "settings.json"))
	if !strings.Contains(string(codexHooks), "existing-codex") ||
		!strings.Contains(string(codexHooks), "/opt/euphony/bin/euphony' hook codex") {
		t.Fatalf("codex hooks = %s", codexHooks)
	}
	if !strings.Contains(string(claudeSettings), "existing-claude") ||
		!strings.Contains(string(claudeSettings), "/opt/euphony/bin/euphony' hook claude") ||
		!strings.Contains(string(claudeSettings), `"theme": "dark"`) {
		t.Fatalf("claude settings = %s", claudeSettings)
	}
	for _, path := range []string{
		filepath.Join(home, ".codex", "skills", "euphony-annotate", "SKILL.md"),
		filepath.Join(home, ".claude", "skills", "euphony-annotate", "SKILL.md"),
	} {
		skill, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read installed skill %s: %v", path, err)
		}
		if !strings.HasPrefix(string(skill), "---\nname: euphony-annotate\n") ||
			!strings.Contains(string(skill), "euphony annotate") {
			t.Fatalf("installed skill %s is invalid:\n%s", path, skill)
		}
		if !bytes.Equal(skill, annotationSkill) {
			t.Fatalf("installed skill %s differs from the bundled skill", path)
		}
	}
	configTOML, err := os.ReadFile(filepath.Join(home, ".codex", "config.toml"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(configTOML), "apps = true") ||
		!strings.Contains(string(configTOML), "hooks = true") {
		t.Fatalf("codex config = %s", configTOML)
	}

	beforeCodex := string(codexHooks)
	beforeClaude := string(claudeSettings)
	beforeSkill := string(readFile(t,
		filepath.Join(home, ".codex", "skills", "euphony-annotate", "SKILL.md")))
	if _, err := Install(config); err != nil {
		t.Fatalf("second Install() error = %v", err)
	}
	if got := string(readJSON(t, filepath.Join(home, ".codex", "hooks.json"))); got != beforeCodex {
		t.Fatalf("second install changed codex hooks:\n%s", got)
	}
	if got := string(readJSON(t, filepath.Join(home, ".claude", "settings.json"))); got != beforeClaude {
		t.Fatalf("second install changed claude settings:\n%s", got)
	}
	if got := string(readFile(t,
		filepath.Join(home, ".codex", "skills", "euphony-annotate", "SKILL.md"))); got != beforeSkill {
		t.Fatalf("second install changed Codex skill:\n%s", got)
	}
}

func TestInstallRejectsInvalidHooksWithoutOverwritingSettings(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binDir, "claude"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, ".claude", "settings.json")
	original := `{"hooks":["unexpected"],"theme":"dark"}`
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := Install(Config{HomeDir: home, Executable: "/bin/euphony", Path: binDir})
	if err == nil {
		t.Fatal("Install() error = nil, want invalid hooks error")
	}
	data, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if string(data) != original {
		t.Fatalf("settings changed after error: %s", data)
	}
}

func TestInstallReplacesCompactCodexHooksAssignment(t *testing.T) {
	for _, existing := range []string{
		"hooks=false",
		"hooks= false # disabled for now",
	} {
		t.Run(existing, func(t *testing.T) {
			config := setupTestConfig(t, "codex")
			if err := os.MkdirAll(config.CodexDir, 0o700); err != nil {
				t.Fatal(err)
			}
			configPath := filepath.Join(config.CodexDir, "config.toml")
			if err := os.WriteFile(
				configPath,
				[]byte("[features]\n"+existing+"\napps = true\n"),
				0o600,
			); err != nil {
				t.Fatal(err)
			}

			if _, err := Install(config); err != nil {
				t.Fatalf("Install() error = %v", err)
			}
			data := readFile(t, configPath)
			var hookAssignments []string
			for _, line := range strings.Split(string(data), "\n") {
				key, value, found := strings.Cut(line, "=")
				if found && strings.TrimSpace(key) == "hooks" {
					hookAssignments = append(hookAssignments, strings.TrimSpace(value))
				}
			}
			if len(hookAssignments) != 1 || hookAssignments[0] != "true" {
				t.Fatalf(
					"hooks assignments = %v, want one true assignment; config:\n%s",
					hookAssignments, data,
				)
			}
			if !bytes.Contains(data, []byte("apps = true")) {
				t.Fatalf("Install() removed neighboring setting:\n%s", data)
			}
		})
	}
}

func readJSON(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var value any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatalf("%s is invalid JSON: %v", path, err)
	}
	return data
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func setupTestConfig(t *testing.T, agents ...string) Config {
	t.Helper()
	home := t.TempDir()
	binDir := filepath.Join(home, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, agent := range agents {
		if err := os.WriteFile(
			filepath.Join(binDir, agent), []byte("#!/bin/sh\n"), 0o755,
		); err != nil {
			t.Fatal(err)
		}
	}
	return Config{
		HomeDir:    home,
		CodexDir:   filepath.Join(home, ".codex"),
		ClaudeDir:  filepath.Join(home, ".claude"),
		Executable: "/opt/euphony/bin/euphony",
		Path:       binDir,
	}
}
