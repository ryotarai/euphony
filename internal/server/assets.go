package server

import (
	"errors"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
)

func newStaticHandler(assets fs.FS) (http.Handler, error) {
	index, err := fs.ReadFile(assets, "dist/index.html")
	if err != nil {
		return nil, errors.New("frontend index is missing")
	}
	dist, err := fs.Sub(assets, "dist")
	if err != nil {
		return nil, err
	}
	files := http.FileServer(http.FS(dist))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		requestPath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if requestPath == "." || requestPath == "" {
			serveIndex(w, index)
			return
		}
		if _, err := fs.Stat(dist, requestPath); err == nil {
			files.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(requestPath, "assets/") {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, index)
	}), nil
}

func serveIndex(w http.ResponseWriter, index []byte) {
	w.Header().Set("Content-Type", mime.TypeByExtension(".html"))
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(index)
}
