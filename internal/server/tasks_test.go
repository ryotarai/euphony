package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/ryotarai/euphony/internal/agentsummary"
	"github.com/ryotarai/euphony/internal/tasks"
)

func TestTaskEndpointsSupportCRUDAndRefinement(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "euphony.sqlite3")
	refiner := taskTestRefiner{result: agentsummary.TaskRefinement{
		Title: "Refined API task", Description: "Add tests and handler.",
		Priority: tasks.PriorityHigh, Status: tasks.StatusTodo, Rationale: "It is actionable.",
	}}
	srv, err := New(Config{Token: "token", Shell: "/bin/sh", DatabasePath: databasePath, TaskRefiner: refiner})
	if err != nil {
		t.Fatal(err)
	}
	created := performRequest(t, srv, http.MethodPost, "/api/tasks",
		`{"title":"Build task API","description":"Persist work","priority":"medium"}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("POST /api/tasks status = %d, body = %s", created.Code, created.Body.String())
	}
	var task tasks.Task
	decodeResponse(t, created, &task)
	if task.ID == "" || task.Status != tasks.StatusTodo || task.Priority != tasks.PriorityMedium {
		t.Fatalf("created task = %#v", task)
	}

	updated := performRequest(t, srv, http.MethodPatch, "/api/tasks/"+task.ID,
		`{"status":"in_progress","priority":"high"}`)
	if updated.Code != http.StatusOK {
		t.Fatalf("PATCH /api/tasks status = %d, body = %s", updated.Code, updated.Body.String())
	}
	decodeResponse(t, updated, &task)
	if task.Status != tasks.StatusInProgress || task.Priority != tasks.PriorityHigh {
		t.Fatalf("updated task = %#v", task)
	}

	refined := performRequest(t, srv, http.MethodPost, "/api/tasks/"+task.ID+"/refine", `{}`)
	if refined.Code != http.StatusOK {
		t.Fatalf("POST refine status = %d, body = %s", refined.Code, refined.Body.String())
	}
	var proposal agentsummary.TaskRefinement
	decodeResponse(t, refined, &proposal)
	if proposal.Title != "Refined API task" || proposal.Priority != tasks.PriorityHigh {
		t.Fatalf("refinement = %#v", proposal)
	}

	listed := performRequest(t, srv, http.MethodGet, "/api/tasks", "")
	if listed.Code != http.StatusOK {
		t.Fatalf("GET /api/tasks status = %d, body = %s", listed.Code, listed.Body.String())
	}
	var list []tasks.Task
	decodeResponse(t, listed, &list)
	if len(list) != 1 || list[0].ID != task.ID || len(list[0].Updates) != 0 {
		t.Fatalf("task list = %#v", list)
	}

	deleted := performRequest(t, srv, http.MethodDelete, "/api/tasks/"+task.ID, "")
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("DELETE /api/tasks status = %d, body = %s", deleted.Code, deleted.Body.String())
	}
	missing := performRequest(t, srv, http.MethodGet, "/api/tasks/"+task.ID, "")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("GET deleted task status = %d", missing.Code)
	}
	if err := srv.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestTaskEndpointsValidateAndRequireAuthentication(t *testing.T) {
	srv, err := New(Config{Token: "token", Shell: "/bin/sh", TaskRefiner: taskTestRefiner{}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = srv.Close(context.Background()) })
	invalid := performRequest(t, srv, http.MethodPost, "/api/tasks",
		`{"title":"Bad","priority":"urgent","status":"todo"}`)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid task status = %d, body = %s", invalid.Code, invalid.Body.String())
	}
	invalidStart := performRequest(t, srv, http.MethodPost, "/api/tasks/missing/start",
		`{"agent":"gemini"}`)
	if invalidStart.Code != http.StatusBadRequest {
		t.Fatalf("invalid start status = %d, body = %s", invalidStart.Code, invalidStart.Body.String())
	}
	request := httptest.NewRequest(http.MethodGet, "/api/tasks", nil)
	response := httptest.NewRecorder()
	srv.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated task list status = %d", response.Code)
	}
}

type taskTestRefiner struct {
	result agentsummary.TaskRefinement
}

func (r taskTestRefiner) Refine(_ context.Context, _ string, _ string) (agentsummary.TaskRefinement, error) {
	return r.result, nil
}
