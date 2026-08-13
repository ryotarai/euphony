package agentlog

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxHistoryWindowBytes  = 256 << 10
	maxHistoryPreviewBytes = 4 << 10
	maxHistoryScanFiles    = 8192
	maxHistoryScanBytes    = 256 << 20
	maxHistoryScanEntries  = 65536
)

var errHistoryScanBudget = errors.New("agent history scan budget exhausted")

type historyScanBudget struct {
	files     int
	bytes     int64
	entries   int
	exhausted bool
}

func (b *historyScanBudget) visit() bool {
	if b.exhausted || b.entries >= maxHistoryScanEntries {
		b.exhausted = true
		return false
	}
	b.entries++
	return true
}

func (b *historyScanBudget) reserve(size int64) bool {
	if b.exhausted || b.files >= maxHistoryScanFiles {
		b.exhausted = true
		return false
	}
	readBytes := size * 2
	if readBytes > maxHistoryWindowBytes*2 {
		readBytes = maxHistoryWindowBytes * 2
	}
	if readBytes < 0 || b.bytes > maxHistoryScanBytes-readBytes {
		b.exhausted = true
		return false
	}
	b.files++
	b.bytes += readBytes
	return true
}

// HistorySession is the bounded, display-oriented projection of an agent
// transcript. TranscriptPath is intentionally not serialized: it is an
// internal capability used by the resume endpoint after the resolver has
// confined it below the configured agent root.
type HistorySession struct {
	Agent          string    `json:"agent"`
	SessionID      string    `json:"sessionId"`
	Title          string    `json:"title,omitempty"`
	Purpose        string    `json:"purpose,omitempty"`
	Summary        string    `json:"summary,omitempty"`
	CWD            string    `json:"cwd,omitempty"`
	Project        string    `json:"project,omitempty"`
	UpdatedAt      time.Time `json:"updatedAt"`
	TranscriptPath string    `json:"-"`
}

type historyIndexEntry struct {
	ID         string
	ThreadName string
	Title      string
	CWD        string
	Project    string
	UpdatedAt  time.Time
}

// DiscoverHistory returns the available Codex and Claude sessions in
// newest-first order. Missing roots, malformed records, and transcripts that
// disappear while the directory is being walked are ignored so a transient
// agent write cannot hide the current Euphony terminals.
func (r *Resolver) DiscoverHistory() ([]HistorySession, error) {
	byKey := make(map[string]HistorySession)
	var scanErrors []error
	budget := historyScanBudget{}

	codexIndex, indexErr := r.loadCodexHistoryIndex()
	if indexErr != nil {
		scanErrors = append(scanErrors, indexErr)
	}
	for _, root := range r.codexHistoryRoots {
		for _, item := range r.discoverRoot("codex", root, codexIndex, &budget) {
			mergeHistorySession(byKey, item)
		}
		if budget.exhausted {
			break
		}
	}
	for _, item := range r.discoverRoot("claude", r.claudeRoot, nil, &budget) {
		mergeHistorySession(byKey, item)
	}

	result := make([]HistorySession, 0, len(byKey))
	for _, item := range byKey {
		result = append(result, item)
	}
	sort.SliceStable(result, func(i, j int) bool {
		if !result[i].UpdatedAt.Equal(result[j].UpdatedAt) {
			return result[i].UpdatedAt.After(result[j].UpdatedAt)
		}
		return historyKey(result[i]) < historyKey(result[j])
	})
	if len(scanErrors) > 0 && len(result) == 0 {
		return result, errors.Join(scanErrors...)
	}
	return result, nil
}

func mergeHistorySession(items map[string]HistorySession, candidate HistorySession) {
	key := historyKey(candidate)
	previous, ok := items[key]
	if ok && !candidate.UpdatedAt.After(previous.UpdatedAt) {
		return
	}
	items[key] = candidate
}

func historyKey(item HistorySession) string {
	return item.Agent + "\x00" + item.SessionID
}

func (r *Resolver) discoverRoot(
	agent, root string, index map[string]historyIndexEntry, budget *historyScanBudget,
) []HistorySession {
	if root == "" {
		return nil
	}
	if _, err := os.Stat(root); err != nil {
		return nil
	}
	result := make([]HistorySession, 0)
	_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if budget == nil || !budget.visit() {
			return errHistoryScanBudget
		}
		if walkErr != nil {
			return nil
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			return nil
		}
		confined, ok := confinedRegularFile(root, path)
		if !ok {
			return nil
		}
		info, err := os.Stat(confined)
		if err != nil {
			return nil
		}
		if budget == nil || !budget.reserve(info.Size()) {
			return errHistoryScanBudget
		}
		var sessionID string
		if agent == "claude" {
			sessionID = strings.TrimSuffix(entry.Name(), ".jsonl")
		} else {
			sessionID = codexSessionIDForFile(entry.Name(), index)
		}
		if !safeSessionID(sessionID) {
			return nil
		}

		head, tail, info, err := readHistoryWindows(confined)
		if err != nil {
			return nil
		}
		preview := parseHistoryPreview(agent, sessionID, head, tail)
		if !preview.recognized {
			return nil
		}
		if preview.sessionID != "" {
			if preview.sessionID != sessionID {
				if agent != "codex" || !strings.HasPrefix(sessionID, "rollout-") {
					return nil
				}
			}
			sessionID = preview.sessionID
		}
		if !safeSessionID(sessionID) {
			return nil
		}

		item := HistorySession{
			Agent:          agent,
			SessionID:      sessionID,
			Title:          preview.title,
			Purpose:        preview.purpose,
			Summary:        preview.summary,
			CWD:            preview.cwd,
			Project:        preview.project,
			UpdatedAt:      preview.updatedAt,
			TranscriptPath: confined,
		}
		if candidate, ok := index[sessionID]; ok {
			if candidate.ThreadName != "" {
				item.Title = candidate.ThreadName
			} else if candidate.Title != "" {
				item.Title = candidate.Title
			}
			if candidate.CWD != "" {
				item.CWD = candidate.CWD
			}
			if candidate.Project != "" {
				item.Project = candidate.Project
			}
			if !candidate.UpdatedAt.IsZero() {
				item.UpdatedAt = candidate.UpdatedAt
			}
		}
		if agent == "codex" && item.Title == "" {
			item.Title, _ = CodexThreadTitle(confined, sessionID)
		}
		if agent == "claude" && item.Title == "" {
			item.Title = ClaudeTranscriptTitle(confined)
		}
		if item.UpdatedAt.IsZero() {
			item.UpdatedAt = info.ModTime().UTC()
		}
		item.Purpose = boundedHistoryPreview(item.Purpose)
		item.Summary = boundedHistoryPreview(item.Summary)
		if item.CWD == "" && item.Project != "" && filepath.IsAbs(item.Project) {
			item.CWD = item.Project
		}
		if item.Project == "" && item.CWD != "" {
			item.Project = filepath.Base(filepath.Clean(item.CWD))
		}
		result = append(result, item)
		return nil
	})
	return result
}

func (r *Resolver) loadCodexHistoryIndex() (map[string]historyIndexEntry, error) {
	result := make(map[string]historyIndexEntry)
	if r.codexRoot == "" || r.codexIndex == "" {
		return result, nil
	}
	indexRoot := filepath.Dir(r.codexRoot)
	indexPath, ok := confinedRegularFile(indexRoot, r.codexIndex)
	if !ok {
		return result, nil
	}
	head, tail, _, err := readHistoryWindows(indexPath)
	if err != nil {
		return result, err
	}
	for _, line := range historyLines(head, tail) {
		var raw map[string]json.RawMessage
		if json.Unmarshal(line, &raw) != nil {
			continue
		}
		id := firstRawString(raw, "id", "session_id", "sessionId", "thread_id")
		if !safeSessionID(id) {
			continue
		}
		result[id] = historyIndexEntry{
			ID:         id,
			ThreadName: firstRawString(raw, "thread_name", "threadName"),
			Title:      firstRawString(raw, "title"),
			CWD:        firstRawString(raw, "cwd", "working_directory", "workingDirectory"),
			Project:    firstRawString(raw, "project", "project_name", "projectName"),
			UpdatedAt:  parseTimeValue(raw["updated_at"], raw["updatedAt"], raw["timestamp"]),
		}
	}
	return result, nil
}

func codexSessionIDForFile(name string, index map[string]historyIndexEntry) string {
	for id := range index {
		if matchesSessionFilename("codex", name, id) {
			return id
		}
	}
	stem := strings.TrimSuffix(name, ".jsonl")
	if safeSessionID(stem) {
		return stem
	}
	if strings.HasPrefix(stem, "rollout-") {
		candidate := strings.TrimPrefix(stem, "rollout-")
		if safeSessionID(candidate) {
			return candidate
		}
	}
	return ""
}

type historyPreview struct {
	sessionID  string
	title      string
	purpose    string
	summary    string
	cwd        string
	project    string
	updatedAt  time.Time
	recognized bool
}

func parseHistoryPreview(agent, sessionID string, head, tail []byte) historyPreview {
	preview := historyPreview{}
	for _, line := range historyLines(head, tail) {
		var raw map[string]json.RawMessage
		if json.Unmarshal(line, &raw) != nil {
			continue
		}
		if candidate := firstRawString(raw, "sessionId", "session_id", "thread_id"); candidate != "" {
			if preview.sessionID == "" {
				preview.sessionID = candidate
			}
		}
		if timestamp := parseTimeValue(raw["timestamp"], raw["updated_at"], raw["updatedAt"]); timestamp.After(preview.updatedAt) {
			preview.updatedAt = timestamp
		}
		if cwd := firstRawString(raw, "cwd", "working_directory", "workingDirectory"); cwd != "" {
			preview.cwd = cwd
		}
		if project := firstRawString(raw, "project", "project_name", "projectName"); project != "" {
			preview.project = project
		}

		payload := rawObject(raw["payload"])
		if len(payload) > 0 {
			if candidate := firstRawString(payload, "id", "session_id", "sessionId", "thread_id"); candidate != "" && preview.sessionID == "" {
				preview.sessionID = candidate
			}
			if cwd := firstRawString(payload, "cwd", "working_directory", "workingDirectory"); cwd != "" {
				preview.cwd = cwd
			}
			if project := firstRawString(payload, "project", "project_name", "projectName"); project != "" {
				preview.project = project
			}
			if timestamp := parseTimeValue(payload["timestamp"], payload["updated_at"], payload["updatedAt"]); timestamp.After(preview.updatedAt) {
				preview.updatedAt = timestamp
			}
		}

		if agent == "codex" {
			parseCodexHistoryRecord(&preview, raw, payload)
		} else {
			parseClaudeHistoryRecord(&preview, raw)
		}
	}
	return preview
}

func parseCodexHistoryRecord(preview *historyPreview, raw, payload map[string]json.RawMessage) {
	if rawString(raw["type"]) == "session_meta" {
		preview.recognized = true
	}
	if rawString(raw["type"]) == "event_msg" {
		if event := rawObject(raw["payload"]); rawString(event["type"]) == "thread_name_updated" {
			preview.recognized = true
			preview.title = firstRawString(event, "thread_name", "threadName")
		}
	}
	if rawString(raw["type"]) != "response_item" {
		return
	}
	if rawString(payload["type"]) != "message" {
		return
	}
	preview.recognized = true
	role := rawString(payload["role"])
	text := messageText(payload["content"], false)
	if role == "user" && text != "" && preview.purpose == "" {
		preview.purpose = text
	}
	if role == "assistant" && text != "" {
		preview.summary = text
	}
}

func parseClaudeHistoryRecord(preview *historyPreview, raw map[string]json.RawMessage) {
	typeName := rawString(raw["type"])
	if typeName != "user" && typeName != "assistant" {
		return
	}
	message := rawObject(raw["message"])
	role := rawString(message["role"])
	if role == "" {
		role = typeName
	}
	preview.recognized = true
	text := messageText(message["content"], true)
	if role == "user" && text != "" && preview.purpose == "" {
		preview.purpose = text
	}
	if role == "assistant" && text != "" {
		preview.summary = text
	}
}

func messageText(raw json.RawMessage, claude bool) string {
	if len(raw) == 0 {
		return ""
	}
	var plain string
	if json.Unmarshal(raw, &plain) == nil {
		return strings.TrimSpace(plain)
	}
	var blocks []map[string]json.RawMessage
	if json.Unmarshal(raw, &blocks) != nil {
		return ""
	}
	texts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		typeName := rawString(block["type"])
		if claude {
			if typeName != "text" {
				continue
			}
		} else if typeName != "input_text" && typeName != "output_text" {
			continue
		}
		if text := strings.TrimSpace(rawString(block["text"])); text != "" {
			texts = append(texts, text)
		}
	}
	return strings.TrimSpace(strings.Join(texts, "\n"))
}

func boundedHistoryPreview(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= maxHistoryPreviewBytes {
		return value
	}
	limit := maxHistoryPreviewBytes
	for limit > 0 && !utf8Boundary(value[limit]) {
		limit--
	}
	return strings.TrimSpace(value[:limit])
}

func readHistoryWindows(path string) (head, tail []byte, info os.FileInfo, err error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, nil, err
	}
	defer file.Close()
	info, err = file.Stat()
	if err != nil {
		return nil, nil, nil, err
	}
	size := info.Size()
	headSize := minInt64(size, maxHistoryWindowBytes)
	head = make([]byte, headSize)
	if headSize > 0 {
		if _, err := file.ReadAt(head, 0); err != nil && !errors.Is(err, io.EOF) {
			return nil, nil, nil, err
		}
	}
	tailStart := size - maxHistoryWindowBytes
	if tailStart < 0 {
		tailStart = 0
	}
	tail = make([]byte, size-tailStart)
	if len(tail) > 0 {
		if _, err := file.ReadAt(tail, tailStart); err != nil && !errors.Is(err, io.EOF) {
			return nil, nil, nil, err
		}
	}
	return head, tail, info, nil
}

func historyLines(head, tail []byte) [][]byte {
	lines := bytes.Split(head, []byte("\n"))
	if len(tail) > 0 && !bytes.Equal(head, tail) {
		tailLines := bytes.Split(tail, []byte("\n"))
		if len(tailLines) > 0 && len(bytes.TrimSpace(tailLines[0])) > 0 {
			var record json.RawMessage
			// A tail window can begin in the middle of a JSONL record. Keep the
			// first line when it is a complete JSON value (the window may begin
			// exactly at a record boundary); otherwise discard the partial line.
			if json.Unmarshal(bytes.TrimSpace(tailLines[0]), &record) != nil {
				tailLines = tailLines[1:]
			}
		}
		lines = append(lines, tailLines...)
	}
	return lines
}

func firstRawString(raw map[string]json.RawMessage, keys ...string) string {
	for _, key := range keys {
		if value := rawString(raw[key]); value != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func rawObject(raw json.RawMessage) map[string]json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var value map[string]json.RawMessage
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func parseTimeValue(values ...json.RawMessage) time.Time {
	for _, raw := range values {
		if len(raw) == 0 {
			continue
		}
		var text string
		if json.Unmarshal(raw, &text) == nil {
			if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
				return parsed.UTC()
			}
		}
		var number json.Number
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if decoder.Decode(&number) == nil {
			if seconds, err := strconv.ParseInt(string(number), 10, 64); err == nil {
				return time.Unix(seconds, 0).UTC()
			}
		}
	}
	return time.Time{}
}

func minInt64(left int64, right int) int64 {
	if left < int64(right) {
		return left
	}
	return int64(right)
}
