package workspacefiles

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewUsesGitTopLevelAndFallsBackToCWD(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init", "-b", "main")
	nested := filepath.Join(repo, "one", "two")
	mustMkdirAll(t, nested)

	reader, err := New(context.Background(), nested)
	if err != nil {
		t.Fatalf("New(repo) error = %v", err)
	}
	canonicalRepo := mustEvalSymlinks(t, repo)
	if reader.Root() != canonicalRepo {
		t.Fatalf("Root() = %q, want %q", reader.Root(), canonicalRepo)
	}

	plain := t.TempDir()
	reader, err = New(context.Background(), plain)
	if err != nil {
		t.Fatalf("New(plain) error = %v", err)
	}
	canonicalPlain := mustEvalSymlinks(t, plain)
	if reader.Root() != canonicalPlain {
		t.Fatalf("Root() = %q, want %q", reader.Root(), canonicalPlain)
	}
}

func TestDirectorySortsDirectoriesBeforeFilesAndCapsEntries(t *testing.T) {
	root := t.TempDir()
	mustMkdirAll(t, filepath.Join(root, "beta"))
	mustMkdirAll(t, filepath.Join(root, "Alpha"))
	mustWriteFile(t, filepath.Join(root, "zeta.txt"), "z")
	mustWriteFile(t, filepath.Join(root, "apple.txt"), "a")
	for index := 0; index < maxDirectoryEntries; index++ {
		mustWriteFile(t, filepath.Join(root, "many", fileName(index)), "x")
	}
	mustWriteFile(t, filepath.Join(root, "many", "overflow.txt"), "x")

	reader := mustReader(t, root)
	directory, err := reader.Directory("")
	if err != nil {
		t.Fatalf("Directory(root) error = %v", err)
	}
	got := make([]string, 0, len(directory.Entries))
	for _, entry := range directory.Entries {
		got = append(got, string(entry.Kind)+":"+entry.Name)
	}
	want := []string{
		"directory:Alpha",
		"directory:beta",
		"directory:many",
		"file:apple.txt",
		"file:zeta.txt",
	}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("entries = %v, want %v", got, want)
	}

	many, err := reader.Directory("many")
	if err != nil {
		t.Fatalf("Directory(many) error = %v", err)
	}
	if len(many.Entries) != maxDirectoryEntries || !many.Truncated {
		t.Fatalf("many = %#v, want %d truncated entries", many, maxDirectoryEntries)
	}
}

func TestReaderRejectsTraversalAndEscapingSymlinks(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt")
	mustWriteFile(t, outside, "secret")
	if err := os.Symlink(outside, filepath.Join(root, "outside-link")); err != nil {
		t.Fatalf("Symlink() error = %v", err)
	}
	mustWriteFile(t, filepath.Join(root, "inside.txt"), "inside")
	if err := os.Symlink(
		filepath.Join(root, "inside.txt"),
		filepath.Join(root, "inside-link"),
	); err != nil {
		t.Fatalf("Symlink() error = %v", err)
	}

	reader := mustReader(t, root)
	for _, path := range []string{"../secret.txt", outside, "outside-link"} {
		if _, err := reader.File(path); !errors.Is(err, ErrInvalidPath) {
			t.Fatalf("File(%q) error = %v, want ErrInvalidPath", path, err)
		}
	}
	file, err := reader.File("inside-link")
	if err != nil {
		t.Fatalf("File(inside-link) error = %v", err)
	}
	if file.Content != "inside" {
		t.Fatalf("Content = %q, want inside", file.Content)
	}
}

func TestFileReportsTextBinaryAndTruncation(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "notes.txt"), "first\nsecond\n")
	if err := os.WriteFile(
		filepath.Join(root, "binary.dat"),
		[]byte{0xff, 0x00, 0xfe},
		0o600,
	); err != nil {
		t.Fatalf("WriteFile(binary) error = %v", err)
	}
	mustWriteFile(
		t,
		filepath.Join(root, "large.txt"),
		strings.Repeat("x", maxFileBytes+1),
	)

	reader := mustReader(t, root)
	text, err := reader.File("notes.txt")
	if err != nil {
		t.Fatalf("File(text) error = %v", err)
	}
	if text.Binary || text.Truncated || text.Content != "first\nsecond\n" {
		t.Fatalf("text = %#v", text)
	}

	binary, err := reader.File("binary.dat")
	if err != nil {
		t.Fatalf("File(binary) error = %v", err)
	}
	if !binary.Binary || binary.Content != "" {
		t.Fatalf("binary = %#v", binary)
	}

	large, err := reader.File("large.txt")
	if err != nil {
		t.Fatalf("File(large) error = %v", err)
	}
	if !large.Truncated || len(large.Content) != maxFileBytes {
		t.Fatalf("large content bytes = %d, truncated = %v", len(large.Content), large.Truncated)
	}
}

func TestSearchIsCaseInsensitiveBoundedAndSkipsHeavyDirectories(t *testing.T) {
	root := t.TempDir()
	mustWriteFile(t, filepath.Join(root, "Docs", "Guide.MD"), "guide")
	mustWriteFile(t, filepath.Join(root, ".git", "private-guide.txt"), "hidden")
	mustWriteFile(t, filepath.Join(root, "node_modules", "package-guide.js"), "hidden")
	for index := 0; index < maxSearchResults; index++ {
		mustWriteFile(t, filepath.Join(root, "results", "guide-"+fileName(index)), "x")
	}

	reader := mustReader(t, root)
	result, err := reader.Search("GUIDE")
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Matches) != maxSearchResults || !result.Truncated {
		t.Fatalf("matches = %d, truncated = %v", len(result.Matches), result.Truncated)
	}
	for _, match := range result.Matches {
		if strings.HasPrefix(match.Path, ".git/") ||
			strings.HasPrefix(match.Path, "node_modules/") {
			t.Fatalf("search included skipped path %q", match.Path)
		}
	}
	foundGuide := false
	for _, match := range result.Matches {
		if match.Path == "Docs/Guide.MD" {
			foundGuide = true
		}
	}
	if !foundGuide {
		t.Fatalf("matches do not contain Docs/Guide.MD: %#v", result.Matches)
	}
}

func TestReaderClassifiesMissingAndWrongKind(t *testing.T) {
	root := t.TempDir()
	mustMkdirAll(t, filepath.Join(root, "folder"))
	mustWriteFile(t, filepath.Join(root, "file.txt"), "text")
	reader := mustReader(t, root)

	if _, err := reader.Directory("missing"); !errors.Is(err, ErrPathNotFound) {
		t.Fatalf("Directory(missing) error = %v", err)
	}
	if _, err := reader.Directory("file.txt"); !errors.Is(err, ErrTypeMismatch) {
		t.Fatalf("Directory(file) error = %v", err)
	}
	if _, err := reader.File("folder"); !errors.Is(err, ErrTypeMismatch) {
		t.Fatalf("File(folder) error = %v", err)
	}
	if _, err := reader.Search(" "); !errors.Is(err, ErrInvalidQuery) {
		t.Fatalf("Search(blank) error = %v", err)
	}
}

func mustReader(t *testing.T, cwd string) *Reader {
	t.Helper()
	reader, err := New(context.Background(), cwd)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return reader
}

func mustMkdirAll(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", path, err)
	}
}

func mustEvalSymlinks(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q) error = %v", path, err)
	}
	return resolved
}

func mustWriteFile(t *testing.T, path, content string) {
	t.Helper()
	mustMkdirAll(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile(%q) error = %v", path, err)
	}
}

func runGit(t *testing.T, cwd string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", cwd}, args...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v error = %v\n%s", args, err, output)
	}
}

func fileName(index int) string {
	const digits = "0123456789"
	return "file-" +
		string(digits[(index/100)%10]) +
		string(digits[(index/10)%10]) +
		string(digits[index%10]) +
		".txt"
}
