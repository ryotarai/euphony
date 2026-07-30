package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/ryotarai/euphony/internal/control"
)

const (
	defaultAgentTimeout = 30 * time.Second
	maxAgentTimeout     = 5 * time.Minute
)

func (s *Server) v1ListAgents(w http.ResponseWriter, _ *http.Request) {
	writeV1Result(w, http.StatusOK, map[string]any{"agents": s.control.ListAgents()})
}

func (s *Server) v1GetAgent(w http.ResponseWriter, r *http.Request) {
	agent, err := s.control.GetAgent(r.PathValue("id"))
	if err != nil {
		writeAgentControlError(w, err, "get")
		return
	}
	writeV1Result(w, http.StatusOK, map[string]any{"agent": agent})
}

func (s *Server) v1StartAgent(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Kind      string   `json:"kind"`
		Args      []string `json:"args"`
		TimeoutMS int      `json:"timeoutMs"`
	}
	if err := decodeV1JSON(r, &request); err != nil {
		writeV1DecodeError(w, err, "Provide one valid agent start object.")
		return
	}
	ctx, cancel, ok := agentTimeoutContext(r.Context(), request.TimeoutMS)
	if !ok {
		writeV1Error(w, http.StatusBadRequest, "invalid_timeout",
			"timeoutMs must be between 1 and 300000.", nil)
		return
	}
	defer cancel()
	agent, err := s.control.StartAgent(ctx, r.PathValue("id"), request.Kind, request.Args)
	if err != nil {
		writeAgentControlError(w, err, "start")
		return
	}
	writeV1Result(w, http.StatusOK, map[string]any{"agent": agent})
}

func (s *Server) v1ReadAgent(w http.ResponseWriter, r *http.Request) {
	agent, err := s.control.GetAgent(r.PathValue("id"))
	if err != nil {
		writeAgentControlError(w, err, "read")
		return
	}
	source := r.URL.Query().Get("source")
	if source == "" {
		source = "transcript"
	}
	switch source {
	case "transcript":
		transcript, _, _, err := s.loadAgentTranscript(agent)
		if errors.Is(err, errAgentLogNotLinked) || errors.Is(err, errAgentLogNotFound) {
			writeV1Error(w, http.StatusNotFound, "agent_log_not_found",
				"The linked agent transcript is not available yet.", nil)
			return
		}
		if err != nil {
			writeV1Error(w, http.StatusInternalServerError, "agent_log_read_failed",
				"The linked agent transcript could not be read.", nil)
			return
		}
		writeV1Result(w, http.StatusOK, transcript)
	case "terminal":
		maxBytes := control.DefaultTerminalReadBytes
		if raw := r.URL.Query().Get("maxBytes"); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 1 || parsed > control.MaxTerminalReadBytes {
				writeV1Error(w, http.StatusBadRequest, "invalid_max_bytes",
					"maxBytes must be between 1 and 16777216.", nil)
				return
			}
			maxBytes = parsed
		}
		result, err := s.control.ReadTerminal(agent.ID, maxBytes)
		if err != nil {
			writeTerminalControlError(w, err)
			return
		}
		writeV1Result(w, http.StatusOK, result)
	default:
		writeV1Error(w, http.StatusBadRequest, "invalid_output_source",
			"source must be transcript or terminal.", nil)
	}
}

func (s *Server) v1SendAgentInput(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Keys []string `json:"keys"`
	}
	if err := decodeV1JSON(r, &request); err != nil {
		writeV1DecodeError(w, err, "Provide one valid agent input object.")
		return
	}
	agent, err := s.control.SendAgentKeys(r.PathValue("id"), request.Keys)
	if err != nil {
		writeAgentControlError(w, err, "input")
		return
	}
	writeV1Result(w, http.StatusOK, map[string]any{"accepted": true, "agent": agent})
}

func (s *Server) v1PromptAgent(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Prompt    string   `json:"prompt"`
		Wait      *bool    `json:"wait"`
		Until     []string `json:"until"`
		TimeoutMS int      `json:"timeoutMs"`
	}
	if err := decodeV1JSON(r, &request); err != nil {
		writeV1DecodeError(w, err, "Provide one valid agent prompt object.")
		return
	}
	if len(request.Until) > 0 && (request.Wait == nil || !*request.Wait) {
		writeV1Error(w, http.StatusBadRequest, "invalid_request",
			"until requires wait to be true.", nil)
		return
	}
	wait := request.Wait != nil && *request.Wait
	ctx := r.Context()
	cancel := func() {}
	if wait {
		var ok bool
		ctx, cancel, ok = agentTimeoutContext(ctx, request.TimeoutMS)
		if !ok {
			writeV1Error(w, http.StatusBadRequest, "invalid_timeout",
				"timeoutMs must be between 1 and 300000.", nil)
			return
		}
	}
	defer cancel()
	agent, err := s.control.PromptAgent(ctx, r.PathValue("id"), request.Prompt, wait, request.Until)
	if err != nil {
		writeAgentControlError(w, err, "prompt")
		return
	}
	writeV1Result(w, http.StatusOK, map[string]any{"accepted": true, "agent": agent})
}

func (s *Server) v1WaitAgent(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Until     []string `json:"until"`
		TimeoutMS int      `json:"timeoutMs"`
	}
	if err := decodeV1JSON(r, &request); err != nil {
		writeV1DecodeError(w, err, "Provide one valid agent wait object.")
		return
	}
	ctx, cancel, ok := agentTimeoutContext(r.Context(), request.TimeoutMS)
	if !ok {
		writeV1Error(w, http.StatusBadRequest, "invalid_timeout",
			"timeoutMs must be between 1 and 300000.", nil)
		return
	}
	defer cancel()
	agent, err := s.control.WaitAgent(ctx, r.PathValue("id"), request.Until)
	if err != nil {
		writeAgentControlError(w, err, "wait")
		return
	}
	writeV1Result(w, http.StatusOK, map[string]any{"agent": agent})
}

func agentTimeoutContext(
	parent context.Context,
	timeoutMS int,
) (context.Context, context.CancelFunc, bool) {
	timeout := defaultAgentTimeout
	if timeoutMS != 0 {
		timeout = time.Duration(timeoutMS) * time.Millisecond
	}
	if timeout <= 0 || timeout > maxAgentTimeout {
		return parent, func() {}, false
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	return ctx, cancel, true
}

func writeAgentControlError(w http.ResponseWriter, err error, operation string) {
	switch {
	case errors.Is(err, control.ErrTerminalNotFound):
		writeV1Error(w, http.StatusNotFound, "terminal_not_found",
			"The terminal does not exist.", nil)
	case errors.Is(err, control.ErrAgentNotRunning):
		writeV1Error(w, http.StatusConflict, "agent_not_running",
			"The terminal is not running an identified agent.", nil)
	case errors.Is(err, control.ErrAgentAlreadyRunning):
		writeV1Error(w, http.StatusConflict, "agent_already_running",
			"The terminal already runs an identified agent.", nil)
	case errors.Is(err, control.ErrUnsupportedAgent):
		writeV1Error(w, http.StatusBadRequest, "unsupported_agent",
			"kind must be codex or claude.", nil)
	case errors.Is(err, control.ErrInvalidAgentState):
		writeV1Error(w, http.StatusBadRequest, "invalid_agent_state", err.Error(), nil)
	case errors.Is(err, control.ErrInvalidAgentInput),
		errors.Is(err, control.ErrInvalidInput),
		errors.Is(err, control.ErrInvalidKey):
		writeV1Error(w, http.StatusBadRequest, "invalid_agent_input", err.Error(), nil)
	case errors.Is(err, context.DeadlineExceeded):
		details := any(nil)
		if operation == "start" {
			details = map[string]string{
				"hint": "Install the Euphony hook integration for the selected agent.",
			}
		}
		writeV1Error(w, http.StatusRequestTimeout, "timeout",
			"Timed out waiting for the agent state.", details)
	case errors.Is(err, context.Canceled):
		writeV1Error(w, http.StatusRequestTimeout, "request_canceled",
			"The agent operation was canceled.", nil)
	default:
		writeTerminalControlError(w, err)
	}
}
