package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/ryotarai/euphony/internal/annotation"
	"github.com/ryotarai/euphony/internal/control"
)

const maxAnnotationContentBytes = 1024 * 1024

type createAnnotationRequest struct {
	TerminalID string            `json:"terminalId"`
	Filename   string            `json:"filename"`
	Format     annotation.Format `json:"format"`
	Content    string            `json:"content"`
}

type completeAnnotationRequest struct {
	Comments []annotation.Comment `json:"comments"`
}

func (s *Server) apiCreateAnnotation(w http.ResponseWriter, r *http.Request) {
	var request createAnnotationRequest
	if err := decodeAPIJSON(r, &request); err != nil {
		writeAPIDecodeError(w, err, "The annotation request must be valid JSON.")
		return
	}
	request.TerminalID = strings.TrimSpace(request.TerminalID)
	request.Filename = strings.TrimSpace(request.Filename)
	if request.TerminalID == "" || request.Filename == "" ||
		(request.Format != annotation.FormatMarkdown && request.Format != annotation.FormatHTML) ||
		request.Content == "" || !utf8.ValidString(request.Content) ||
		len(request.Content) > maxAnnotationContentBytes {
		writeAPIError(w, http.StatusBadRequest, "invalid_request",
			"Annotation terminal, filename, format, and UTF-8 content are required; content must not exceed 1048576 bytes.", nil)
		return
	}
	if _, err := s.control.GetTerminal(request.TerminalID); err != nil {
		if errors.Is(err, control.ErrTerminalNotFound) {
			writeAPIError(w, http.StatusNotFound, "terminal_not_found",
				"The terminal does not exist.", nil)
			return
		}
		writeAPIError(w, http.StatusInternalServerError, "internal_error",
			"The terminal could not be read.", nil)
		return
	}
	session, err := s.annotations.Create(
		request.TerminalID,
		request.Filename,
		request.Format,
		request.Content,
	)
	if errors.Is(err, annotation.ErrActive) {
		writeAPIError(w, http.StatusConflict, "annotation_active",
			"This terminal already has an active annotation.", nil)
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error",
			"The annotation could not be created.", nil)
		return
	}
	s.publishAnnotationEvent("annotation.created", session)
	writeAPIResult(w, http.StatusCreated, map[string]any{"annotation": session})
}

func (s *Server) apiCurrentAnnotation(w http.ResponseWriter, r *http.Request) {
	terminalID := r.PathValue("id")
	if _, err := s.control.GetTerminal(terminalID); err != nil {
		writeAPIError(w, http.StatusNotFound, "terminal_not_found",
			"The terminal does not exist.", nil)
		return
	}
	session, found := s.annotations.Current(terminalID)
	if !found {
		writeAPIResult(w, http.StatusOK, map[string]any{"annotation": nil})
		return
	}
	writeAPIResult(w, http.StatusOK, map[string]any{"annotation": session})
}

func (s *Server) apiWaitAnnotation(w http.ResponseWriter, r *http.Request) {
	result, err := s.annotations.Wait(r.Context(), r.PathValue("id"))
	switch {
	case err == nil:
		writeAPIResult(w, http.StatusOK, result)
	case errors.Is(err, annotation.ErrCanceled):
		writeAPIError(w, http.StatusGone, "annotation_canceled",
			"The annotation was canceled.", nil)
	case errors.Is(err, annotation.ErrNotFound):
		writeAPIError(w, http.StatusNotFound, "annotation_not_found",
			"The annotation does not exist.", nil)
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return
	default:
		writeAPIError(w, http.StatusInternalServerError, "internal_error",
			"The annotation result could not be read.", nil)
	}
}

func (s *Server) apiCompleteAnnotation(w http.ResponseWriter, r *http.Request) {
	var request completeAnnotationRequest
	if err := decodeAPIJSON(r, &request); err != nil {
		writeAPIDecodeError(w, err, "The annotation comments must be valid JSON.")
		return
	}
	comments, valid := normalizeAnnotationComments(request.Comments)
	if !valid {
		writeAPIError(w, http.StatusBadRequest, "invalid_request",
			"Each comment must have a valid kind and non-empty body; selection comments also require a quote and ordered offsets.", nil)
		return
	}
	result, session, err := s.annotations.Complete(r.PathValue("id"), comments)
	if errors.Is(err, annotation.ErrNotFound) {
		writeAPIError(w, http.StatusNotFound, "annotation_not_found",
			"The annotation does not exist.", nil)
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error",
			"The annotation could not be completed.", nil)
		return
	}
	s.publishAnnotationEvent("annotation.completed", session)
	writeAPIResult(w, http.StatusOK, result)
}

func (s *Server) apiCancelAnnotation(w http.ResponseWriter, r *http.Request) {
	session, err := s.annotations.Cancel(r.PathValue("id"))
	if errors.Is(err, annotation.ErrNotFound) {
		writeAPIError(w, http.StatusNotFound, "annotation_not_found",
			"The annotation does not exist.", nil)
		return
	}
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "internal_error",
			"The annotation could not be canceled.", nil)
		return
	}
	s.publishAnnotationEvent("annotation.canceled", session)
	writeAPIResult(w, http.StatusOK, map[string]string{"id": session.ID})
}

func normalizeAnnotationComments(comments []annotation.Comment) ([]annotation.Comment, bool) {
	if comments == nil {
		return []annotation.Comment{}, true
	}
	normalized := make([]annotation.Comment, len(comments))
	for index, comment := range comments {
		comment.Body = strings.TrimSpace(comment.Body)
		if comment.Body == "" {
			return nil, false
		}
		switch comment.Kind {
		case annotation.CommentGlobal:
			if comment.Quote != "" || comment.StartOffset != nil || comment.EndOffset != nil {
				return nil, false
			}
		case annotation.CommentSelection:
			if strings.TrimSpace(comment.Quote) == "" ||
				comment.StartOffset == nil || comment.EndOffset == nil ||
				*comment.StartOffset < 0 || *comment.EndOffset <= *comment.StartOffset {
				return nil, false
			}
		default:
			return nil, false
		}
		normalized[index] = comment
	}
	return normalized, true
}

func (s *Server) publishAnnotationEvent(eventType string, session annotation.Session) {
	s.control.Publish(eventType, map[string]string{
		"id":         session.ID,
		"terminalId": session.TerminalID,
	})
}
