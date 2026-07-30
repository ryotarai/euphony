package setup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
