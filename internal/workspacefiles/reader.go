package workspacefiles

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

type Reader struct {
	root string
}

func New(ctx context.Context, cwd string) (*Reader, error) {
	candidate, err := filepath.Abs(cwd)
	if err != nil {
		return nil, err
	}
	candidate, err = filepath.EvalSymlinks(candidate)
	if err != nil {
		return nil, classifyPathError(err)
	}
	info, err := os.Stat(candidate)
	if err != nil {
		return nil, classifyPathError(err)
	}
	if !info.IsDir() {
		return nil, ErrTypeMismatch
	}

	root := candidate
	command := exec.CommandContext(
		ctx,
		"git",
		"-C",
		candidate,
		"rev-parse",
		"--path-format=absolute",
		"--show-toplevel",
	)
	if output, commandErr := command.Output(); commandErr == nil {
		gitRoot := strings.TrimSpace(string(output))
		if filepath.IsAbs(gitRoot) {
			if resolved, resolveErr := filepath.EvalSymlinks(gitRoot); resolveErr == nil {
				root = resolved
			}
		}
	}
	return &Reader{root: filepath.Clean(root)}, nil
}

func (r *Reader) Root() string {
	return r.root
}

func (r *Reader) Directory(path string) (Directory, error) {
	target, clean, err := r.resolve(path, true)
	if err != nil {
		return Directory{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return Directory{}, classifyPathError(err)
	}
	if !info.IsDir() {
		return Directory{}, ErrTypeMismatch
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return Directory{}, classifyPathError(err)
	}

	result := make([]Entry, 0, min(len(entries), maxDirectoryEntries))
	for _, dirEntry := range entries {
		entry, entryErr := r.entry(clean, dirEntry)
		if entryErr != nil {
			return Directory{}, entryErr
		}
		result = append(result, entry)
	}
	sortEntries(result)
	truncated := len(result) > maxDirectoryEntries
	if truncated {
		result = result[:maxDirectoryEntries]
	}
	return Directory{
		Root:      r.root,
		Path:      slash(clean),
		Entries:   result,
		Truncated: truncated,
	}, nil
}

func (r *Reader) File(path string) (File, error) {
	target, clean, err := r.resolve(path, false)
	if err != nil {
		return File{}, err
	}
	info, err := os.Stat(target)
	if err != nil {
		return File{}, classifyPathError(err)
	}
	if !info.Mode().IsRegular() {
		return File{}, ErrTypeMismatch
	}
	handle, err := os.Open(target)
	if err != nil {
		return File{}, classifyPathError(err)
	}
	defer handle.Close()

	data, err := io.ReadAll(io.LimitReader(handle, maxFileBytes+1))
	if err != nil {
		return File{}, err
	}
	truncated := len(data) > maxFileBytes
	if truncated {
		data = data[:maxFileBytes]
	}
	binary := bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data)
	content := ""
	if !binary {
		content = string(data)
	}
	return File{
		Root:      r.root,
		Name:      filepath.Base(clean),
		Path:      slash(clean),
		Size:      info.Size(),
		Content:   content,
		Binary:    binary,
		Truncated: truncated,
	}, nil
}

func (r *Reader) Search(query string) (SearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return SearchResult{}, ErrInvalidQuery
	}
	needle := strings.ToLower(query)
	matches := make([]Entry, 0, min(32, maxSearchResults))
	visits := 0
	truncated := false
	stop := errors.New("workspace search complete")
	skippedDirectories := map[string]bool{
		".git": true, "node_modules": true, ".cache": true,
	}

	err := filepath.WalkDir(r.root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) ||
				errors.Is(walkErr, os.ErrPermission) {
				return nil
			}
			return walkErr
		}
		if path == r.root {
			return nil
		}
		if entry.IsDir() && skippedDirectories[entry.Name()] {
			return filepath.SkipDir
		}
		visits++
		if visits > maxSearchVisits {
			truncated = true
			return stop
		}
		relative, relativeErr := filepath.Rel(r.root, path)
		if relativeErr != nil {
			return relativeErr
		}
		relative = slash(relative)
		if !strings.Contains(strings.ToLower(relative), needle) {
			return nil
		}
		if len(matches) == maxSearchResults {
			truncated = true
			return stop
		}
		result, resultErr := r.entry(filepath.Dir(relative), entry)
		if resultErr != nil {
			return resultErr
		}
		result.Path = relative
		matches = append(matches, result)
		return nil
	})
	if err != nil && !errors.Is(err, stop) {
		return SearchResult{}, err
	}
	return SearchResult{
		Root:      r.root,
		Query:     query,
		Matches:   matches,
		Truncated: truncated,
	}, nil
}

func (r *Reader) resolve(path string, allowRoot bool) (string, string, error) {
	if strings.IndexByte(path, 0) >= 0 || filepath.IsAbs(path) {
		return "", "", ErrInvalidPath
	}
	clean := filepath.Clean(path)
	if path == "" || clean == "." {
		if !allowRoot && path == "" {
			return "", "", ErrInvalidPath
		}
		clean = ""
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", "", ErrInvalidPath
	}
	target := r.root
	if clean != "" {
		target = filepath.Join(r.root, clean)
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return "", "", classifyPathError(err)
	}
	relative, err := filepath.Rel(r.root, resolved)
	if err != nil ||
		relative == ".." ||
		strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", "", ErrInvalidPath
	}
	return resolved, clean, nil
}

func (r *Reader) entry(parent string, entry os.DirEntry) (Entry, error) {
	kind := KindOther
	size := int64(0)
	switch {
	case entry.Type()&os.ModeSymlink != 0:
		kind = KindSymlink
	case entry.IsDir():
		kind = KindDirectory
	default:
		info, err := entry.Info()
		if err != nil {
			return Entry{}, classifyPathError(err)
		}
		if info.Mode().IsRegular() {
			kind = KindFile
			size = info.Size()
		}
	}
	path := entry.Name()
	if parent != "" && parent != "." {
		path = filepath.Join(parent, entry.Name())
	}
	return Entry{
		Name: entry.Name(),
		Path: slash(path),
		Kind: kind,
		Size: size,
	}, nil
}

func sortEntries(entries []Entry) {
	sort.SliceStable(entries, func(left, right int) bool {
		leftDirectory := entries[left].Kind == KindDirectory
		rightDirectory := entries[right].Kind == KindDirectory
		if leftDirectory != rightDirectory {
			return leftDirectory
		}
		leftName := strings.ToLower(entries[left].Name)
		rightName := strings.ToLower(entries[right].Name)
		if leftName == rightName {
			return entries[left].Name < entries[right].Name
		}
		return leftName < rightName
	})
}

func classifyPathError(err error) error {
	switch {
	case errors.Is(err, os.ErrNotExist):
		return ErrPathNotFound
	case errors.Is(err, os.ErrPermission):
		return err
	default:
		return err
	}
}

func slash(path string) string {
	if path == "" || path == "." {
		return ""
	}
	return filepath.ToSlash(path)
}
