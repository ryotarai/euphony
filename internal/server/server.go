package server

import (
	"errors"
	"net/http"
)

type Config struct {
	Token string
	Shell string
}

type Server struct {
	handler http.Handler
}

func New(config Config) (*Server, error) {
	if config.Token == "" {
		return nil, errors.New("EUPHONY_TOKEN is required")
	}

	public := http.NewServeMux()
	public.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	protected := http.NewServeMux()
	protected.HandleFunc("GET /api/sessions", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, []any{})
	})
	public.Handle("/api/", bearerAuth(config.Token, protected))

	return &Server{handler: public}, nil
}

func (s *Server) Handler() http.Handler {
	return s.handler
}
