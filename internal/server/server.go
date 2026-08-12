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
	"github.com/ryotarai/euphony/internal/project"
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
	ActionRunner       agentsummary.ActionRunner
	TaskRefiner        agentsummary.Refiner
	DirectoryPicker    func(context.Context) (string, error)
	Assets             fs.FS
}

type Server struct {
	handler         http.Handler
	sessions        *session.Manager
	control         *control.Service
	summaryEvents   *agentSummaryEventPublisher
	tickets         *ticketStore
	terminalSizes   *terminalSizeCoordinator
	agentLogs       *agentlog.Resolver
	annotations     *annotation.Store
	summaries       *agentsummary.Service
	actionRunner    agentsummary.ActionRunner
	tasks           *tasks.Service
	projects        *project.Service
	projectRepo     project.Repository
	directoryPicker func(context.Context) (string, error)
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
	var projectRepo project.Repository
	if config.DatabasePath == "" {
		projectRepo = project.NewMemoryRepository()
	} else {
		projectRepo, err = project.OpenSQLiteRepository(config.DatabasePath)
		if err != nil {
			_ = sessionManager.Close(context.Background())
			return nil, err
		}
	}
	projectService := project.NewService(projectRepo, time.Now, uuid.NewString)
	if err := migrateLegacyProjects(context.Background(), sessionManager, projectService); err != nil {
		_ = projectRepo.Close()
		_ = sessionManager.Close(context.Background())
		return nil, err
	}
	tickets := newTicketStore(time.Now)
	controlService, err := control.New(sessionManager)
	if err != nil {
		_ = projectRepo.Close()
		_ = sessionManager.Close(context.Background())
		return nil, err
	}
	summaryEvents := newAgentSummaryEventPublisher(controlService, sessionManager)
	transcriptResolver := agentlog.NewResolver(config.CodexSessionsRoot, config.ClaudeProjectsRoot)
	summaryService := agentsummary.New(agentsummary.Config{
		Sessions: sessionManager,
		Events:   summaryEvents,
		Resolver: transcriptResolver,
		Runner:   config.SummaryRunner,
	})
	actionRunner := config.ActionRunner
	if actionRunner == nil {
		if runner, ok := config.SummaryRunner.(agentsummary.ActionRunner); ok {
			actionRunner = runner
		} else {
			actionRunner = agentsummary.NewCommandRunner()
		}
	}
	taskStore, err := tasks.OpenStore(config.DatabasePath)
	if err != nil {
		_ = projectRepo.Close()
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
		_ = projectRepo.Close()
		_ = sessionManager.Close(context.Background())
		return nil, err
	}
	directoryPicker := config.DirectoryPicker
	if directoryPicker == nil {
		directoryPicker = pickDirectory
	}
	server := &Server{
		sessions:        sessionManager,
		control:         controlService,
		summaryEvents:   summaryEvents,
		tickets:         tickets,
		terminalSizes:   newTerminalSizeCoordinator(),
		agentLogs:       transcriptResolver,
		annotations:     annotation.NewStore(time.Now, uuid.NewString),
		summaries:       summaryService,
		actionRunner:    actionRunner,
		tasks:           taskService,
		projects:        projectService,
		projectRepo:     projectRepo,
		directoryPicker: directoryPicker,
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
	protected.HandleFunc("PATCH /api/v1/terminals/{id}", server.v1RenameTerminal)
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
	protected.HandleFunc("POST /api/agent-summaries/refresh", server.refreshAgentSummaries)
	protected.HandleFunc("POST /api/agent-summaries/{id}/read", server.markAgentSummaryRead)
	protected.HandleFunc("POST /api/agent-summaries/{id}/done", server.markAgentSummaryDone)
	protected.HandleFunc("POST /api/agent-summaries/{id}/options/{optionID}/execute", server.executeAgentSummaryOption)
	protected.HandleFunc("GET /api/projects", server.listProjects)
	protected.HandleFunc("POST /api/projects", server.createProject)
	protected.HandleFunc("POST /api/projects/pick-directory", server.pickProjectDirectory)
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
	var firstErr error
	if s.tasks != nil {
		if err := s.tasks.Close(ctx); err != nil {
			firstErr = err
		}
	}
	if s.summaries != nil {
		if err := s.summaries.Close(ctx); err != nil {
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	if s.sessions != nil {
		if err := s.sessions.Close(ctx); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if s.projectRepo != nil {
		if err := s.projectRepo.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}
