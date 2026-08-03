package agenthook

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"

	"github.com/ryotarai/euphony/internal/agentlog"
)

type Config struct {
	URL        string
	Token      string
	TerminalID string
	Agent      string
	Status     string
}

func Report(ctx context.Context, config Config, input io.Reader) error {
	if config.URL == "" || config.Token == "" || config.TerminalID == "" {
		return nil
	}
	var event struct {
		CWD            string `json:"cwd"`
		SessionID      string `json:"session_id"`
		SessionTitle   string `json:"session_title"`
		Title          string `json:"title"`
		TranscriptPath string `json:"transcript_path"`
	}
	_ = json.NewDecoder(io.LimitReader(input, 1<<20)).Decode(&event)
	title := event.SessionTitle
	if title == "" {
		title = event.Title
	}
	if title == "" {
		title = agentlog.ClaudeTranscriptTitle(event.TranscriptPath)
	}
	if event.CWD == "" {
		event.CWD, _ = os.Getwd()
	}
	agent := config.Agent
	status := config.Status
	if status == "idle" {
		agent = ""
		status = ""
		title = ""
	}
	payload, err := json.Marshal(map[string]string{
		"terminalId":          config.TerminalID,
		"agent":               agent,
		"resumeAgent":         config.Agent,
		"agentSessionId":      event.SessionID,
		"agentTranscriptPath": event.TranscriptPath,
		"status":              status,
		"title":               title,
		"cwd":                 event.CWD,
	})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.URL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+config.Token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	return nil
}
