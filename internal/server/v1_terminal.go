package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/session"
)

func (s *Server) v1ListTerminals(w http.ResponseWriter, _ *http.Request) {
	writeV1Result(w, http.StatusOK, map[string]any{
		"terminals": s.control.ListTerminals(),
	})
}

func (s *Server) v1CreateTerminal(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Name          string                `json:"name"`
		CWD           string                `json:"cwd"`
		SelectionMode control.SelectionMode `json:"selectionMode"`
	}
	if err := decodeV1JSON(r, &request); err != nil {
		writeV1DecodeError(w, err, "Provide one valid terminal creation object.")
		return
	}
	if strings.TrimSpace(request.Name) == "" {
		request.Name = "Terminal"
	}
	metadata, selected, err := s.control.CreateTerminal(
		r.Context(),
		request.Name,
		request.CWD,
		request.SelectionMode,
	)
	if err != nil {
		switch {
		case errors.Is(err, control.ErrInvalidInput):
			writeV1Error(w, http.StatusBadRequest, "invalid_selection_mode",
				"selectionMode must be none, add, or replace.", nil)
		case strings.Contains(err.Error(), "working directory"):
			writeV1Error(w, http.StatusBadRequest, "invalid_cwd",
				"Choose an existing working directory.", nil)
		case strings.Contains(err.Error(), "name"):
			writeV1Error(w, http.StatusBadRequest, "invalid_name",
				"Terminal names must contain 1 to 80 characters.", nil)
		default:
			writeV1Error(w, http.StatusInternalServerError, "terminal_create_failed",
				"The terminal could not be created.", nil)
		}
		return
	}
	writeV1Result(w, http.StatusCreated, map[string]any{
		"terminal":  metadata,
		"selection": selected,
	})
}

func (s *Server) v1GetTerminal(w http.ResponseWriter, r *http.Request) {
	metadata, err := s.control.GetTerminal(r.PathValue("id"))
	if err != nil {
		writeTerminalControlError(w, err)
		return
	}
	writeV1Result(w, http.StatusOK, map[string]any{"terminal": metadata})
}

func (s *Server) v1DeleteTerminal(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	selected, err := s.control.DeleteTerminal(id)
	if err != nil {
		writeTerminalControlError(w, err)
		return
	}
	writeV1Result(w, http.StatusOK, map[string]any{
		"id":        id,
		"selection": selected,
	})
}

func (s *Server) v1ReadTerminal(w http.ResponseWriter, r *http.Request) {
	maxBytes := control.DefaultTerminalReadBytes
	if value := r.URL.Query().Get("maxBytes"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > control.MaxTerminalReadBytes {
			writeV1Error(w, http.StatusBadRequest, "invalid_max_bytes",
				"maxBytes must be between 1 and 16777216.", nil)
			return
		}
		maxBytes = parsed
	}
	result, err := s.control.ReadTerminal(r.PathValue("id"), maxBytes)
	if err != nil {
		writeTerminalControlError(w, err)
		return
	}
	writeV1Result(w, http.StatusOK, result)
}

func (s *Server) v1SendTerminalInput(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Text       *string  `json:"text"`
		DataBase64 string   `json:"dataBase64"`
		Keys       []string `json:"keys"`
	}
	if err := decodeV1JSON(r, &request); err != nil {
		writeV1DecodeError(w, err, "Provide one valid terminal input object.")
		return
	}
	err := s.control.SendTerminalInput(r.PathValue("id"), control.TerminalInput{
		Text:       request.Text,
		DataBase64: request.DataBase64,
		Keys:       request.Keys,
	})
	if err != nil {
		writeTerminalControlError(w, err)
		return
	}
	writeV1Result(w, http.StatusOK, map[string]bool{"accepted": true})
}

func (s *Server) v1RunTerminal(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Command string `json:"command"`
	}
	if err := decodeV1JSON(r, &request); err != nil {
		writeV1DecodeError(w, err, "Provide one valid terminal command object.")
		return
	}
	if err := s.control.RunTerminal(r.PathValue("id"), request.Command); err != nil {
		writeTerminalControlError(w, err)
		return
	}
	writeV1Result(w, http.StatusOK, map[string]bool{"accepted": true})
}

func (s *Server) v1WaitTerminalOutput(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Match     string `json:"match"`
		Regex     string `json:"regex"`
		TimeoutMS int    `json:"timeoutMs"`
		MaxBytes  *int   `json:"maxBytes"`
	}
	if err := decodeV1JSON(r, &request); err != nil {
		writeV1DecodeError(w, err, "Provide one valid terminal output wait object.")
		return
	}
	ctx := r.Context()
	var cancel context.CancelFunc
	if request.TimeoutMS < 0 ||
		request.TimeoutMS > int((24*time.Hour).Milliseconds()) {
		writeV1Error(w, http.StatusBadRequest, "invalid_timeout",
			"timeoutMs must be between 0 and 86400000.", nil)
		return
	}
	if request.TimeoutMS > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(request.TimeoutMS)*time.Millisecond)
		defer cancel()
	}
	maxBytes := 0
	if request.MaxBytes != nil {
		if *request.MaxBytes < 1 || *request.MaxBytes > control.MaxTerminalReadBytes {
			writeV1Error(w, http.StatusBadRequest, "invalid_max_bytes",
				"maxBytes must be between 1 and 16777216.", nil)
			return
		}
		maxBytes = *request.MaxBytes
	}
	result, err := s.control.WaitOutput(ctx, r.PathValue("id"), control.OutputMatch{
		Literal:  request.Match,
		Regex:    request.Regex,
		MaxBytes: maxBytes,
	})
	if err != nil {
		writeTerminalControlError(w, err)
		return
	}
	writeV1Result(w, http.StatusOK, result)
}

func (s *Server) v1CreateTerminalTicket(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Mode string `json:"mode"`
	}
	if err := decodeV1JSON(r, &request); err != nil {
		writeV1DecodeError(w, err, "Provide one valid terminal stream ticket object.")
		return
	}
	if request.Mode != "observe" && request.Mode != "control" {
		writeV1Error(w, http.StatusBadRequest, "invalid_stream_mode",
			"mode must be observe or control.", nil)
		return
	}
	id := r.PathValue("id")
	if _, err := s.control.GetTerminal(id); err != nil {
		writeTerminalControlError(w, err)
		return
	}
	ticket, err := s.tickets.createWithMode(id, request.Mode == "observe")
	if err != nil {
		writeV1Error(w, http.StatusInternalServerError, "ticket_failed",
			"A terminal stream ticket could not be created.", nil)
		return
	}
	writeV1Result(w, http.StatusCreated, map[string]string{
		"ticket": ticket,
		"mode":   request.Mode,
	})
}

func writeTerminalControlError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, control.ErrTerminalNotFound),
		errors.Is(err, session.ErrNotFound):
		writeV1Error(w, http.StatusNotFound, "terminal_not_found",
			"The terminal does not exist.", nil)
	case errors.Is(err, control.ErrTerminalBusy):
		writeV1Error(w, http.StatusConflict, "terminal_busy",
			"The terminal foreground is not an available shell.", nil)
	case errors.Is(err, control.ErrInvalidKey):
		writeV1Error(w, http.StatusBadRequest, "invalid_key", err.Error(), nil)
	case errors.Is(err, control.ErrInvalidInput):
		writeV1Error(w, http.StatusBadRequest, "invalid_input",
			"Provide exactly one non-empty text, dataBase64, or keys input.", nil)
	case errors.Is(err, control.ErrInvalidOutputMatch):
		writeV1Error(w, http.StatusBadRequest, "invalid_output_match", err.Error(), nil)
	case errors.Is(err, context.DeadlineExceeded):
		writeV1Error(w, http.StatusRequestTimeout, "timeout",
			"Timed out waiting for terminal output.", nil)
	case errors.Is(err, context.Canceled):
		writeV1Error(w, http.StatusRequestTimeout, "request_canceled",
			"The terminal output wait was canceled.", nil)
	case errors.Is(err, control.ErrTerminalClosed):
		writeV1Error(w, http.StatusConflict, "terminal_closed",
			"The terminal closed before output matched.", nil)
	case errors.Is(err, control.ErrOutputSubscriberLagged):
		writeV1Error(w, http.StatusConflict, "subscriber_lagged",
			"The terminal output subscriber fell behind.", nil)
	default:
		writeV1Error(w, http.StatusInternalServerError, "terminal_operation_failed",
			"The terminal operation failed.", nil)
	}
}
