package gitchanges_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ryotarai/euphony/internal/gitchanges"
)

func TestReadReturnsTrackedAndUntrackedChangesWithNumberedLines(t *testing.T) {
	repo := newRepository(t)
	writeFile(t, repo, "notes.txt", "alpha\nbeta\n")
	runGit(t, repo, "add", "notes.txt")
	runGit(t, repo, "commit", "-m", "baseline")

	writeFile(t, repo, "notes.txt", "alpha\nBETA\ngamma\n")
	writeFile(t, repo, "draft file.md", "# Draft\n")

	snapshot, err := gitchanges.Read(context.Background(), repo)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if snapshot.Branch != "main" {
		t.Fatalf("Branch = %q, want main", snapshot.Branch)
	}
	if len(snapshot.Files) != 2 {
		t.Fatalf("len(Files) = %d, want 2: %#v", len(snapshot.Files), snapshot.Files)
	}

	notes := fileByPath(t, snapshot, "notes.txt")
	if notes.Status != "modified" || notes.Additions != 2 || notes.Deletions != 1 {
		t.Fatalf("notes file = %#v", notes)
	}
	if len(notes.Hunks) != 1 {
		t.Fatalf("notes hunks = %#v", notes.Hunks)
	}
	assertLine(t, notes.Hunks[0].Lines, "deletion", 2, 0, "beta")
	assertLine(t, notes.Hunks[0].Lines, "addition", 0, 2, "BETA")
	assertLine(t, notes.Hunks[0].Lines, "addition", 0, 3, "gamma")

	draft := fileByPath(t, snapshot, "draft file.md")
	if draft.Status != "untracked" || draft.Additions != 1 || draft.Deletions != 0 {
		t.Fatalf("draft file = %#v", draft)
	}
	assertLine(t, draft.Hunks[0].Lines, "addition", 0, 1, "# Draft")
	if snapshot.Additions != 3 || snapshot.Deletions != 1 {
		t.Fatalf(
			"snapshot totals = +%d -%d, want +3 -1",
			snapshot.Additions,
			snapshot.Deletions,
		)
	}
}

func TestReadPreservesRenamePathsContainingSpaces(t *testing.T) {
	repo := newRepository(t)
	writeFile(t, repo, "old name.txt", "content\n")
	runGit(t, repo, "add", "old name.txt")
	runGit(t, repo, "commit", "-m", "baseline")
	if err := os.Rename(
		filepath.Join(repo, "old name.txt"),
		filepath.Join(repo, "new name.txt"),
	); err != nil {
		t.Fatalf("Rename() error = %v", err)
	}
	runGit(t, repo, "add", "-A")

	snapshot, err := gitchanges.Read(context.Background(), repo)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if len(snapshot.Files) != 1 {
		t.Fatalf("len(Files) = %d, want 1: %#v", len(snapshot.Files), snapshot.Files)
	}
	renamed := snapshot.Files[0]
	if renamed.Path != "new name.txt" ||
		renamed.PreviousPath != "old name.txt" ||
		renamed.Status != "renamed" {
		t.Fatalf("renamed file = %#v", renamed)
	}
}

func TestReadRejectsDirectoriesOutsideGitRepositories(t *testing.T) {
	_, err := gitchanges.Read(context.Background(), t.TempDir())
	if !errors.Is(err, gitchanges.ErrNotRepository) {
		t.Fatalf("Read() error = %v, want ErrNotRepository", err)
	}
}

func TestReadResolvesNestedCWDToItsWorktreeRoot(t *testing.T) {
	repo := newRepository(t)
	writeFile(t, repo, "notes.txt", "baseline\n")
	runGit(t, repo, "add", "notes.txt")
	runGit(t, repo, "commit", "-m", "baseline")
	writeFile(t, repo, "notes.txt", "changed\n")
	nested := filepath.Join(repo, "src", "nested")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}

	snapshot, err := gitchanges.Read(context.Background(), nested)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	resolvedRepo, err := filepath.EvalSymlinks(repo)
	if err != nil {
		t.Fatalf("EvalSymlinks() error = %v", err)
	}
	if snapshot.RepoRoot != resolvedRepo {
		t.Fatalf("RepoRoot = %q, want %q", snapshot.RepoRoot, resolvedRepo)
	}
	notes := fileByPath(t, snapshot, "notes.txt")
	if len(notes.Hunks) != 1 {
		t.Fatalf("notes hunks = %#v", notes.Hunks)
	}
}

func TestReadTruncatesLargePatches(t *testing.T) {
	repo := newRepository(t)
	writeFile(t, repo, "large.txt", "baseline\n")
	runGit(t, repo, "add", "large.txt")
	runGit(t, repo, "commit", "-m", "baseline")
	writeFile(t, repo, "large.txt", strings.Repeat("changed content\n", 90_000))

	snapshot, err := gitchanges.Read(context.Background(), repo)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	large := fileByPath(t, snapshot, "large.txt")
	if !large.Truncated {
		t.Fatalf("Truncated = false, want true")
	}
	if large.Additions == 0 || len(large.Hunks) == 0 {
		t.Fatalf("large file lost its retained diff prefix: %#v", large)
	}
}

func newRepository(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	runGit(t, repo, "init", "-b", "main")
	runGit(t, repo, "config", "user.name", "Euphony Test")
	runGit(t, repo, "config", "user.email", "euphony@example.test")
	return repo
}

func runGit(t *testing.T, repo string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", repo}, args...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v error = %v\n%s", args, err, output)
	}
}

func writeFile(t *testing.T, repo, name, content string) {
	t.Helper()
	path := filepath.Join(repo, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
}

func fileByPath(
	t *testing.T,
	snapshot gitchanges.Snapshot,
	path string,
) gitchanges.File {
	t.Helper()
	for _, file := range snapshot.Files {
		if file.Path == path {
			return file
		}
	}
	t.Fatalf("file %q not found in %#v", path, snapshot.Files)
	return gitchanges.File{}
}

func assertLine(
	t *testing.T,
	lines []gitchanges.Line,
	kind string,
	oldLine int,
	newLine int,
	content string,
) {
	t.Helper()
	for _, line := range lines {
		if line.Kind == kind &&
			line.OldLine == oldLine &&
			line.NewLine == newLine &&
			line.Content == content {
			return
		}
	}
	t.Fatalf(
		"line %s old=%d new=%d content=%q not found in %#v",
		kind,
		oldLine,
		newLine,
		content,
		lines,
	)
}
