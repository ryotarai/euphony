package server

import (
	_ "embed"
	"net/http"
)

//go:embed openapi.json
var openAPIDocument []byte

func v1Status(w http.ResponseWriter, _ *http.Request) {
	writeV1Result(w, http.StatusOK, map[string]string{
		"status":     "ok",
		"apiVersion": "v1",
	})
}

func v1Schema(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/vnd.oai.openapi+json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(openAPIDocument)
}
