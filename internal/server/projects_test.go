package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/ryotarai/euphony/internal/project"
	"github.com/ryotarai/euphony/internal/session"
)

func newProjectTestServer(t *testing.T) *Server {
	t.Helper()
	srv, err := New(Config{Token: "token", Shell: "/bin/sh"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = srv.Close(t.Context()) })
	return srv
}

func TestProjectsEndpointCreatesAndListsProjects(t *testing.T) {
	srv := newProjectTestServer(t)
	directory := t.TempDir()
	created := performRequest(t, srv, http.MethodPost, "/api/projects",
		`{"path":`+strconv.Quote(filepath.Join(directory, "."))+`}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	var createdProject project.Project
	decodeResponse(t, created, &createdProject)
	if createdProject.ID == "" || createdProject.Path != directory {
		t.Fatalf("created project = %#v, want canonical directory", createdProject)
	}

	listed := performRequest(t, srv, http.MethodGet, "/api/projects", "")
	if listed.Code != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", listed.Code, listed.Body.String())
	}
	var projects []project.Project
	decodeResponse(t, listed, &projects)
	if len(projects) != 1 || projects[0] != createdProject {
		t.Fatalf("list = %#v, want %#v", projects, []project.Project{createdProject})
	}
}

func TestProjectsEndpointUsesStrictJSONAndStablePathErrors(t *testing.T) {
	srv := newProjectTestServer(t)
	directory := t.TempDir()

	unknown := performRequest(t, srv, http.MethodPost, "/api/projects",
		`{"path":`+strconv.Quote(directory)+`,"extra":true}`)
	assertProjectError(t, unknown, http.StatusBadRequest, "invalid_request")

	missing := performRequest(t, srv, http.MethodPost, "/api/projects",
		`{"path":`+strconv.Quote(filepath.Join(directory, "missing"))+`}`)
	assertProjectError(t, missing, http.StatusBadRequest, "invalid_path")

	created := performRequest(t, srv, http.MethodPost, "/api/projects",
		`{"path":`+strconv.Quote(directory)+`}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("initial create status = %d, body = %s", created.Code, created.Body.String())
	}
	duplicate := performRequest(t, srv, http.MethodPost, "/api/projects",
		`{"path":`+strconv.Quote(filepath.Join(directory, "."))+`}`)
	assertProjectError(t, duplicate, http.StatusConflict, "project_exists")
}

func TestProjectTerminalCreationResolvesProjectDirectoryServerSide(t *testing.T) {
	srv := newProjectTestServer(t)
	directory := t.TempDir()
	projectResponse := performRequest(t, srv, http.MethodPost, "/api/projects",
		`{"path":`+strconv.Quote(directory)+`}`)
	var createdProject project.Project
	decodeResponse(t, projectResponse, &createdProject)

	created := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Project terminal","cwd":`+strconv.Quote(t.TempDir())+
			`,"projectId":`+strconv.Quote(createdProject.ID)+`}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	var envelope struct {
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, created, &envelope)
	if envelope.Result.Terminal.CWD != directory ||
		envelope.Result.Terminal.ProjectID != createdProject.ID {
		t.Fatalf("created terminal = %#v, want project directory and ID", envelope.Result.Terminal)
	}
}

func TestLegacyTerminalCreationKeepsLegacyCWDAndNoProjectID(t *testing.T) {
	srv := newProjectTestServer(t)
	directory := t.TempDir()
	created := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Legacy terminal","cwd":`+strconv.Quote(directory)+`}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", created.Code, created.Body.String())
	}
	var envelope struct {
		Result struct {
			Terminal session.Metadata `json:"terminal"`
		} `json:"result"`
	}
	decodeResponse(t, created, &envelope)
	if envelope.Result.Terminal.CWD != directory || envelope.Result.Terminal.ProjectID != "" {
		t.Fatalf("legacy terminal = %#v, want empty project ID", envelope.Result.Terminal)
	}
}

func TestProjectTerminalCreationRejectsUnknownProject(t *testing.T) {
	srv := newProjectTestServer(t)
	response := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Missing project","projectId":"missing-project"}`)
	assertV1ProjectError(t, response, http.StatusNotFound, "project_not_found")
}

func TestProjectTerminalCreationRejectsExplicitNullProjectID(t *testing.T) {
	srv := newProjectTestServer(t)
	response := performRequest(t, srv, http.MethodPost, "/api/v1/terminals",
		`{"name":"Null project","cwd":`+strconv.Quote(t.TempDir())+`,"projectId":null}`)
	assertV1ProjectError(t, response, http.StatusBadRequest, "invalid_request")

	terminalsResponse := performRequest(t, srv, http.MethodGet, "/api/v1/terminals", "")
	var envelope struct {
		Result struct {
			Terminals []session.Metadata `json:"terminals"`
		} `json:"result"`
	}
	decodeResponse(t, terminalsResponse, &envelope)
	if len(envelope.Result.Terminals) != 0 {
		t.Fatalf("terminals after explicit null request = %#v, want none", envelope.Result.Terminals)
	}
}

func TestOptionalProjectIDRecognizesWhitespaceAroundNull(t *testing.T) {
	var id optionalProjectID
	if err := id.UnmarshalJSON([]byte(" \n null \t")); err != nil {
		t.Fatalf("UnmarshalJSON() error = %v", err)
	}
	if !id.present || !id.null || id.value != "" {
		t.Fatalf("optional project ID = %#v, want present null value", id)
	}
}

func TestLegacyProjectMigrationToleratesTerminalDisappearance(t *testing.T) {
	sessions := session.NewManager("/bin/sh")
	t.Cleanup(func() { _ = sessions.Close(context.Background()) })
	directory := t.TempDir()
	created, err := sessions.Create(context.Background(), "Legacy terminal", directory)
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	repository := &disappearingLegacyProjectRepository{
		sessions:   sessions,
		terminalID: created.ID,
		projects:   make(map[string]project.Project),
	}
	projects := project.NewService(repository, time.Now, func() string { return "project-1" })

	if err := migrateLegacyProjects(context.Background(), sessions, projects); err != nil {
		t.Fatalf("migrateLegacyProjects() error = %v, want terminal disappearance to be tolerated", err)
	}
	if _, ok := sessions.Metadata(created.ID); ok {
		t.Fatal("legacy terminal survived the disappearance hook")
	}
	remaining, err := projects.List(context.Background())
	if err != nil {
		t.Fatalf("projects.List() after terminal disappearance error = %v", err)
	}
	if len(remaining) != 0 {
		t.Fatalf("projects after terminal disappearance = %#v, want no orphan project", remaining)
	}
}

func TestPersistentServerMigratesLegacyTerminalsIntoProjects(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	directory := t.TempDir()
	store, err := session.OpenSQLiteStore(databasePath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	createdAt := time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
	if err := store.Save(context.Background(), session.Metadata{
		ID: "legacy-terminal", Name: "Legacy", State: session.StateRunning,
		CWD: directory, CreatedAt: createdAt,
	}); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}

	srv, err := New(Config{Token: "token", Shell: "/bin/sh", DatabasePath: databasePath})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	projectsResponse := performRequest(t, srv, http.MethodGet, "/api/projects", "")
	if projectsResponse.Code != http.StatusOK {
		t.Fatalf("projects status = %d, body = %s", projectsResponse.Code, projectsResponse.Body.String())
	}
	var projects []project.Project
	decodeResponse(t, projectsResponse, &projects)
	if len(projects) != 1 || projects[0].Path != directory {
		t.Fatalf("projects = %#v, want one project for %q", projects, directory)
	}
	terminalsResponse := performRequest(t, srv, http.MethodGet, "/api/v1/terminals", "")
	var terminalsEnvelope struct {
		Result struct {
			Terminals []session.Metadata `json:"terminals"`
		} `json:"result"`
	}
	decodeResponse(t, terminalsResponse, &terminalsEnvelope)
	if len(terminalsEnvelope.Result.Terminals) != 1 ||
		terminalsEnvelope.Result.Terminals[0].ProjectID != projects[0].ID {
		t.Fatalf("migrated terminals = %#v, want project %q", terminalsEnvelope.Result.Terminals, projects[0].ID)
	}
	if err := srv.Close(t.Context()); err != nil {
		t.Fatalf("Server.Close() error = %v", err)
	}
}

func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	decodeResponse(t, response, &body)
	if response.Code != status || body.Code != code {
		t.Fatalf("project error = %d %#v, want %d %q; body = %s",
			response.Code, body, status, code, response.Body.String())
	}
}

func assertV1ProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	decodeResponse(t, response, &body)
	if response.Code != status || body.Error.Code != code {
		t.Fatalf("v1 project error = %d %#v, want %d %q; body = %s",
			response.Code, body, status, code, response.Body.String())
	}
}

type disappearingLegacyProjectRepository struct {
	mu         sync.Mutex
	sessions   *session.Manager
	terminalID string
	projects   map[string]project.Project
	listCalls  int
}

func (r *disappearingLegacyProjectRepository) Create(_ context.Context, item project.Project) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.projects[item.ID]; exists {
		return project.ErrAlreadyExists
	}
	r.projects[item.ID] = item
	return nil
}

func (r *disappearingLegacyProjectRepository) Get(_ context.Context, id string) (project.Project, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	item, ok := r.projects[id]
	if !ok {
		return project.Project{}, project.ErrNotFound
	}
	return item, nil
}

func (r *disappearingLegacyProjectRepository) Delete(_ context.Context, id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.projects[id]; !ok {
		return project.ErrNotFound
	}
	delete(r.projects, id)
	return nil
}

func (r *disappearingLegacyProjectRepository) List(_ context.Context) ([]project.Project, error) {
	r.mu.Lock()
	r.listCalls++
	shouldDisappear := r.listCalls == 2
	items := make([]project.Project, 0, len(r.projects))
	for _, item := range r.projects {
		items = append(items, item)
	}
	r.mu.Unlock()
	if shouldDisappear {
		if err := r.sessions.Delete(r.terminalID); err != nil {
			return nil, err
		}
	}
	return items, nil
}

func (*disappearingLegacyProjectRepository) Close() error { return nil }
