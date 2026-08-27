package server

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/ryotarai/euphony/internal/agentlog"
	"github.com/ryotarai/euphony/internal/agentsummary"
	"github.com/ryotarai/euphony/internal/annotation"
	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/project"
	"github.com/ryotarai/euphony/internal/session"
	webassets "github.com/ryotarai/euphony/web"
)

type AuthMode string

const (
	AuthModeToken AuthMode = "token"
	AuthModeNone  AuthMode = "none"
)

type Config struct {
	Token              string
	AuthMode           AuthMode
	Shell              string
	HookURL            string
	HookSocket         string
	DatabasePath       string
	CodexSessionIndex  string
	CodexSessionsRoot  string
	ClaudeProjectsRoot string
	SummaryRunner      agentsummary.Runner
	ActionRunner       agentsummary.ActionRunner
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
	projects        *project.Service
	projectRepo     project.Repository
	directoryPicker func(context.Context) (string, error)
	archiveStop     chan struct{}
	archiveDone     chan struct{}
	archiveCancel   context.CancelFunc
	archiveStopOnce sync.Once
}

func New(config Config) (*Server, error) {
	authMode := config.AuthMode
	if authMode == "" {
		authMode = AuthModeToken
	}
	if authMode != AuthModeToken && authMode != AuthModeNone {
		return nil, errors.New("EUPHONY_AUTH_MODE must be token or none")
	}
	if authMode == AuthModeToken && config.Token == "" {
		return nil, errors.New("EUPHONY_TOKEN is required")
	}

	hooks := session.HookConfig{
		URL:               config.HookURL,
		Socket:            config.HookSocket,
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
	var transcriptResolver *agentlog.Resolver
	if config.CodexSessionIndex == "" {
		transcriptResolver = agentlog.NewResolver(config.CodexSessionsRoot, config.ClaudeProjectsRoot)
	} else {
		transcriptResolver = agentlog.NewResolverWithIndex(
			config.CodexSessionsRoot, config.ClaudeProjectsRoot, config.CodexSessionIndex,
		)
	}
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
		projects:        projectService,
		projectRepo:     projectRepo,
		directoryPicker: directoryPicker,
	}
	summaryService.Start()

	public := http.NewServeMux()
	public.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	public.HandleFunc("GET /api/auth/config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]AuthMode{"mode": authMode})
	})
	public.HandleFunc("GET /api/sessions/{id}/terminal", server.terminal)

	protected := http.NewServeMux()
	protected.HandleFunc("GET /api/events", server.apiEvents)
	protected.HandleFunc("GET /api/terminals", server.apiListTerminals)
	protected.HandleFunc("POST /api/terminals", server.apiCreateTerminal)
	protected.HandleFunc("GET /api/terminals/{id}", server.apiGetTerminal)
	protected.HandleFunc("PATCH /api/terminals/{id}", server.apiRenameTerminal)
	protected.HandleFunc("DELETE /api/terminals/{id}", server.apiDeleteTerminal)
	protected.HandleFunc("GET /api/terminals/{id}/output", server.apiReadTerminal)
	protected.HandleFunc("POST /api/terminals/{id}/input", server.apiSendTerminalInput)
	protected.HandleFunc("POST /api/terminals/{id}/run", server.apiRunTerminal)
	protected.HandleFunc("POST /api/terminals/{id}/wait-output", server.apiWaitTerminalOutput)
	protected.HandleFunc("POST /api/terminals/{id}/tickets", server.apiCreateTerminalTicket)
	protected.HandleFunc("GET /api/terminals/{id}/annotation", server.apiCurrentAnnotation)
	protected.HandleFunc("POST /api/annotations", server.apiCreateAnnotation)
	protected.HandleFunc("GET /api/annotations/{id}/wait", server.apiWaitAnnotation)
	protected.HandleFunc("POST /api/annotations/{id}/complete", server.apiCompleteAnnotation)
	protected.HandleFunc("DELETE /api/annotations/{id}", server.apiCancelAnnotation)
	protected.HandleFunc("GET /api/agents", server.apiListAgents)
	protected.HandleFunc("GET /api/agents/{id}", server.apiGetAgent)
	protected.HandleFunc("POST /api/agents/{id}/start", server.apiStartAgent)
	protected.HandleFunc("GET /api/agents/{id}/output", server.apiReadAgent)
	protected.HandleFunc("POST /api/agents/{id}/input", server.apiSendAgentInput)
	protected.HandleFunc("POST /api/agents/{id}/prompt", server.apiPromptAgent)
	protected.HandleFunc("POST /api/agents/{id}/wait", server.apiWaitAgent)
	protected.HandleFunc("GET /api/selection", server.apiGetSelection)
	protected.HandleFunc("PUT /api/selection", server.apiReplaceSelection)
	protected.HandleFunc("POST /api/selection/actions", server.apiApplySelection)
	protected.HandleFunc("GET /api/sessions", server.listSessions)
	protected.HandleFunc("GET /api/sessions/archived", server.listArchivedSessions)
	protected.HandleFunc("GET /api/all-sessions", server.listAllSessions)
	protected.HandleFunc("POST /api/all-sessions/{agent}/{sessionID}/resume", server.resumeAllSession)
	protected.HandleFunc("GET /api/agent-summaries", server.listAgentSummaries)
	protected.HandleFunc("POST /api/agent-summaries/refresh", server.refreshAgentSummaries)
	protected.HandleFunc("POST /api/agent-summaries/{id}/read", server.markAgentSummaryRead)
	protected.HandleFunc("POST /api/agent-summaries/{id}/done", server.markAgentSummaryDone)
	protected.HandleFunc("POST /api/agent-summaries/{id}/options/{optionID}/execute", server.executeAgentSummaryOption)
	protected.HandleFunc("GET /api/projects", server.listProjects)
	protected.HandleFunc("POST /api/projects", server.createProject)
	protected.HandleFunc("PUT /api/projects/order", server.reorderProjects)
	protected.HandleFunc("POST /api/projects/pick-directory", server.pickProjectDirectory)
	protected.HandleFunc("POST /api/sessions", server.createSession)
	protected.HandleFunc("PUT /api/sessions/order", server.reorderSessions)
	protected.HandleFunc("DELETE /api/sessions/{id}", server.deleteSession)
	protected.HandleFunc("POST /api/sessions/{id}/archive", server.archiveSession)
	protected.HandleFunc("POST /api/sessions/{id}/acknowledge-attention", server.acknowledgeAttention)
	protected.HandleFunc("POST /api/sessions/{id}/tickets", server.createTicket)
	protected.HandleFunc("GET /api/sessions/{id}/agent-log", server.agentLog)
	protected.HandleFunc("GET /api/sessions/{id}/git-changes", server.gitChanges)
	protected.HandleFunc("GET /api/sessions/{id}/workspace", server.workspaceDirectory)
	protected.HandleFunc("GET /api/sessions/{id}/workspace/search", server.workspaceSearch)
	protected.HandleFunc("GET /api/sessions/{id}/workspace/file", server.workspaceFile)
	protected.HandleFunc("GET /api/sessions/{id}/workspace/file/content", server.workspaceFileContent)
	protected.HandleFunc("POST /api/hooks/terminal", server.updateTerminalHook)
	protected.HandleFunc("GET /api/settings", server.getSettings)
	protected.HandleFunc("PATCH /api/settings", server.updateSettings)
	protected.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "api_not_found", "The API endpoint does not exist.")
	})
	apiHandler := http.Handler(protected)
	if authMode == AuthModeToken {
		apiHandler = bearerAuth(config.Token, protected)
	}
	public.Handle("/api/", apiHandler)

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
	server.startStaleAgentArchiver()
	return server, nil
}

func (s *Server) Handler() http.Handler {
	return s.handler
}

func (s *Server) Close(ctx context.Context) error {
	var firstErr error
	if err := s.stopStaleAgentArchiver(ctx); err != nil {
		firstErr = err
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
