package agentlog

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCodexThreadTitleReadsLatestMatchingNameUpdate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout.jsonl")
	data := ""
	data += `{"type":"event_msg","payload":{"type":"thread_name_updated","thread_id":"session-1","thread_name":"First title"}}` + "\n"
	data += `{"type":"event_msg","payload":{"type":"thread_name_updated","thread_id":"session-2","thread_name":"Other thread"}}` + "\n"
	data += `{"type":"event_msg","payload":{"type":"thread_name_updated","thread_id":"session-1","thread_name":"Latest title"}}` + "\n"
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	got, err := CodexThreadTitle(path, "session-1")
	if err != nil {
		t.Fatalf("CodexThreadTitle() error = %v", err)
	}
	if got != "Latest title" {
		t.Fatalf("CodexThreadTitle() = %q, want %q", got, "Latest title")
	}
}
