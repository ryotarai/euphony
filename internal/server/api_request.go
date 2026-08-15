package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

// JSON escaping can expand one byte of annotation content to six bytes.
const maxAPIRequestBody = 6*maxAnnotationContentBytes + 64*1024

var errAPIRequestTooLarge = errors.New("api request body too large")

func decodeAPIJSON(r *http.Request, target any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxAPIRequestBody+1))
	if err != nil {
		return fmt.Errorf("read request: %w", err)
	}
	if len(body) > maxAPIRequestBody {
		return errAPIRequestTooLarge
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode request: %w", err)
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return fmt.Errorf("finish request: %w", err)
	}
	return nil
}

func writeAPIDecodeError(w http.ResponseWriter, err error, message string) {
	if errors.Is(err, errAPIRequestTooLarge) {
		writeAPIError(w, http.StatusRequestEntityTooLarge, "request_too_large",
			"Request body exceeds the supported size.", nil)
		return
	}
	writeAPIError(w, http.StatusBadRequest, "invalid_request", message, nil)
}
