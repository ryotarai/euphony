package agentlog

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var ErrTranscriptNotFound = errors.New("agent transcript not found")

type Resolver struct {
	codexRoot  string
	claudeRoot string
	mu         sync.Mutex
	cache      map[string]string
}

func NewResolver(codexRoot, claudeRoot string) *Resolver {
	return &Resolver{
		codexRoot: cleanRoot(codexRoot), claudeRoot: cleanRoot(claudeRoot),
		cache: make(map[string]string),
	}
}

func cleanRoot(root string) string {
	if root == "" {
		return ""
	}
	return filepath.Clean(root)
}

func (r *Resolver) Resolve(agent, sessionID, recordedPath string) (string, error) {
	root := r.root(agent)
	if root == "" || !safeSessionID(sessionID) {
		return "", ErrTranscriptNotFound
	}
	if recordedPath != "" {
		if path, ok := confinedRegularFile(root, recordedPath); ok {
			return path, nil
		}
	}
	key := agent + "\x00" + sessionID
	r.mu.Lock()
	cached := r.cache[key]
	r.mu.Unlock()
	if cached != "" {
		if path, ok := confinedRegularFile(root, cached); ok {
			return path, nil
		}
	}
	path := r.find(root, agent, sessionID)
	if path == "" {
		return "", ErrTranscriptNotFound
	}
	r.mu.Lock()
	r.cache[key] = path
	r.mu.Unlock()
	return path, nil
}

func (r *Resolver) root(agent string) string {
	switch agent {
	case "codex":
		return r.codexRoot
	case "claude":
		return r.claudeRoot
	default:
		return ""
	}
}

func (r *Resolver) find(root, agent, sessionID string) string {
	var result string
	_ = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || result != "" {
			if result != "" {
				return fs.SkipAll
			}
			return nil
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			return nil
		}
		matches := entry.Name() == sessionID+".jsonl"
		if agent == "codex" {
			matches = strings.HasSuffix(entry.Name(), "-"+sessionID+".jsonl") ||
				entry.Name() == sessionID+".jsonl"
		}
		if !matches {
			return nil
		}
		if confined, ok := confinedRegularFile(root, path); ok {
			result = confined
			return fs.SkipAll
		}
		return nil
	})
	return result
}

func safeSessionID(sessionID string) bool {
	if sessionID == "" || sessionID == "." || sessionID == ".." ||
		filepath.Base(sessionID) != sessionID {
		return false
	}
	return !strings.ContainsAny(sessionID, `/\`)
}

func confinedRegularFile(root, path string) (string, bool) {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", false
	}
	resolvedPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", false
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return "", false
	}
	info, err := os.Stat(resolvedPath)
	if err != nil || !info.Mode().IsRegular() {
		return "", false
	}
	return resolvedPath, true
}
