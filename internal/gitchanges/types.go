package gitchanges

import "errors"

var (
	ErrNotRepository  = errors.New("not a Git repository")
	ErrChangeNotFound = errors.New("Git change not found")
)

type Snapshot struct {
	RepoRoot  string `json:"repoRoot"`
	Branch    string `json:"branch"`
	Upstream  string `json:"upstream,omitempty"`
	Ahead     int    `json:"ahead"`
	Behind    int    `json:"behind"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Truncated bool   `json:"truncated,omitempty"`
	Files     []File `json:"files"`
}

type File struct {
	Path         string `json:"path"`
	PreviousPath string `json:"previousPath,omitempty"`
	Status       string `json:"status"`
	Additions    int    `json:"additions"`
	Deletions    int    `json:"deletions"`
	Binary       bool   `json:"binary,omitempty"`
	Truncated    bool   `json:"truncated,omitempty"`
	Hunks        []Hunk `json:"hunks"`
}

type Hunk struct {
	Header   string `json:"header"`
	OldStart int    `json:"oldStart"`
	NewStart int    `json:"newStart"`
	Lines    []Line `json:"lines"`
}

type Line struct {
	Kind    string `json:"kind"`
	OldLine int    `json:"oldLine,omitempty"`
	NewLine int    `json:"newLine,omitempty"`
	Content string `json:"content"`
}
