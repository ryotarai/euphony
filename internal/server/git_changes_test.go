package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/ryotarai/euphony/internal/gitchanges"
)

func TestGitChangesEndpointReturnsSummaryAndSelectedPatch(t *testing.T) {
	repo := createGitChangesRepository(t)
	writeGitChangesFile(t, repo, "notes.txt", "before\n")
	runGitChangesGit(t, repo, "add", "notes.txt")
	runGitChangesGit(t, repo, "commit", "-m", "baseline")
	writeGitChangesFile(t, repo, "notes.txt", "after\n")
	writeGitChangesFile(t, repo, "new file.md", "# New\n")

	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Git terminal", repo)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	summary := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/"+terminal.ID+"/git-changes",
		"",
	)
	if summary.Code != http.StatusOK {
		t.Fatalf("summary status = %d, body = %s", summary.Code, summary.Body.String())
	}
	if summary.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("Cache-Control = %q", summary.Header().Get("Cache-Control"))
	}
	var snapshot gitchanges.Snapshot
	decodeResponse(t, summary, &snapshot)
	if snapshot.Branch != "main" || len(snapshot.Files) != 2 {
		t.Fatalf("summary = %#v", snapshot)
	}
	for _, file := range snapshot.Files {
		if len(file.Hunks) != 0 {
			t.Fatalf("summary loaded patch for %q: %#v", file.Path, file.Hunks)
		}
	}

	selected := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/"+terminal.ID+"/git-changes?path=notes.txt",
		"",
	)
	if selected.Code != http.StatusOK {
		t.Fatalf("selected status = %d, body = %s", selected.Code, selected.Body.String())
	}
	decodeResponse(t, selected, &snapshot)
	notes := gitChangesFileByPath(t, snapshot, "notes.txt")
	if len(notes.Hunks) != 1 ||
		notes.Hunks[0].Lines[0].Content != "before" {
		t.Fatalf("selected notes = %#v", notes)
	}
	newFile := gitChangesFileByPath(t, snapshot, "new file.md")
	if len(newFile.Hunks) != 0 {
		t.Fatalf("unselected file loaded patch: %#v", newFile.Hunks)
	}
}

func TestGitChangesEndpointRejectsMissingTerminalRepositoryAndPath(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	missing := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/missing/git-changes",
		"",
	)
	assertGitChangesError(t, missing, http.StatusNotFound, "session_not_found")

	terminal, err := srv.sessions.Create(t.Context(), "Plain terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	plain := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/"+terminal.ID+"/git-changes",
		"",
	)
	assertGitChangesError(
		t,
		plain,
		http.StatusNotFound,
		"git_repository_not_found",
	)

	repo := createGitChangesRepository(t)
	writeGitChangesFile(t, repo, "changed.txt", "new\n")
	repoTerminal, err := srv.sessions.Create(t.Context(), "Repo terminal", repo)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	unknown := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/"+repoTerminal.ID+"/git-changes?path=../outside",
		"",
	)
	assertGitChangesError(
		t,
		unknown,
		http.StatusBadRequest,
		"git_change_not_found",
	)
}

func TestGitChangesEndpointRequiresBearerAuthentication(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	request := httptest.NewRequest(
		http.MethodGet,
		"/api/sessions/missing/git-changes",
		nil,
	)
	response := httptest.NewRecorder()

	srv.Handler().ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.Code)
	}
}

func TestGitChangesEndpointReadsTheTerminalLinkedWorktree(t *testing.T) {
	repo := createGitChangesRepository(t)
	writeGitChangesFile(t, repo, "notes.txt", "baseline\n")
	runGitChangesGit(t, repo, "add", "notes.txt")
	runGitChangesGit(t, repo, "commit", "-m", "baseline")
	linked := filepath.Join(t.TempDir(), "linked")
	runGitChangesGit(t, repo, "worktree", "add", "-b", "feature", linked)
	t.Cleanup(func() {
		runGitChangesGit(t, repo, "worktree", "remove", "--force", linked)
	})
	writeGitChangesFile(t, linked, "notes.txt", "linked change\n")
	writeGitChangesFile(t, repo, "main-only.txt", "main change\n")

	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Linked terminal", linked)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	response := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/"+terminal.ID+"/git-changes",
		"",
	)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var snapshot gitchanges.Snapshot
	decodeResponse(t, response, &snapshot)
	if snapshot.Branch != "feature" {
		t.Fatalf("Branch = %q, want feature", snapshot.Branch)
	}
	if len(snapshot.Files) != 1 || snapshot.Files[0].Path != "notes.txt" {
		t.Fatalf("Files = %#v, want linked notes only", snapshot.Files)
	}
}

func createGitChangesRepository(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	runGitChangesGit(t, repo, "init", "-b", "main")
	runGitChangesGit(t, repo, "config", "user.name", "Euphony Test")
	runGitChangesGit(t, repo, "config", "user.email", "euphony@example.test")
	runGitChangesGit(t, repo, "config", "commit.gpgsign", "false")
	return repo
}

func runGitChangesGit(t *testing.T, repo string, args ...string) {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", repo}, args...)...)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %v error = %v\n%s", args, err, output)
	}
}

func writeGitChangesFile(t *testing.T, repo, name, content string) {
	t.Helper()
	path := filepath.Join(repo, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
}

func gitChangesFileByPath(
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

func assertGitChangesError(
	t *testing.T,
	response *httptest.ResponseRecorder,
	status int,
	code string,
) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d; body = %s", response.Code, status, response.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if body.Code != code {
		t.Fatalf("code = %q, want %q", body.Code, code)
	}
}
