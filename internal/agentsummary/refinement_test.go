package agentsummary

import (
	"context"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
)

func TestParseRefinementAcceptsJSONAndRejectsInvalidFields(t *testing.T) {
	got, err := ParseRefinement(`{"title":"Ship it","description":"Add the task route","priority":"high","status":"todo","rationale":"The scope is clear."}`)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Ship it" || got.Priority != "high" || got.Status != "todo" {
		t.Fatalf("ParseRefinement() = %#v", got)
	}

	got, err = ParseRefinement("```json\n{\"title\":\"Review\",\"description\":\"Check the UI\",\"priority\":\"medium\",\"status\":\"in_progress\",\"rationale\":\"The next step is clear.\"}\n```")
	if err != nil || got.Status != "in_progress" {
		t.Fatalf("ParseRefinement(fenced) = %#v, %v", got, err)
	}
	for _, output := range []string{
		`{"description":"Missing title","priority":"low","status":"todo"}`,
		`{"title":"Bad priority","description":"","priority":"urgent","status":"todo"}`,
		`{"title":"Bad status","description":"","priority":"low","status":"finished"}`,
		"not JSON",
	} {
		if _, err := ParseRefinement(output); err == nil {
			t.Errorf("ParseRefinement(%q) error = nil", output)
		}
	}
}

func TestCommandRunnerRefineUsesRequestedProviderCommand(t *testing.T) {
	fixture := `{"title":"Refined task","description":"A more precise description","priority":"medium","status":"todo","rationale":"It is actionable."}`
	path := t.TempDir() + "/refinement.json"
	if err := os.WriteFile(path, []byte(fixture), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		provider string
		name     string
		args     []string
	}{
		{provider: "claude", name: "claude", args: []string{"-p", "--model", "haiku", "--effort", "none"}},
		{provider: "codex", name: "codex", args: []string{"exec", "--model", "gpt-5.6-low", "--effort", "none"}},
	} {
		var gotName string
		var gotArgs []string
		runner := &CommandRunner{
			commandContext: func(ctx context.Context, name string, args ...string) *exec.Cmd {
				gotName = name
				gotArgs = append([]string(nil), args...)
				return exec.CommandContext(ctx, "cat", path)
			},
		}
		got, err := runner.Refine(context.Background(), test.provider, "refine this task")
		if err != nil || got.Title != "Refined task" {
			t.Fatalf("Refine(%q) = %#v, %v", test.provider, got, err)
		}
		if gotName != test.name || !reflect.DeepEqual(gotArgs, test.args) {
			t.Fatalf("command = %q %#v, want %q %#v", gotName, gotArgs, test.name, test.args)
		}
	}

	long := strings.Repeat("x", maxGeneratedSummaryRunes+maxGeneratedActionRunes)
	if got, err := ParseRefinement(`{"title":"` + long + `","description":"","priority":"low","status":"todo"}`); err != nil || len([]rune(got.Title)) > maxGeneratedSummaryRunes {
		t.Fatalf("bounded refinement = %#v, %v", got, err)
	}
}
