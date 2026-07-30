package server

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

func bearerAuth(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
