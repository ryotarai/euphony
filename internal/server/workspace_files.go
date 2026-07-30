package server

import (
	"errors"
	"net/http"

	"github.com/ryotarai/euphony/internal/workspacefiles"
)

func (s *Server) workspaceDirectory(w http.ResponseWriter, r *http.Request) {
	reader, ok := s.workspaceReader(w, r)
	if !ok {
		return
	}
	defer reader.Close()
	path, valid := optionalSingleQueryValue(r, "path")
	if !valid {
		writeWorkspaceError(w, workspacefiles.ErrInvalidPath)
		return
	}
	directory, err := reader.Directory(path)
	if err != nil {
		writeWorkspaceError(w, err)
		return
	}
	writeWorkspaceJSON(w, directory)
}

func (s *Server) workspaceSearch(w http.ResponseWriter, r *http.Request) {
	reader, ok := s.workspaceReader(w, r)
	if !ok {
		return
	}
	defer reader.Close()
	query, valid := requiredSingleQueryValue(r, "query")
	if !valid {
		writeWorkspaceError(w, workspacefiles.ErrInvalidQuery)
		return
	}
	result, err := reader.Search(query)
	if err != nil {
		writeWorkspaceError(w, err)
		return
	}
	writeWorkspaceJSON(w, result)
}

func (s *Server) workspaceFile(w http.ResponseWriter, r *http.Request) {
	reader, ok := s.workspaceReader(w, r)
	if !ok {
		return
	}
	defer reader.Close()
	path, valid := requiredSingleQueryValue(r, "path")
	if !valid {
		writeWorkspaceError(w, workspacefiles.ErrInvalidPath)
		return
	}
	file, err := reader.File(path)
	if err != nil {
		writeWorkspaceError(w, err)
		return
	}
	writeWorkspaceJSON(w, file)
}

func (s *Server) workspaceReader(
	w http.ResponseWriter,
	r *http.Request,
) (*workspacefiles.Reader, bool) {
	metadata, ok := s.sessions.Metadata(r.PathValue("id"))
	if !ok {
		writeError(
			w,
			http.StatusNotFound,
			"session_not_found",
			"The terminal session does not exist.",
		)
		return nil, false
	}
	reader, err := workspacefiles.New(r.Context(), metadata.CWD)
	if err != nil {
		writeWorkspaceError(w, err)
		return nil, false
	}
	return reader, true
}

func writeWorkspaceJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Cache-Control", "private, no-cache")
	writeJSON(w, http.StatusOK, value)
}

func writeWorkspaceError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, workspacefiles.ErrInvalidPath):
		writeError(
			w,
			http.StatusBadRequest,
			"workspace_path_invalid",
			"Choose a path inside this terminal workspace.",
		)
	case errors.Is(err, workspacefiles.ErrInvalidQuery):
		writeError(
			w,
			http.StatusBadRequest,
			"workspace_search_invalid",
			"Enter a workspace search query.",
		)
	case errors.Is(err, workspacefiles.ErrPathNotFound):
		writeError(
			w,
			http.StatusNotFound,
			"workspace_path_not_found",
			"The workspace path does not exist.",
		)
	case errors.Is(err, workspacefiles.ErrTypeMismatch):
		writeError(
			w,
			http.StatusBadRequest,
			"workspace_path_type_mismatch",
			"The workspace path has the wrong type.",
		)
	default:
		writeError(
			w,
			http.StatusInternalServerError,
			"workspace_read_failed",
			"The terminal workspace could not be read.",
		)
	}
}

func optionalSingleQueryValue(r *http.Request, name string) (string, bool) {
	values, exists := r.URL.Query()[name]
	if !exists {
		return "", true
	}
	if len(values) != 1 {
		return "", false
	}
	return values[0], true
}

func requiredSingleQueryValue(r *http.Request, name string) (string, bool) {
	value, valid := optionalSingleQueryValue(r, name)
	return value, valid && value != ""
}
