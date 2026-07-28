package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/ryotarai/euphony/internal/session"
)

type Config struct {
	Token string
	Shell string
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

	sessionManager := session.NewManager(config.Shell)
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
	public.Handle("/api/", bearerAuth(config.Token, protected))

	server.handler = public
	return server, nil
}

func (s *Server) Handler() http.Handler {
	return s.handler
}

func (s *Server) Close(ctx context.Context) error {
	return s.sessions.Close(ctx)
}
