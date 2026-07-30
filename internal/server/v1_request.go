package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

const maxV1RequestBody = 1024 * 1024

func decodeV1JSON(r *http.Request, target any) error {
	decoder := json.NewDecoder(io.LimitReader(r.Body, maxV1RequestBody+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode request: %w", err)
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return fmt.Errorf("finish request: %w", err)
	}
	return nil
}
