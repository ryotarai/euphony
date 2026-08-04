package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/tasks"
)

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	result, err := s.tasks.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "task_list_failed", "Tasks could not be loaded.")
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) getTask(w http.ResponseWriter, r *http.Request) {
	task, err := s.tasks.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		writeTaskError(w, err, "get")
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (s *Server) createTask(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Title       string `json:"title"`
		Description string `json:"description"`
		Priority    string `json:"priority"`
		Status      string `json:"status"`
	}
	if err := decodeTaskJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "task_invalid", "Provide one valid task object.")
		return
	}
	task, err := s.tasks.Create(r.Context(), tasks.CreateInput{
		Title: input.Title, Description: input.Description,
		Priority: input.Priority, Status: input.Status,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "task_invalid", err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, task)
}

func (s *Server) updateTask(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Title       *string `json:"title"`
		Description *string `json:"description"`
		Priority    *string `json:"priority"`
		Status      *string `json:"status"`
	}
	if err := decodeTaskJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "task_invalid", "Provide one valid task update object.")
		return
	}
	task, err := s.tasks.Update(r.Context(), r.PathValue("id"), tasks.UpdateInput{
		Title: input.Title, Description: input.Description,
		Priority: input.Priority, Status: input.Status,
	})
	if err != nil {
		writeTaskError(w, err, "update")
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (s *Server) deleteTask(w http.ResponseWriter, r *http.Request) {
	if err := s.tasks.Delete(r.Context(), r.PathValue("id")); err != nil {
		writeTaskError(w, err, "delete")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) startTaskAgent(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Agent string `json:"agent"`
		CWD   string `json:"cwd"`
	}
	if err := decodeTaskJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "task_invalid", "Provide one valid agent start object.")
		return
	}
	if input.Agent != "claude" && input.Agent != "codex" {
		writeError(w, http.StatusBadRequest, "task_invalid_agent", "agent must be claude or codex.")
		return
	}
	task, err := s.tasks.StartAgent(r.Context(), r.PathValue("id"), tasks.StartInput{
		Agent: input.Agent, CWD: input.CWD,
	})
	if err != nil {
		writeTaskError(w, err, "start")
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (s *Server) promptTaskAgent(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Prompt string `json:"prompt"`
	}
	if err := decodeTaskJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "task_invalid", "Provide one valid agent instruction object.")
		return
	}
	task, err := s.tasks.Prompt(r.Context(), r.PathValue("id"), input.Prompt)
	if err != nil {
		writeTaskError(w, err, "prompt")
		return
	}
	writeJSON(w, http.StatusOK, task)
}

func (s *Server) refineTask(w http.ResponseWriter, r *http.Request) {
	var input map[string]json.RawMessage
	if err := decodeTaskJSON(r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "task_invalid", "Provide one valid refinement request object.")
		return
	}
	proposal, err := s.tasks.Refine(r.Context(), r.PathValue("id"))
	if err != nil {
		if errors.Is(err, tasks.ErrNotFound) {
			writeTaskError(w, err, "refine")
			return
		}
		writeError(w, http.StatusBadGateway, "task_refinement_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, proposal)
}

func decodeTaskJSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return ensureJSONEnd(decoder)
}

func writeTaskError(w http.ResponseWriter, err error, operation string) {
	switch {
	case errors.Is(err, tasks.ErrNotFound), errors.Is(err, control.ErrTerminalNotFound):
		writeError(w, http.StatusNotFound, "task_not_found", "The task does not exist.")
	case errors.Is(err, control.ErrAgentNotRunning), errors.Is(err, control.ErrAgentAlreadyRunning):
		writeError(w, http.StatusConflict, "task_agent_not_running", "The task does not have an available agent.")
	case errors.Is(err, context.DeadlineExceeded):
		writeError(w, http.StatusRequestTimeout, "task_start_failed", "The agent did not reach a usable state in time.")
	case strings.Contains(err.Error(), "working directory"):
		writeError(w, http.StatusBadRequest, "task_invalid_cwd", "Choose an existing working directory.")
	case operation == "update":
		writeError(w, http.StatusBadRequest, "task_invalid", err.Error())
	case operation == "refine":
		writeError(w, http.StatusBadGateway, "task_refinement_failed", err.Error())
	default:
		writeError(w, http.StatusInternalServerError, "task_operation_failed", err.Error())
	}
}
