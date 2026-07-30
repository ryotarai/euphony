package agentlog

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var ErrTranscriptNotFound = errors.New("agent transcript not found")

const fallbackMissCacheTTL = 5 * time.Second

type Resolver struct {
	codexRoot  string
	claudeRoot string
	mu         sync.Mutex
	cache      map[string]string
	misses     map[string]time.Time
	now        func() time.Time
}

func NewResolver(codexRoot, claudeRoot string) *Resolver {
	return &Resolver{
		codexRoot: cleanRoot(codexRoot), claudeRoot: cleanRoot(claudeRoot),
		cache: make(map[string]string), misses: make(map[string]time.Time),
		now: time.Now,
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
	if recordedPath != "" && matchesSessionFilename(agent, filepath.Base(recordedPath), sessionID) {
		if path, ok := r.resolveMatchingFile(root, agent, sessionID, recordedPath); ok {
			return path, nil
		}
	}
	key := agent + "\x00" + sessionID
	r.mu.Lock()
	cached := r.cache[key]
	missUntil := r.misses[key]
	r.mu.Unlock()
	if cached != "" {
		if path, ok := r.resolveMatchingFile(root, agent, sessionID, cached); ok {
			return path, nil
		}
	}
	if r.now().Before(missUntil) {
		return "", ErrTranscriptNotFound
	}
	path := r.find(root, agent, sessionID)
	if path == "" {
		r.mu.Lock()
		r.misses[key] = r.now().Add(fallbackMissCacheTTL)
		r.mu.Unlock()
		return "", ErrTranscriptNotFound
	}
	r.mu.Lock()
	r.cache[key] = path
	delete(r.misses, key)
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
		if !matchesSessionFilename(agent, entry.Name(), sessionID) {
			return nil
		}
		if confined, ok := r.resolveMatchingFile(root, agent, sessionID, path); ok {
			result = confined
			return fs.SkipAll
		}
		return nil
	})
	return result
}

func (r *Resolver) resolveMatchingFile(root, agent, sessionID, path string) (string, bool) {
	resolved, ok := confinedRegularFile(root, path)
	if !ok || !matchesSessionFilename(agent, filepath.Base(resolved), sessionID) {
		return "", false
	}
	return resolved, true
}

func matchesSessionFilename(agent, name, sessionID string) bool {
	if name == sessionID+".jsonl" {
		return true
	}
	return agent == "codex" && strings.HasSuffix(name, "-"+sessionID+".jsonl")
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
