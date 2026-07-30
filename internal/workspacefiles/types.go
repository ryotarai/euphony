package workspacefiles

import "errors"

const (
	maxDirectoryEntries = 500
	maxSearchResults    = 200
	maxSearchVisits     = 10_000
	maxFileBytes        = 1024 * 1024
)

var (
	ErrInvalidPath  = errors.New("invalid workspace path")
	ErrInvalidQuery = errors.New("invalid workspace search query")
	ErrPathNotFound = errors.New("workspace path not found")
	ErrTypeMismatch = errors.New("workspace path has the wrong type")
)

type EntryKind string

const (
	KindDirectory EntryKind = "directory"
	KindFile      EntryKind = "file"
	KindSymlink   EntryKind = "symlink"
	KindOther     EntryKind = "other"
)

type Entry struct {
	Name string    `json:"name"`
	Path string    `json:"path"`
	Kind EntryKind `json:"kind"`
	Size int64     `json:"size,omitempty"`
}

type Directory struct {
	Root      string  `json:"root"`
	Path      string  `json:"path"`
	Entries   []Entry `json:"entries"`
	Truncated bool    `json:"truncated,omitempty"`
}

type SearchResult struct {
	Root      string  `json:"root"`
	Query     string  `json:"query"`
	Matches   []Entry `json:"matches"`
	Truncated bool    `json:"truncated,omitempty"`
}

type File struct {
	Root      string `json:"root"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Content   string `json:"content,omitempty"`
	Binary    bool   `json:"binary,omitempty"`
	Truncated bool   `json:"truncated,omitempty"`
}
