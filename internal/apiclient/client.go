package apiclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/ryotarai/euphony/internal/annotation"
	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/localapi"
	"github.com/ryotarai/euphony/internal/project"
	"github.com/ryotarai/euphony/internal/selection"
	"github.com/ryotarai/euphony/internal/session"
)

type Config struct {
	BaseURL    string
	Token      string
	SocketPath string
	HTTPClient *http.Client
}

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

type APIError struct {
	StatusCode int             `json:"-"`
	Code       string          `json:"code"`
	Message    string          `json:"message"`
	Details    json.RawMessage `json:"details,omitempty"`
}

func (e *APIError) Error() string {
	if e.Code == "" {
		return e.Message
	}
	return e.Code + ": " + e.Message
}

type Status struct {
	APIVersion string `json:"apiVersion"`
	Status     string `json:"status"`
}

type CreateTerminalRequest struct {
	Name          string                `json:"name,omitempty"`
	CWD           string                `json:"cwd,omitempty"`
	ProjectID     string                `json:"projectId,omitempty"`
	SelectionMode control.SelectionMode `json:"selectionMode,omitempty"`
}

type CreateTerminalResult struct {
	Terminal  session.Metadata   `json:"terminal"`
	Selection selection.Snapshot `json:"selection"`
}

type DeleteTerminalResult struct {
	ID        string             `json:"id"`
	Selection selection.Snapshot `json:"selection"`
}

type WaitOutputRequest struct {
	Match     string `json:"match,omitempty"`
	Regex     string `json:"regex,omitempty"`
	TimeoutMS int    `json:"timeoutMs,omitempty"`
	MaxBytes  int    `json:"maxBytes,omitempty"`
}

type StartAgentRequest struct {
	Kind      string   `json:"kind"`
	Args      []string `json:"args,omitempty"`
	TimeoutMS int      `json:"timeoutMs,omitempty"`
}

type PromptAgentRequest struct {
	Prompt    string   `json:"prompt"`
	Wait      bool     `json:"wait,omitempty"`
	Until     []string `json:"until,omitempty"`
	TimeoutMS int      `json:"timeoutMs,omitempty"`
}

type WaitAgentRequest struct {
	Until     []string `json:"until,omitempty"`
	TimeoutMS int      `json:"timeoutMs,omitempty"`
}

type ReplaceSelectionRequest struct {
	ManualTerminalIDs []string          `json:"manualTerminalIds"`
	PinnedTerminalIDs []string          `json:"pinnedTerminalIds"`
	FocusedTerminalID string            `json:"focusedTerminalId,omitempty"`
	Filters           selection.Filters `json:"filters"`
	PinnedFilters     selection.Filters `json:"pinnedFilters"`
	ExpectedRevision  *uint64           `json:"expectedRevision,omitempty"`
}

type CreateAnnotationRequest struct {
	TerminalID string            `json:"terminalId"`
	Filename   string            `json:"filename"`
	Format     annotation.Format `json:"format"`
	Content    string            `json:"content"`
}

type TerminalFrame struct {
	Type       string `json:"type"`
	DataBase64 string `json:"dataBase64,omitempty"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	Message    string `json:"message,omitempty"`
}

func New(config Config) (*Client, error) {
	httpClient := config.HTTPClient
	baseURL := strings.TrimRight(config.BaseURL, "/")
	if config.SocketPath != "" {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		socketPath := config.SocketPath
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			var dialer net.Dialer
			return dialer.DialContext(ctx, "unix", socketPath)
		}
		httpClient = &http.Client{Transport: transport}
		baseURL = "http://euphony.local"
	}
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8080"
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid Euphony base URL %q", baseURL)
	}
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	return &Client{baseURL: baseURL, token: config.Token, http: httpClient}, nil
}

func NewDefault() (*Client, error) {
	if baseURL := os.Getenv("EUPHONY_URL"); baseURL != "" {
		return New(Config{BaseURL: baseURL, Token: os.Getenv("EUPHONY_TOKEN")})
	}
	socketPath, err := localapi.DefaultSocketPath()
	if err == nil {
		if info, statErr := os.Stat(socketPath); statErr == nil && info.Mode()&os.ModeSocket != 0 {
			return New(Config{SocketPath: socketPath})
		}
	}
	return New(Config{Token: os.Getenv("EUPHONY_TOKEN")})
}

func (c *Client) Status(ctx context.Context) (Status, error) {
	var result Status
	return result, c.request(ctx, http.MethodGet, "/api/v1/status", nil, &result)
}

func (c *Client) Schema(ctx context.Context) ([]byte, error) {
	response, err := c.open(ctx, http.MethodGet, "/api/v1/schema", nil)
	if err != nil {
		return nil, err
	}
	defer response.Close()
	return io.ReadAll(response)
}

func (c *Client) ListProjects(ctx context.Context) ([]project.Project, error) {
	var result []project.Project
	return result, c.requestJSON(ctx, http.MethodGet, "/api/projects", nil, &result)
}

func (c *Client) CreateProject(ctx context.Context, path string) (project.Project, error) {
	var result project.Project
	err := c.requestJSON(ctx, http.MethodPost, "/api/projects",
		map[string]string{"path": path}, &result)
	return result, err
}

func (c *Client) ListTerminals(ctx context.Context) ([]session.Metadata, error) {
	var result struct {
		Terminals []session.Metadata `json:"terminals"`
	}
	err := c.request(ctx, http.MethodGet, "/api/v1/terminals", nil, &result)
	return result.Terminals, err
}

func (c *Client) GetTerminal(ctx context.Context, id string) (session.Metadata, error) {
	var result struct {
		Terminal session.Metadata `json:"terminal"`
	}
	err := c.request(ctx, http.MethodGet, terminalPath(id, ""), nil, &result)
	return result.Terminal, err
}

func (c *Client) CreateTerminal(
	ctx context.Context,
	request CreateTerminalRequest,
) (CreateTerminalResult, error) {
	var result CreateTerminalResult
	return result, c.request(ctx, http.MethodPost, "/api/v1/terminals", request, &result)
}

func (c *Client) DeleteTerminal(ctx context.Context, id string) (DeleteTerminalResult, error) {
	var result DeleteTerminalResult
	return result, c.request(ctx, http.MethodDelete, terminalPath(id, ""), nil, &result)
}

func (c *Client) ReadTerminal(
	ctx context.Context,
	id string,
	maxBytes int,
) (control.TerminalRead, error) {
	var result control.TerminalRead
	path := terminalPath(id, "/output")
	if maxBytes > 0 {
		path += "?maxBytes=" + strconv.Itoa(maxBytes)
	}
	return result, c.request(ctx, http.MethodGet, path, nil, &result)
}

func (c *Client) SendTerminalInput(
	ctx context.Context,
	id string,
	input control.TerminalInput,
) error {
	return c.request(ctx, http.MethodPost, terminalPath(id, "/input"), input, nil)
}

func (c *Client) RunTerminal(ctx context.Context, id, command string) error {
	return c.request(ctx, http.MethodPost, terminalPath(id, "/run"),
		map[string]string{"command": command}, nil)
}

func (c *Client) WaitOutput(
	ctx context.Context,
	id string,
	request WaitOutputRequest,
) (control.WaitOutputResult, error) {
	var result control.WaitOutputResult
	return result, c.request(ctx, http.MethodPost, terminalPath(id, "/wait-output"), request, &result)
}

func (c *Client) ListAgents(ctx context.Context) ([]session.Metadata, error) {
	var result struct {
		Agents []session.Metadata `json:"agents"`
	}
	err := c.request(ctx, http.MethodGet, "/api/v1/agents", nil, &result)
	return result.Agents, err
}

func (c *Client) GetAgent(ctx context.Context, id string) (session.Metadata, error) {
	var result struct {
		Agent session.Metadata `json:"agent"`
	}
	err := c.request(ctx, http.MethodGet, agentPath(id, ""), nil, &result)
	return result.Agent, err
}

func (c *Client) StartAgent(
	ctx context.Context,
	id string,
	request StartAgentRequest,
) (session.Metadata, error) {
	var result struct {
		Agent session.Metadata `json:"agent"`
	}
	err := c.request(ctx, http.MethodPost, agentPath(id, "/start"), request, &result)
	return result.Agent, err
}

func (c *Client) ReadAgent(
	ctx context.Context,
	id, source string,
	maxBytes int,
	out any,
) error {
	query := url.Values{}
	if source != "" {
		query.Set("source", source)
	}
	if maxBytes > 0 {
		query.Set("maxBytes", strconv.Itoa(maxBytes))
	}
	path := agentPath(id, "/output")
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return c.request(ctx, http.MethodGet, path, nil, out)
}

func (c *Client) SendAgentKeys(ctx context.Context, id string, keys []string) error {
	return c.request(ctx, http.MethodPost, agentPath(id, "/input"),
		map[string]any{"keys": keys}, nil)
}

func (c *Client) PromptAgent(
	ctx context.Context,
	id string,
	request PromptAgentRequest,
) (session.Metadata, error) {
	var result struct {
		Agent session.Metadata `json:"agent"`
	}
	err := c.request(ctx, http.MethodPost, agentPath(id, "/prompt"), request, &result)
	return result.Agent, err
}

func (c *Client) WaitAgent(
	ctx context.Context,
	id string,
	request WaitAgentRequest,
) (session.Metadata, error) {
	var result struct {
		Agent session.Metadata `json:"agent"`
	}
	err := c.request(ctx, http.MethodPost, agentPath(id, "/wait"), request, &result)
	return result.Agent, err
}

func (c *Client) Selection(ctx context.Context) (selection.Snapshot, error) {
	var result selection.Snapshot
	return result, c.request(ctx, http.MethodGet, "/api/v1/selection", nil, &result)
}

func (c *Client) ReplaceSelection(
	ctx context.Context,
	request ReplaceSelectionRequest,
) (selection.Snapshot, error) {
	var result selection.Snapshot
	return result, c.request(ctx, http.MethodPut, "/api/v1/selection", request, &result)
}

func (c *Client) ApplySelection(
	ctx context.Context,
	action selection.Action,
) (selection.Snapshot, error) {
	var result selection.Snapshot
	return result, c.request(ctx, http.MethodPost, "/api/v1/selection/actions", action, &result)
}

func (c *Client) Events(ctx context.Context, types []string) (io.ReadCloser, error) {
	query := url.Values{}
	for _, eventType := range types {
		query.Add("type", eventType)
	}
	path := "/api/v1/events"
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	return c.open(ctx, http.MethodGet, path, nil)
}

func (c *Client) CreateAnnotation(
	ctx context.Context,
	request CreateAnnotationRequest,
) (annotation.Session, error) {
	var result struct {
		Annotation annotation.Session `json:"annotation"`
	}
	err := c.request(ctx, http.MethodPost, "/api/v1/annotations", request, &result)
	return result.Annotation, err
}

func (c *Client) CurrentAnnotation(
	ctx context.Context,
	terminalID string,
) (*annotation.Session, error) {
	var result struct {
		Annotation *annotation.Session `json:"annotation"`
	}
	err := c.request(ctx, http.MethodGet, terminalPath(terminalID, "/annotation"), nil, &result)
	return result.Annotation, err
}

func (c *Client) WaitAnnotation(
	ctx context.Context,
	id string,
) (annotation.Result, error) {
	var result annotation.Result
	err := c.request(ctx, http.MethodGet, annotationPath(id, "/wait"), nil, &result)
	return result, err
}

func (c *Client) CompleteAnnotation(
	ctx context.Context,
	id string,
	comments []annotation.Comment,
) (annotation.Result, error) {
	var result annotation.Result
	err := c.request(ctx, http.MethodPost, annotationPath(id, "/complete"),
		map[string]any{"comments": comments}, &result)
	return result, err
}

func (c *Client) CancelAnnotation(ctx context.Context, id string) error {
	return c.request(ctx, http.MethodDelete, annotationPath(id, ""), nil, nil)
}

func (c *Client) TerminalStream(
	ctx context.Context,
	id, mode string,
) (*websocket.Conn, error) {
	var ticketResult struct {
		Ticket string `json:"ticket"`
	}
	if err := c.request(
		ctx,
		http.MethodPost,
		terminalPath(id, "/tickets"),
		map[string]string{"mode": mode},
		&ticketResult,
	); err != nil {
		return nil, err
	}
	streamURL, err := url.Parse(c.baseURL + terminalPath(id, "/stream"))
	if err != nil {
		return nil, err
	}
	switch streamURL.Scheme {
	case "http":
		streamURL.Scheme = "ws"
	case "https":
		streamURL.Scheme = "wss"
	}
	query := streamURL.Query()
	query.Set("ticket", ticketResult.Ticket)
	streamURL.RawQuery = query.Encode()
	connection, response, err := websocket.Dial(ctx, streamURL.String(), &websocket.DialOptions{
		HTTPClient: c.http,
	})
	if err != nil {
		if response != nil {
			return nil, fmt.Errorf("open terminal stream (%s): %w", response.Status, err)
		}
		return nil, fmt.Errorf("open terminal stream: %w", err)
	}
	return connection, nil
}

func (c *Client) request(
	ctx context.Context,
	method, path string,
	body, result any,
) error {
	response, err := c.do(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	var envelope struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *APIError       `json:"error"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 32<<20))
	if err := decoder.Decode(&envelope); err != nil {
		return fmt.Errorf("decode Euphony response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || !envelope.OK {
		if envelope.Error == nil {
			return &APIError{
				StatusCode: response.StatusCode,
				Code:       "invalid_response",
				Message:    response.Status,
			}
		}
		envelope.Error.StatusCode = response.StatusCode
		return envelope.Error
	}
	if result != nil && len(envelope.Result) > 0 {
		if err := json.Unmarshal(envelope.Result, result); err != nil {
			return fmt.Errorf("decode Euphony result: %w", err)
		}
	}
	return nil
}

func (c *Client) requestJSON(
	ctx context.Context, method, path string, body, result any,
) error {
	response, err := c.do(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(response.Body, 32<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var apiError APIError
		if err := decoder.Decode(&apiError); err != nil || apiError.Code == "" {
			return &APIError{
				StatusCode: response.StatusCode,
				Code:       "invalid_response",
				Message:    response.Status,
			}
		}
		apiError.StatusCode = response.StatusCode
		return &apiError
	}
	if result != nil {
		if err := decoder.Decode(result); err != nil {
			return fmt.Errorf("decode Euphony response: %w", err)
		}
	}
	return nil
}

func (c *Client) open(
	ctx context.Context,
	method, path string,
	body any,
) (io.ReadCloser, error) {
	response, err := c.do(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return response.Body, nil
	}
	defer response.Body.Close()
	var envelope struct {
		Error *APIError `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&envelope)
	if envelope.Error == nil {
		envelope.Error = &APIError{Code: "http_error", Message: response.Status}
	}
	envelope.Error.StatusCode = response.StatusCode
	return nil, envelope.Error
}

func (c *Client) do(
	ctx context.Context,
	method, path string,
	body any,
) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	response, err := c.http.Do(request)
	if err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, err
		}
		return nil, fmt.Errorf("connect to Euphony: %w", err)
	}
	return response, nil
}

func terminalPath(id, suffix string) string {
	return "/api/v1/terminals/" + url.PathEscape(id) + suffix
}

func agentPath(id, suffix string) string {
	return "/api/v1/agents/" + url.PathEscape(id) + suffix
}

func annotationPath(id, suffix string) string {
	return "/api/v1/annotations/" + url.PathEscape(id) + suffix
}

func DurationMilliseconds(duration time.Duration) int {
	if duration <= 0 {
		return 0
	}
	return int(duration.Milliseconds())
}
