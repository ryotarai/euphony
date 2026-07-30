package server

import (
	"errors"
	"net/http"

	"github.com/ryotarai/euphony/internal/gitchanges"
)

func (s *Server) gitChanges(w http.ResponseWriter, r *http.Request) {
	metadata, ok := s.sessions.Metadata(r.PathValue("id"))
	if !ok {
		writeError(
			w,
			http.StatusNotFound,
			"session_not_found",
			"The terminal session does not exist.",
		)
		return
	}

	path, pathRequested, validPath := gitChangesPath(r)
	if !validPath {
		writeError(
			w,
			http.StatusBadRequest,
			"git_change_not_found",
			"Choose a changed file from this repository.",
		)
		return
	}

	var (
		snapshot gitchanges.Snapshot
		err      error
	)
	if pathRequested {
		snapshot, err = gitchanges.ReadSelected(r.Context(), metadata.CWD, path)
	} else {
		snapshot, err = gitchanges.ReadSummary(r.Context(), metadata.CWD)
	}
	switch {
	case errors.Is(err, gitchanges.ErrNotRepository):
		writeError(
			w,
			http.StatusNotFound,
			"git_repository_not_found",
			"This terminal is not inside a Git worktree.",
		)
		return
	case errors.Is(err, gitchanges.ErrChangeNotFound):
		writeError(
			w,
			http.StatusBadRequest,
			"git_change_not_found",
			"Choose a changed file from this repository.",
		)
		return
	case err != nil:
		writeError(
			w,
			http.StatusInternalServerError,
			"git_changes_read_failed",
			"Git changes could not be read.",
		)
		return
	}

	w.Header().Set("Cache-Control", "private, no-cache")
	writeJSON(w, http.StatusOK, snapshot)
}

func gitChangesPath(r *http.Request) (path string, requested bool, valid bool) {
	values, requested := r.URL.Query()["path"]
	if !requested {
		return "", false, true
	}
	if len(values) != 1 || values[0] == "" {
		return "", true, false
	}
	return values[0], true, true
}
