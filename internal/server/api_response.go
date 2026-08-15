package server

import "net/http"

type apiErrorResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

func writeAPIResult(w http.ResponseWriter, status int, result any) {
	writeJSON(w, status, result)
}

func writeAPIError(w http.ResponseWriter, status int, code, message string, details any) {
	if details == nil {
		writeError(w, status, code, message)
		return
	}
	writeJSON(w, status, apiErrorResponse{
		Code:    code,
		Message: message,
		Details: details,
	})
}
