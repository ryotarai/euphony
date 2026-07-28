package server

import (
	"context"
	"errors"
	"io/fs"
	"net/http"
	"time"

	"github.com/ryotarai/euphony/internal/session"
	webassets "github.com/ryotarai/euphony/web"
)

type Config struct {
	Token             string
	Shell             string
	HookURL           string
	DatabasePath      string
	CodexSessionIndex string
	Assets            fs.FS
}

type Server struct {
	handler  http.Handler
	sessions *session.Manager
	tickets  *ticketStore
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
	server := &Server{sessions: sessionManager, tickets: tickets}

	public := http.NewServeMux()
	public.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	public.HandleFunc("GET /api/sessions/{id}/terminal", server.terminal)

	protected := http.NewServeMux()
	protected.HandleFunc("GET /api/sessions", server.listSessions)
	protected.HandleFunc("POST /api/sessions", server.createSession)
	protected.HandleFunc("DELETE /api/sessions/{id}", server.deleteSession)
	protected.HandleFunc("POST /api/sessions/{id}/tickets", server.createTicket)
	protected.HandleFunc("POST /api/hooks/terminal", server.updateTerminalHook)
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

func (s *Server) Close(ctx context.Context) error {
	return s.sessions.Close(ctx)
}
