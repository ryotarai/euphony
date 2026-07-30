package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	"github.com/ryotarai/euphony/internal/annotation"
	"github.com/ryotarai/euphony/internal/apiclient"
	"github.com/ryotarai/euphony/internal/control"
	"github.com/ryotarai/euphony/internal/localapi"
	"github.com/ryotarai/euphony/internal/selection"
)

type exitError struct {
	code int
}

func (e *exitError) Error() string {
	return fmt.Sprintf("exit status %d", e.code)
}

type usageError struct {
	message string
}

type requestError struct {
	message string
}

func (e *requestError) Error() string {
	return e.message
}

func (e *usageError) Error() string {
	return e.message
}

type stringList []string

func (values *stringList) String() string {
	return strings.Join(*values, ",")
}

func (values *stringList) Set(value string) error {
	*values = append(*values, value)
	return nil
}

type cliOptions struct {
	socket string
	url    string
	token  string
}

func runAutomation(args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	return runAutomationContext(ctx, args, stdin, stdout, stderr)
}

func runAutomationContext(
	ctx context.Context,
	args []string,
	stdin io.Reader,
	stdout, stderr io.Writer,
) error {
	options, remaining, err := parseGlobalOptions(args)
	if err != nil {
		return writeCLIError(stderr, err)
	}
	if len(remaining) == 0 {
		return writeCLIError(stderr, &usageError{message: "missing command"})
	}
	client, err := automationClient(options)
	if err != nil {
		return writeCLIError(stderr, err)
	}
	var result any
	switch remaining[0] {
	case "status":
		if len(remaining) != 1 {
			err = &usageError{message: "usage: euphony status"}
			break
		}
		result, err = client.Status(ctx)
	case "api":
		if len(remaining) < 2 || remaining[1] != "schema" {
			err = &usageError{message: "usage: euphony api schema [--output PATH]"}
			break
		}
		var outputPath string
		flags, parseErr := parseFlags("api schema", remaining[2:], func(flags *flag.FlagSet) {
			flags.StringVar(&outputPath, "output", "", "write schema atomically")
		})
		if parseErr != nil || len(flags.Args()) != 0 {
			err = flagPositionError(parseErr, "usage: euphony api schema [--output PATH]")
			break
		}
		var schema []byte
		schema, err = client.Schema(ctx)
		if err == nil {
			if outputPath == "" {
				_, err = stdout.Write(append(bytesWithoutTrailingNewline(schema), '\n'))
				return err
			}
			err = writeFileAtomically(outputPath, schema)
			result = map[string]string{"path": outputPath}
		}
	case "events":
		return runEvents(ctx, client, remaining[1:], stdout, stderr)
	case "terminal":
		result, err = runTerminalCommand(ctx, client, remaining[1:], stdin, stdout)
		if errors.Is(err, errStreamingComplete) {
			return nil
		}
	case "agent":
		result, err = runAgentCommand(ctx, client, remaining[1:], stdin)
	case "selection":
		result, err = runSelectionCommand(ctx, client, remaining[1:], stdin)
	case "annotate":
		result, err = runAnnotate(ctx, client, remaining[1:])
	default:
		err = &usageError{message: "command must be status, api, events, terminal, agent, selection, or annotate"}
	}
	if err != nil {
		return writeCLIError(stderr, err)
	}
	return writeCLISuccess(stdout, result)
}

func runAnnotate(
	ctx context.Context,
	client *apiclient.Client,
	args []string,
) (any, error) {
	path, err := exactlyOne(args, "usage: euphony annotate FILE")
	if err != nil {
		return nil, err
	}
	terminalID := strings.TrimSpace(os.Getenv("EUPHONY_TERMINAL_ID"))
	if terminalID == "" {
		return nil, &requestError{message: "EUPHONY_TERMINAL_ID is required"}
	}
	format, err := inferAnnotationFormat(path)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	content, readErr := io.ReadAll(io.LimitReader(file, maxAnnotationFileBytes+1))
	closeErr := file.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if len(content) == 0 {
		return nil, &requestError{message: "annotation file must not be empty"}
	}
	if len(content) > maxAnnotationFileBytes {
		return nil, &requestError{message: "annotation file exceeds 1048576 bytes"}
	}
	if !utf8.Valid(content) {
		return nil, &requestError{message: "annotation file must contain valid UTF-8"}
	}
	absolutePath, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	session, err := client.CreateAnnotation(ctx, apiclient.CreateAnnotationRequest{
		TerminalID: terminalID,
		Filename:   filepath.Base(path),
		Format:     format,
		Content:    string(content),
	})
	if err != nil {
		return nil, err
	}
	consumed := false
	defer func() {
		if consumed {
			return
		}
		cleanupContext, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = client.CancelAnnotation(cleanupContext, session.ID)
	}()
	result, err := client.WaitAnnotation(ctx, session.ID)
	if err != nil {
		return nil, err
	}
	consumed = true
	return struct {
		AnnotationID string               `json:"annotationId"`
		Path         string               `json:"path"`
		Comments     []annotation.Comment `json:"comments"`
	}{
		AnnotationID: result.AnnotationID,
		Path:         absolutePath,
		Comments:     result.Comments,
	}, nil
}

const maxAnnotationFileBytes = 1024 * 1024

func inferAnnotationFormat(path string) (annotation.Format, error) {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".markdown":
		return annotation.FormatMarkdown, nil
	case ".html", ".htm":
		return annotation.FormatHTML, nil
	default:
		return "", &requestError{message: "annotation file must be Markdown or HTML"}
	}
}

func parseGlobalOptions(args []string) (cliOptions, []string, error) {
	var options cliOptions
	flags := flag.NewFlagSet("euphony", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&options.socket, "socket", "", "Unix socket path")
	flags.StringVar(&options.url, "url", "", "HTTP base URL")
	flags.StringVar(&options.token, "token", "", "HTTP bearer token")
	if err := flags.Parse(args); err != nil {
		return options, nil, &usageError{message: err.Error()}
	}
	if options.socket != "" && options.url != "" {
		return options, nil, &usageError{message: "--socket and --url are mutually exclusive"}
	}
	return options, flags.Args(), nil
}

func automationClient(options cliOptions) (*apiclient.Client, error) {
	token := options.token
	if token == "" {
		token = os.Getenv("EUPHONY_TOKEN")
	}
	if options.socket != "" {
		return apiclient.New(apiclient.Config{SocketPath: options.socket})
	}
	if options.url != "" {
		return apiclient.New(apiclient.Config{BaseURL: options.url, Token: token})
	}
	if baseURL := os.Getenv("EUPHONY_URL"); baseURL != "" {
		return apiclient.New(apiclient.Config{BaseURL: baseURL, Token: token})
	}
	socketPath, err := localapi.DefaultSocketPath()
	if err == nil {
		if info, statErr := os.Stat(socketPath); statErr == nil &&
			info.Mode()&os.ModeSocket != 0 {
			return apiclient.New(apiclient.Config{SocketPath: socketPath})
		}
	}
	return apiclient.New(apiclient.Config{Token: token})
}

func runEvents(
	ctx context.Context,
	client *apiclient.Client,
	args []string,
	stdout, stderr io.Writer,
) error {
	if len(args) == 0 || args[0] != "subscribe" {
		return writeCLIError(stderr, &usageError{message: "usage: euphony events subscribe [--type TYPE]"})
	}
	var types stringList
	flags, err := parseFlags("events subscribe", args[1:], func(flags *flag.FlagSet) {
		flags.Var(&types, "type", "event type")
	})
	if err != nil || len(flags.Args()) != 0 {
		if err == nil {
			err = &usageError{message: "events subscribe does not accept positional arguments"}
		}
		return writeCLIError(stderr, err)
	}
	stream, err := client.Events(ctx, types)
	if err != nil {
		return writeCLIError(stderr, err)
	}
	defer stream.Close()
	if _, err := io.Copy(stdout, stream); err != nil {
		return writeCLIError(stderr, err)
	}
	return nil
}

var errStreamingComplete = errors.New("streaming command complete")

func runTerminalCommand(
	ctx context.Context,
	client *apiclient.Client,
	args []string,
	stdin io.Reader,
	stdout io.Writer,
) (any, error) {
	if len(args) == 0 {
		return nil, &usageError{message: "missing terminal command"}
	}
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return nil, terminalUsage("list")
		}
		terminals, err := client.ListTerminals(ctx)
		return map[string]any{"terminals": terminals}, err
	case "get":
		id, err := exactlyOne(args[1:], "usage: euphony terminal get ID")
		if err != nil {
			return nil, err
		}
		terminal, err := client.GetTerminal(ctx, id)
		return map[string]any{"terminal": terminal}, err
	case "create":
		var request apiclient.CreateTerminalRequest
		flags, err := parseFlags("terminal create", args[1:], func(flags *flag.FlagSet) {
			flags.StringVar(&request.Name, "name", "", "terminal name")
			flags.StringVar(&request.CWD, "cwd", "", "working directory")
			flags.Var((*selectionModeValue)(&request.SelectionMode), "selection", "none, add, or replace")
		})
		if err != nil || len(flags.Args()) != 0 {
			return nil, flagPositionError(err, "terminal create does not accept positional arguments")
		}
		return client.CreateTerminal(ctx, request)
	case "delete":
		id, err := exactlyOne(args[1:], "usage: euphony terminal delete ID")
		if err != nil {
			return nil, err
		}
		return client.DeleteTerminal(ctx, id)
	case "read":
		var maxBytes int
		flags, err := parseFlags("terminal read", args[1:], func(flags *flag.FlagSet) {
			flags.IntVar(&maxBytes, "max-bytes", 0, "history window")
		})
		if err != nil || len(flags.Args()) != 1 {
			return nil, flagPositionError(err, "usage: euphony terminal read [--max-bytes N] ID")
		}
		return client.ReadTerminal(ctx, flags.Arg(0), maxBytes)
	case "send-text":
		if len(args) != 3 {
			return nil, &usageError{message: "usage: euphony terminal send-text ID TEXT"}
		}
		text, err := readDash(args[2], stdin)
		if err != nil {
			return nil, err
		}
		err = client.SendTerminalInput(ctx, args[1], control.TerminalInput{Text: &text})
		return map[string]bool{"accepted": true}, err
	case "send-keys":
		if len(args) < 3 {
			return nil, &usageError{message: "usage: euphony terminal send-keys ID KEY..."}
		}
		err := client.SendTerminalInput(ctx, args[1], control.TerminalInput{Keys: args[2:]})
		return map[string]bool{"accepted": true}, err
	case "run":
		if len(args) < 3 {
			return nil, &usageError{message: "usage: euphony terminal run ID COMMAND"}
		}
		err := client.RunTerminal(ctx, args[1], strings.Join(args[2:], " "))
		return map[string]bool{"accepted": true}, err
	case "wait-output":
		return runTerminalWait(ctx, client, args[1:])
	case "observe":
		id, err := exactlyOne(args[1:], "usage: euphony terminal observe ID")
		if err != nil {
			return nil, err
		}
		if err := observeTerminal(ctx, client, id, stdout); err != nil {
			return nil, err
		}
		return nil, errStreamingComplete
	case "attach":
		id, err := exactlyOne(args[1:], "usage: euphony terminal attach ID")
		if err != nil {
			return nil, err
		}
		if err := attachTerminal(ctx, client, id, stdin, stdout); err != nil {
			return nil, err
		}
		return nil, errStreamingComplete
	default:
		return nil, terminalUsage(args[0])
	}
}

type selectionModeValue control.SelectionMode

func (value *selectionModeValue) String() string {
	return string(*value)
}

func (value *selectionModeValue) Set(raw string) error {
	if raw != "none" && raw != "add" && raw != "replace" {
		return errors.New("selection must be none, add, or replace")
	}
	*value = selectionModeValue(raw)
	return nil
}

func runTerminalWait(
	ctx context.Context,
	client *apiclient.Client,
	args []string,
) (any, error) {
	var request apiclient.WaitOutputRequest
	flags, err := parseFlags("terminal wait-output", args, func(flags *flag.FlagSet) {
		flags.StringVar(&request.Match, "match", "", "literal match")
		flags.StringVar(&request.Regex, "regex", "", "RE2 expression")
		flags.IntVar(&request.TimeoutMS, "timeout", 0, "timeout in milliseconds")
		flags.IntVar(&request.MaxBytes, "max-bytes", 0, "match window")
	})
	if err != nil || len(flags.Args()) != 1 {
		return nil, flagPositionError(err,
			"usage: euphony terminal wait-output [--match TEXT|--regex RE2] ID")
	}
	return client.WaitOutput(ctx, flags.Arg(0), request)
}

func runAgentCommand(
	ctx context.Context,
	client *apiclient.Client,
	args []string,
	stdin io.Reader,
) (any, error) {
	if len(args) == 0 {
		return nil, &usageError{message: "missing agent command"}
	}
	switch args[0] {
	case "list":
		if len(args) != 1 {
			return nil, &usageError{message: "usage: euphony agent list"}
		}
		agents, err := client.ListAgents(ctx)
		return map[string]any{"agents": agents}, err
	case "get":
		id, err := exactlyOne(args[1:], "usage: euphony agent get TERMINAL_ID")
		if err != nil {
			return nil, err
		}
		agent, err := client.GetAgent(ctx, id)
		return map[string]any{"agent": agent}, err
	case "start":
		return runAgentStart(ctx, client, args[1:])
	case "read":
		var source string
		var maxBytes int
		flags, err := parseFlags("agent read", args[1:], func(flags *flag.FlagSet) {
			flags.StringVar(&source, "source", "transcript", "transcript or terminal")
			flags.IntVar(&maxBytes, "max-bytes", 0, "terminal history window")
		})
		if err != nil || len(flags.Args()) != 1 {
			return nil, flagPositionError(err, "usage: euphony agent read [--source SOURCE] TERMINAL_ID")
		}
		var result json.RawMessage
		err = client.ReadAgent(ctx, flags.Arg(0), source, maxBytes, &result)
		return result, err
	case "prompt":
		return runAgentPrompt(ctx, client, args[1:], stdin)
	case "send-keys":
		if len(args) < 3 {
			return nil, &usageError{message: "usage: euphony agent send-keys TERMINAL_ID KEY..."}
		}
		err := client.SendAgentKeys(ctx, args[1], args[2:])
		return map[string]bool{"accepted": true}, err
	case "wait":
		return runAgentWait(ctx, client, args[1:])
	default:
		return nil, &usageError{message: "unknown agent command " + strconv.Quote(args[0])}
	}
}

func runAgentStart(
	ctx context.Context,
	client *apiclient.Client,
	args []string,
) (any, error) {
	var request apiclient.StartAgentRequest
	var agentArgs stringList
	flags, err := parseFlags("agent start", args, func(flags *flag.FlagSet) {
		flags.StringVar(&request.Kind, "kind", "", "codex or claude")
		flags.Var(&agentArgs, "arg", "agent argument")
		flags.IntVar(&request.TimeoutMS, "timeout", 0, "timeout in milliseconds")
	})
	if err != nil || len(flags.Args()) != 1 {
		return nil, flagPositionError(err,
			"usage: euphony agent start --kind codex|claude [--arg ARG] TERMINAL_ID")
	}
	request.Args = agentArgs
	agent, err := client.StartAgent(ctx, flags.Arg(0), request)
	return map[string]any{"agent": agent}, err
}

func runAgentPrompt(
	ctx context.Context,
	client *apiclient.Client,
	args []string,
	stdin io.Reader,
) (any, error) {
	var wait bool
	var until stringList
	var timeout int
	flags, err := parseFlags("agent prompt", args, func(flags *flag.FlagSet) {
		flags.BoolVar(&wait, "wait", false, "wait for agent to settle")
		flags.Var(&until, "until", "accepted state")
		flags.IntVar(&timeout, "timeout", 0, "timeout in milliseconds")
	})
	if err != nil || len(flags.Args()) != 2 {
		return nil, flagPositionError(err,
			"usage: euphony agent prompt [--wait] [--until STATE] TERMINAL_ID PROMPT")
	}
	prompt, err := readDash(flags.Arg(1), stdin)
	if err != nil {
		return nil, err
	}
	agent, err := client.PromptAgent(ctx, flags.Arg(0), apiclient.PromptAgentRequest{
		Prompt: prompt, Wait: wait, Until: until, TimeoutMS: timeout,
	})
	return map[string]any{"accepted": true, "agent": agent}, err
}

func runAgentWait(
	ctx context.Context,
	client *apiclient.Client,
	args []string,
) (any, error) {
	var until stringList
	var timeout int
	flags, err := parseFlags("agent wait", args, func(flags *flag.FlagSet) {
		flags.Var(&until, "until", "accepted state")
		flags.IntVar(&timeout, "timeout", 0, "timeout in milliseconds")
	})
	if err != nil || len(flags.Args()) != 1 {
		return nil, flagPositionError(err,
			"usage: euphony agent wait [--until STATE] TERMINAL_ID")
	}
	agent, err := client.WaitAgent(ctx, flags.Arg(0), apiclient.WaitAgentRequest{
		Until: until, TimeoutMS: timeout,
	})
	return map[string]any{"agent": agent}, err
}

func runSelectionCommand(
	ctx context.Context,
	client *apiclient.Client,
	args []string,
	stdin io.Reader,
) (any, error) {
	if len(args) == 0 {
		return nil, &usageError{message: "missing selection command"}
	}
	if args[0] == "get" {
		if len(args) != 1 {
			return nil, &usageError{message: "usage: euphony selection get"}
		}
		return client.Selection(ctx)
	}
	if args[0] == "replace" {
		return replaceSelection(ctx, client, args[1:], stdin)
	}
	action, err := selectionAction(args)
	if err != nil {
		return nil, err
	}
	return client.ApplySelection(ctx, action)
}

func replaceSelection(
	ctx context.Context,
	client *apiclient.Client,
	args []string,
	stdin io.Reader,
) (any, error) {
	var path string
	flags, err := parseFlags("selection replace", args, func(flags *flag.FlagSet) {
		flags.StringVar(&path, "file", "-", "JSON file or - for stdin")
	})
	if err != nil || len(flags.Args()) != 0 {
		return nil, flagPositionError(err, "usage: euphony selection replace [--file PATH]")
	}
	var reader io.Reader = stdin
	if path != "-" {
		file, openErr := os.Open(path)
		if openErr != nil {
			return nil, openErr
		}
		defer file.Close()
		reader = file
	}
	var request apiclient.ReplaceSelectionRequest
	decoder := json.NewDecoder(io.LimitReader(reader, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return nil, &usageError{message: "invalid selection JSON: " + err.Error()}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			err = errors.New("multiple JSON values")
		}
		return nil, &usageError{message: "invalid selection JSON: " + err.Error()}
	}
	return client.ReplaceSelection(ctx, request)
}

func selectionAction(args []string) (selection.Action, error) {
	action := selection.Action{}
	switch args[0] {
	case "add", "remove", "pin", "unpin":
		if len(args) < 2 {
			return action, &usageError{message: "selection " + args[0] + " requires at least one terminal ID"}
		}
		action.Type = selection.ActionType(args[0])
		action.TerminalIDs = args[1:]
	case "focus":
		if len(args) != 2 {
			return action, &usageError{message: "usage: euphony selection focus TERMINAL_ID"}
		}
		action.Type = selection.ActionFocus
		action.FocusedTerminalID = args[1]
	case "filter":
		return selectionFilterAction(args[1:])
	default:
		return action, &usageError{message: "unknown selection command " + strconv.Quote(args[0])}
	}
	return action, nil
}

func selectionFilterAction(args []string) (selection.Action, error) {
	action := selection.Action{}
	if len(args) < 3 {
		return action, &usageError{
			message: "usage: euphony selection filter status|cwd set|add|remove VALUE...",
		}
	}
	kind, operation, values := args[0], args[1], args[2:]
	suffix := map[string]string{"set": "set", "add": "add", "remove": "remove"}[operation]
	if suffix == "" {
		return action, &usageError{message: "filter operation must be set, add, or remove"}
	}
	switch kind {
	case "status":
		action.Type = selection.ActionType("filter_status_" + suffix)
		action.Statuses = values
	case "cwd":
		action.Type = selection.ActionType("filter_cwd_" + suffix)
		for _, value := range values {
			status, cwd, found := strings.Cut(value, "=")
			if !found || status == "" || cwd == "" {
				return action, &usageError{message: "cwd filters use STATUS=CWD"}
			}
			action.CWDFilters = append(action.CWDFilters, selection.CWDFilter{
				Status: status, CWD: cwd,
			})
		}
	default:
		return action, &usageError{message: "filter kind must be status or cwd"}
	}
	return action, nil
}

func observeTerminal(
	ctx context.Context,
	client *apiclient.Client,
	id string,
	stdout io.Writer,
) error {
	connection, err := client.TerminalStream(ctx, id, "observe")
	if err != nil {
		return err
	}
	defer connection.CloseNow()
	for {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			if websocket.CloseStatus(err) == websocket.StatusNormalClosure {
				return nil
			}
			return err
		}
		if _, err := stdout.Write(append(payload, '\n')); err != nil {
			return err
		}
	}
}

func attachTerminal(
	ctx context.Context,
	client *apiclient.Client,
	id string,
	stdin io.Reader,
	stdout io.Writer,
) error {
	connection, err := client.TerminalStream(ctx, id, "control")
	if err != nil {
		return err
	}
	defer connection.CloseNow()
	go func() {
		buffer := make([]byte, 32*1024)
		for {
			count, readErr := stdin.Read(buffer)
			if count > 0 {
				payload, _ := json.Marshal(map[string]string{
					"type":       "input",
					"dataBase64": base64.RawStdEncoding.EncodeToString(buffer[:count]),
				})
				if connection.Write(ctx, websocket.MessageText, payload) != nil {
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}()
	for {
		_, payload, err := connection.Read(ctx)
		if err != nil {
			return err
		}
		var frame apiclient.TerminalFrame
		if err := json.Unmarshal(payload, &frame); err != nil {
			return err
		}
		if frame.DataBase64 != "" {
			data, err := base64.RawStdEncoding.DecodeString(frame.DataBase64)
			if err != nil {
				return err
			}
			if _, err := stdout.Write(data); err != nil {
				return err
			}
		}
		if frame.Type == "exit" {
			return nil
		}
	}
}

func writeCLISuccess(writer io.Writer, result any) error {
	return json.NewEncoder(writer).Encode(struct {
		OK     bool `json:"ok"`
		Result any  `json:"result"`
	}{OK: true, Result: result})
}

func writeCLIError(writer io.Writer, err error) error {
	status := 1
	code := "cli_failed"
	message := err.Error()
	details := any(map[string]any{})
	var usage *usageError
	var request *requestError
	var apiError *apiclient.APIError
	switch {
	case errors.As(err, &usage):
		status = 2
		code = "cli_usage"
	case errors.As(err, &request):
		code = "invalid_request"
	case errors.As(err, &apiError):
		code = apiError.Code
		message = apiError.Message
		if len(apiError.Details) > 0 {
			details = apiError.Details
		}
	}
	encodeErr := json.NewEncoder(writer).Encode(struct {
		OK    bool `json:"ok"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Details any    `json:"details"`
		} `json:"error"`
	}{
		OK: false,
		Error: struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Details any    `json:"details"`
		}{Code: code, Message: message, Details: details},
	})
	if encodeErr != nil {
		return encodeErr
	}
	return &exitError{code: status}
}

func parseFlags(
	name string,
	args []string,
	configure func(*flag.FlagSet),
) (*flag.FlagSet, error) {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configure(flags)
	if err := flags.Parse(args); err != nil {
		return flags, &usageError{message: err.Error()}
	}
	return flags, nil
}

func flagPositionError(err error, fallback string) error {
	if err != nil {
		return err
	}
	return &usageError{message: fallback}
}

func exactlyOne(args []string, usage string) (string, error) {
	if len(args) != 1 {
		return "", &usageError{message: usage}
	}
	return args[0], nil
}

func terminalUsage(command string) error {
	return &usageError{message: "unknown or invalid terminal command " + strconv.Quote(command)}
}

func readDash(value string, stdin io.Reader) (string, error) {
	if value != "-" {
		return value, nil
	}
	data, err := io.ReadAll(io.LimitReader(stdin, control.MaxAgentInputBytes+1))
	if err != nil {
		return "", err
	}
	if len(data) > control.MaxAgentInputBytes {
		return "", &usageError{message: "stdin exceeds 1048576 bytes"}
	}
	return string(data), nil
}

func bytesWithoutTrailingNewline(value []byte) []byte {
	return []byte(strings.TrimRight(string(value), "\r\n"))
}

func writeFileAtomically(path string, content []byte) error {
	directory := filepath.Dir(path)
	file, err := os.CreateTemp(directory, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	temporaryPath := file.Name()
	defer os.Remove(temporaryPath)
	if err := file.Chmod(0o644); err != nil {
		_ = file.Close()
		return err
	}
	if _, err := file.Write(content); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}
