package agentlog

type Entry struct {
	ID        string  `json:"id"`
	Kind      string  `json:"kind"`
	Role      string  `json:"role,omitempty"`
	Title     string  `json:"title,omitempty"`
	Content   string  `json:"content,omitempty"`
	URL       string  `json:"url,omitempty"`
	MimeType  string  `json:"mimeType,omitempty"`
	Alt       string  `json:"alt,omitempty"`
	CallID    string  `json:"callId,omitempty"`
	ToolCalls int     `json:"toolCalls,omitempty"`
	Entries   []Entry `json:"entries,omitempty"`
	Timestamp string  `json:"timestamp,omitempty"`
}

type Transcript struct {
	Agent       string  `json:"agent"`
	SessionID   string  `json:"sessionId"`
	Entries     []Entry `json:"entries"`
	StartCursor string  `json:"startCursor,omitempty"`
	EndCursor   string  `json:"endCursor,omitempty"`
	NextCursor  string  `json:"nextCursor,omitempty"`
}
