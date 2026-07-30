package agentlog

type Entry struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Role      string `json:"role,omitempty"`
	Title     string `json:"title,omitempty"`
	Content   string `json:"content,omitempty"`
	ToolCalls int    `json:"toolCalls,omitempty"`
	Timestamp string `json:"timestamp,omitempty"`
}

type Transcript struct {
	Agent     string  `json:"agent"`
	SessionID string  `json:"sessionId"`
	Entries   []Entry `json:"entries"`
}
