package server

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/agentsummary"
	"github.com/ryotarai/euphony/internal/annotation"
	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/session"
	"github.com/ryotarai/euphony/internal/tasks"
	webassets "github.com/ryotarai/euphony/web"
)

type Config struct {
	Token              string
	Shell              string
	HookURL            string
	DatabasePath       string
	CodexSessionIndex  string
	CodexSessionsRoot  string
	ClaudeProjectsRoot string
	SummaryRunner      agentsummary.Runner
	TaskRefiner        agentsummary.Refiner
	Assets             fs.FS
}

type Server struct {
	handler       http.Handler
	sessions      *session.Manager
	control       *control.Service
	tickets       *ticketStore
	terminalSizes *terminalSizeCoordinator
	agentLogs     *agentlog.Resolver
	annotations   *annotation.Store
	summaries     *agentsummary.Service
	tasks         *tasks.Service
}

func New(config Config) (*Server, error) {
	if config.Token == "" {
		return nil, errors.New("EUPHONY_TOKEN is required")
	}

	hooks := session.HookConfig{
		URL:               config.HookURL,
		Token:             config.Token,
		CodexSessionIndex: config.CodexSessionIndex,
	}
	var sessionManager *session.Manager
	var err error
	if config.DatabasePath == "" {
		sessionManager = session.NewManager(config.Shell, hooks)
	} else {
		sessionManager, err = session.NewPersistentManager(config.Shell, hooks, config.DatabasePath)
		if err != nil {
			return nil, err
		}
	}
	tickets := newTicketStore(time.Now)
	controlService, err := control.New(sessionManager)
	if err != nil {
		_ = sessionManager.Close(context.Background())
		return nil, err
	}
	transcriptResolver := agentlog.NewResolver(config.CodexSessionsRoot, config.ClaudeProjectsRoot)
	summaryService := agentsummary.New(agentsummary.Config{
		Sessions: sessionManager,
		Events:   controlService,
		Resolver: transcriptResolver,
		Runner:   config.SummaryRunner,
	})
	taskStore, err := tasks.OpenStore(config.DatabasePath)
	if err != nil {
		_ = sessionManager.Close(context.Background())
		return nil, err
	}
	taskService, err := tasks.New(tasks.Config{
		Store: taskStore, Agents: controlService, Events: controlService,
		Selection: controlService,
		Provider:  func() string { return sessionManager.Settings().AgentSummaryProvider },
		Refiner:   config.TaskRefiner,
	})
	if err != nil {
		_ = taskStore.Close()
		_ = sessionManager.Close(context.Background())
		return nil, err
	}
	server := &Server{
		sessions:      sessionManager,
		control:       controlService,
		tickets:       tickets,
		terminalSizes: newTerminalSizeCoordinator(),
		agentLogs:     transcriptResolver,
		annotations:   annotation.NewStore(time.Now, uuid.NewString),
		summaries:     summaryService,
		tasks:         taskService,
	}
	summaryService.Start()
	taskService.Start()

	public := http.NewServeMux()
	public.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	public.HandleFunc("GET /api/v1/status", v1Status)
	public.HandleFunc("GET /api/v1/schema", v1Schema)
	public.HandleFunc("GET /api/sessions/{id}/terminal", server.terminal)
	public.HandleFunc("GET /api/v1/terminals/{id}/stream", server.v1TerminalStream)

	protected := http.NewServeMux()
	protected.HandleFunc("GET /api/v1/events", server.v1Events)
	protected.HandleFunc("GET /api/v1/terminals", server.v1ListTerminals)
	protected.HandleFunc("POST /api/v1/terminals", server.v1CreateTerminal)
	protected.HandleFunc("GET /api/v1/terminals/{id}", server.v1GetTerminal)
	protected.HandleFunc("DELETE /api/v1/terminals/{id}", server.v1DeleteTerminal)
	protected.HandleFunc("GET /api/v1/terminals/{id}/output", server.v1ReadTerminal)
	protected.HandleFunc("POST /api/v1/terminals/{id}/input", server.v1SendTerminalInput)
	protected.HandleFunc("POST /api/v1/terminals/{id}/run", server.v1RunTerminal)
	protected.HandleFunc("POST /api/v1/terminals/{id}/wait-output", server.v1WaitTerminalOutput)
	protected.HandleFunc("POST /api/v1/terminals/{id}/tickets", server.v1CreateTerminalTicket)
	protected.HandleFunc("GET /api/v1/terminals/{id}/annotation", server.v1CurrentAnnotation)
	protected.HandleFunc("POST /api/v1/annotations", server.v1CreateAnnotation)
	protected.HandleFunc("GET /api/v1/annotations/{id}/wait", server.v1WaitAnnotation)
	protected.HandleFunc("POST /api/v1/annotations/{id}/complete", server.v1CompleteAnnotation)
	protected.HandleFunc("DELETE /api/v1/annotations/{id}", server.v1CancelAnnotation)
	protected.HandleFunc("GET /api/v1/agents", server.v1ListAgents)
	protected.HandleFunc("GET /api/v1/agents/{id}", server.v1GetAgent)
	protected.HandleFunc("POST /api/v1/agents/{id}/start", server.v1StartAgent)
	protected.HandleFunc("GET /api/v1/agents/{id}/output", server.v1ReadAgent)
	protected.HandleFunc("POST /api/v1/agents/{id}/input", server.v1SendAgentInput)
	protected.HandleFunc("POST /api/v1/agents/{id}/prompt", server.v1PromptAgent)
	protected.HandleFunc("POST /api/v1/agents/{id}/wait", server.v1WaitAgent)
	protected.HandleFunc("GET /api/v1/selection", server.v1GetSelection)
	protected.HandleFunc("PUT /api/v1/selection", server.v1ReplaceSelection)
	protected.HandleFunc("POST /api/v1/selection/actions", server.v1ApplySelection)
	protected.HandleFunc("/api/v1/", func(w http.ResponseWriter, _ *http.Request) {
		writeV1Error(w, http.StatusNotFound, "api_not_found",
			"The API endpoint does not exist.", nil)
	})
	protected.HandleFunc("GET /api/sessions", server.listSessions)
	protected.HandleFunc("GET /api/agent-summaries", server.listAgentSummaries)
	protected.HandleFunc("GET /api/tasks", server.listTasks)
	protected.HandleFunc("POST /api/tasks", server.createTask)
	protected.HandleFunc("GET /api/tasks/{id}", server.getTask)
	protected.HandleFunc("PATCH /api/tasks/{id}", server.updateTask)
	protected.HandleFunc("DELETE /api/tasks/{id}", server.deleteTask)
	protected.HandleFunc("POST /api/tasks/{id}/start", server.startTaskAgent)
	protected.HandleFunc("POST /api/tasks/{id}/prompt", server.promptTaskAgent)
	protected.HandleFunc("POST /api/tasks/{id}/refine", server.refineTask)
	protected.HandleFunc("POST /api/sessions", server.createSession)
	protected.HandleFunc("DELETE /api/sessions/{id}", server.deleteSession)
	protected.HandleFunc("POST /api/sessions/{id}/acknowledge-attention", server.acknowledgeAttention)
	protected.HandleFunc("POST /api/sessions/{id}/tickets", server.createTicket)
	protected.HandleFunc("GET /api/sessions/{id}/agent-log", server.agentLog)
	protected.HandleFunc("GET /api/sessions/{id}/git-changes", server.gitChanges)
	protected.HandleFunc("GET /api/sessions/{id}/workspace", server.workspaceDirectory)
	protected.HandleFunc("GET /api/sessions/{id}/workspace/search", server.workspaceSearch)
	protected.HandleFunc("GET /api/sessions/{id}/workspace/file", server.workspaceFile)
	protected.HandleFunc("POST /api/hooks/terminal", server.updateTerminalHook)
	protected.HandleFunc("GET /api/settings", server.getSettings)
	protected.HandleFunc("PATCH /api/settings", server.updateSettings)
	protected.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "api_not_found", "The API endpoint does not exist.")
	})
	public.Handle("/api/", bearerAuth(config.Token, protected))

	assets := config.Assets
	if assets == nil {
		assets = webassets.Assets
	}
	static, err := newStaticHandler(assets)
	if err != nil {
		static = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write(webassets.FallbackHTML)
		})
	}
	public.Handle("/", static)

	server.handler = public
	return server, nil
}

func (s *Server) Handler() http.Handler {
	return s.handler
}

func (s *Server) LocalHandler() http.Handler {
	return localTransportHandler(s.handler)
}

func (s *Server) Close(ctx context.Context) error {
	if s.tasks != nil {
		if err := s.tasks.Close(ctx); err != nil {
			return err
		}
	}
	if s.summaries != nil {
		if err := s.summaries.Close(ctx); err != nil {
			return err
		}
	}
	return s.sessions.Close(ctx)
}
