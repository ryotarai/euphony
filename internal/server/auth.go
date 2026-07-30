package server

import (
	"context"
	"crypto/subtle"
	"net/http"
	"strings"
)

type localTransportKey struct{}

func bearerAuth(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if local, _ := r.Context().Value(localTransportKey{}).(bool); local {
			next.ServeHTTP(w, r)
			return
		}
		supplied := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if len(supplied) != len(token) ||
			subtle.ConstantTimeCompare([]byte(supplied), []byte(token)) != 1 {
			if strings.HasPrefix(r.URL.Path, "/api/v1/") {
				writeV1Error(w, http.StatusUnauthorized, "unauthorized",
					"A valid access token is required.", nil)
			} else {
				writeError(w, http.StatusUnauthorized, "unauthorized", "A valid access token is required.")
			}
			return
		}
		next.ServeHTTP(w, r)
	})
}

func localTransportHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := context.WithValue(r.Context(), localTransportKey{}, true)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
