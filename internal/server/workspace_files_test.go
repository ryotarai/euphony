package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/ryotarai/euphony/internal/workspacefiles"
)

func TestWorkspaceEndpointsListSearchAndReadFromTerminalRoot(t *testing.T) {
	repo := createGitChangesRepository(t)
	nested := filepath.Join(repo, "nested", "cwd")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	writeGitChangesFile(t, repo, "README.md", "# Root\n")
	writeGitChangesFile(t, repo, "docs/User Guide.md", "first\nsecond\n")

	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Workspace terminal", nested)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	rootResponse := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/"+terminal.ID+"/workspace",
		"",
	)
	if rootResponse.Code != http.StatusOK {
		t.Fatalf("root status = %d, body = %s", rootResponse.Code, rootResponse.Body.String())
	}
	if rootResponse.Header().Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("Cache-Control = %q", rootResponse.Header().Get("Cache-Control"))
	}
	var directory workspacefiles.Directory
	decodeResponse(t, rootResponse, &directory)
	if directory.Path != "" || !workspaceEntryExists(directory.Entries, "README.md") {
		t.Fatalf("root directory = %#v", directory)
	}

	docsResponse := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/"+terminal.ID+"/workspace?path=docs",
		"",
	)
	if docsResponse.Code != http.StatusOK {
		t.Fatalf("docs status = %d, body = %s", docsResponse.Code, docsResponse.Body.String())
	}
	decodeResponse(t, docsResponse, &directory)
	if directory.Path != "docs" ||
		!workspaceEntryExists(directory.Entries, "User Guide.md") {
		t.Fatalf("docs directory = %#v", directory)
	}

	searchResponse := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/"+terminal.ID+"/workspace/search?query=GUIDE",
		"",
	)
	if searchResponse.Code != http.StatusOK {
		t.Fatalf("search status = %d, body = %s", searchResponse.Code, searchResponse.Body.String())
	}
	var search workspacefiles.SearchResult
	decodeResponse(t, searchResponse, &search)
	if len(search.Matches) != 1 || search.Matches[0].Path != "docs/User Guide.md" {
		t.Fatalf("search = %#v", search)
	}

	fileResponse := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/"+terminal.ID+"/workspace/file?path="+
			url.QueryEscape("docs/User Guide.md"),
		"",
	)
	if fileResponse.Code != http.StatusOK {
		t.Fatalf("file status = %d, body = %s", fileResponse.Code, fileResponse.Body.String())
	}
	var file workspacefiles.File
	decodeResponse(t, fileResponse, &file)
	if file.Path != "docs/User Guide.md" || file.Content != "first\nsecond\n" {
		t.Fatalf("file = %#v", file)
	}
}

func TestWorkspaceEndpointDownloadsWorkspaceFile(t *testing.T) {
	root := t.TempDir()
	content := []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02}
	if err := os.WriteFile(filepath.Join(root, "preview.png"), content, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Workspace terminal", root)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	response := performRequest(
		t,
		srv,
		http.MethodGet,
		"/api/sessions/"+terminal.ID+"/workspace/file/content?path=preview.png",
		"",
	)
	if response.Code != http.StatusOK {
		t.Fatalf("download status = %d, body = %s", response.Code, response.Body.String())
	}
	if response.Header().Get("Content-Type") != "image/png" {
		t.Fatalf("Content-Type = %q", response.Header().Get("Content-Type"))
	}
	if response.Header().Get("Content-Disposition") != "attachment; filename=preview.png" {
		t.Fatalf("Content-Disposition = %q", response.Header().Get("Content-Disposition"))
	}
	if !bytes.Equal(response.Body.Bytes(), content) {
		t.Fatalf("downloaded content = %v, want %v", response.Body.Bytes(), content)
	}
}

func TestWorkspaceEndpointsReturnStableErrors(t *testing.T) {
	root := t.TempDir()
	writeGitChangesFile(t, root, "file.txt", "content")
	if err := os.Mkdir(filepath.Join(root, "folder"), 0o755); err != nil {
		t.Fatalf("Mkdir() error = %v", err)
	}
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	terminal, err := srv.sessions.Create(t.Context(), "Workspace terminal", root)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	tests := []struct {
		name   string
		path   string
		status int
		code   string
	}{
		{
			name:   "missing session",
			path:   "/api/sessions/missing/workspace",
			status: http.StatusNotFound,
			code:   "session_not_found",
		},
		{
			name:   "escaping path",
			path:   "/api/sessions/" + terminal.ID + "/workspace/file?path=../outside",
			status: http.StatusBadRequest,
			code:   "workspace_path_invalid",
		},
		{
			name:   "missing path",
			path:   "/api/sessions/" + terminal.ID + "/workspace?path=missing",
			status: http.StatusNotFound,
			code:   "workspace_path_not_found",
		},
		{
			name:   "file requested as directory",
			path:   "/api/sessions/" + terminal.ID + "/workspace?path=file.txt",
			status: http.StatusBadRequest,
			code:   "workspace_path_type_mismatch",
		},
		{
			name:   "directory requested as file",
			path:   "/api/sessions/" + terminal.ID + "/workspace/file?path=folder",
			status: http.StatusBadRequest,
			code:   "workspace_path_type_mismatch",
		},
		{
			name:   "directory requested as download",
			path:   "/api/sessions/" + terminal.ID + "/workspace/file/content?path=folder",
			status: http.StatusBadRequest,
			code:   "workspace_path_type_mismatch",
		},
		{
			name:   "blank file path",
			path:   "/api/sessions/" + terminal.ID + "/workspace/file",
			status: http.StatusBadRequest,
			code:   "workspace_path_invalid",
		},
		{
			name:   "blank query",
			path:   "/api/sessions/" + terminal.ID + "/workspace/search?query=",
			status: http.StatusBadRequest,
			code:   "workspace_search_invalid",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := performRequest(t, srv, http.MethodGet, test.path, "")
			assertWorkspaceError(t, response, test.status, test.code)
		})
	}
}

func TestWorkspaceEndpointsRequireBearerAuthentication(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })

	for _, path := range []string{
		"/api/sessions/missing/workspace",
		"/api/sessions/missing/workspace/search?query=file",
		"/api/sessions/missing/workspace/file?path=file.txt",
		"/api/sessions/missing/workspace/file/content?path=file.txt",
	} {
		request := httptest.NewRequest(http.MethodGet, path, nil)
		response := httptest.NewRecorder()
		srv.Handler().ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s status = %d, want 401", path, response.Code)
		}
	}
}

func workspaceEntryExists(entries []workspacefiles.Entry, name string) bool {
	for _, entry := range entries {
		if entry.Name == name {
			return true
		}
	}
	return false
}

func assertWorkspaceError(
	t *testing.T,
	response *httptest.ResponseRecorder,
	status int,
	code string,
) {
	t.Helper()
	if response.Code != status {
		t.Fatalf(
			"status = %d, want %d; body = %s",
			response.Code,
			status,
			response.Body.String(),
		)
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
