package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

const maxV1RequestBody = 1024 * 1024

var errV1RequestTooLarge = errors.New("v1 request body too large")

func decodeV1JSON(r *http.Request, target any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxV1RequestBody+1))
	if err != nil {
		return fmt.Errorf("read request: %w", err)
	}
	if len(body) > maxV1RequestBody {
		return errV1RequestTooLarge
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

func writeV1DecodeError(w http.ResponseWriter, err error, message string) {
	if errors.Is(err, errV1RequestTooLarge) {
		writeV1Error(w, http.StatusRequestEntityTooLarge, "request_too_large",
			"Request bodies must not exceed 1048576 bytes.", nil)
		return
	}
	writeV1Error(w, http.StatusBadRequest, "invalid_request", message, nil)
}
