package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/ryotarai/euphony/internal/project"
	"github.com/ryotarai/euphony/internal/session"
)

func (s *Server) listProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := s.projects.List(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "projects_list_failed",
			"The projects could not be loaded.")
		return
	}
	writeJSON(w, http.StatusOK, projects)
}

func (s *Server) createProject(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Path string `json:"path"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request",
			"Provide one project directory object.")
		return
	}
	if err := ensureJSONEnd(decoder); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request",
			"Provide one project directory object.")
		return
	}
	if strings.TrimSpace(request.Path) == "" {
		writeError(w, http.StatusBadRequest, "invalid_path",
			"Choose an existing project directory.")
		return
	}
	created, err := s.projects.Create(r.Context(), request.Path)
	if err != nil {
		switch {
		case errors.Is(err, project.ErrAlreadyExists):
			writeError(w, http.StatusConflict, "project_exists",
				"A project for this directory already exists.")
		case isInvalidProjectPath(err):
			writeError(w, http.StatusBadRequest, "invalid_path",
				"Choose an existing project directory.")
		default:
			writeError(w, http.StatusInternalServerError, "project_create_failed",
				"The project could not be created.")
		}
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func isInvalidProjectPath(err error) bool {
	message := err.Error()
	return strings.Contains(message, "normalize project path") ||
		strings.Contains(message, "stat project path") ||
		strings.Contains(message, "project path is not a directory")
}

func migrateLegacyProjects(
	ctx context.Context, sessions *session.Manager, projects *project.Service,
) error {
	known, err := projects.List(ctx)
	if err != nil {
		return fmt.Errorf("list projects for terminal migration: %w", err)
	}
	byPath := make(map[string]project.Project, len(known))
	for _, item := range known {
		byPath[item.Path] = item
	}
	for _, metadata := range sessions.ListCurrent() {
		if metadata.ProjectID != "" {
			continue
		}
		path, err := filepath.Abs(filepath.Clean(metadata.CWD))
		if err != nil {
			return fmt.Errorf("normalize legacy terminal %s directory: %w", metadata.ID, err)
		}
		item, ok := byPath[path]
		if !ok {
			item, err = projects.Create(ctx, path)
			if err != nil {
				return fmt.Errorf("create project for legacy terminal %s: %w", metadata.ID, err)
			}
			byPath[item.Path] = item
		}
		if _, err := sessions.AssignProject(metadata.ID, item.ID); err != nil {
			return fmt.Errorf("assign legacy terminal %s to project %s: %w",
				metadata.ID, item.ID, err)
		}
	}
	return nil
}
