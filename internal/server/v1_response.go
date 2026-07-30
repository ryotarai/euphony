package server

import "net/http"

type v1APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details"`
}

type v1Envelope struct {
	OK     bool        `json:"ok"`
	Result any         `json:"result,omitempty"`
	Error  *v1APIError `json:"error,omitempty"`
}

func writeV1Result(w http.ResponseWriter, status int, result any) {
	writeJSON(w, status, v1Envelope{OK: true, Result: result})
}

func writeV1Error(w http.ResponseWriter, status int, code, message string, details any) {
	if details == nil {
		details = map[string]any{}
	}
	writeJSON(w, status, v1Envelope{
		OK: false,
		Error: &v1APIError{
			Code:    code,
			Message: message,
			Details: details,
		},
	})
}
