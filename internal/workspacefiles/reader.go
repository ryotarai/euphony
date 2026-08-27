package workspacefiles

import (
	"bytes"
	"context"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

type Reader struct {
	root       string
	rootHandle *os.Root
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
	root = filepath.Clean(root)
	rootHandle, err := os.OpenRoot(root)
	if err != nil {
		return nil, classifyPathError(err)
	}
	return &Reader{root: root, rootHandle: rootHandle}, nil
}

func (r *Reader) Root() string {
	return r.root
}

func (r *Reader) Close() error {
	return r.rootHandle.Close()
}

func (r *Reader) Directory(path string) (Directory, error) {
	clean, err := cleanPath(path, true)
	if err != nil {
		return Directory{}, err
	}
	handle, err := r.rootHandle.OpenFile(rootPath(clean), secureReadOnlyFlags, 0)
	if err != nil {
		return Directory{}, classifyPathError(err)
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return Directory{}, classifyPathError(err)
	}
	if !info.IsDir() {
		return Directory{}, ErrTypeMismatch
	}
	entries, err := handle.ReadDir(maxDirectoryEntries + 1)
	if err != nil && !errors.Is(err, io.EOF) {
		return Directory{}, classifyPathError(err)
	}

	truncated := len(entries) > maxDirectoryEntries
	if truncated {
		entries = entries[:maxDirectoryEntries]
	}
	result := make([]Entry, 0, len(entries))
	for _, dirEntry := range entries {
		entry, entryErr := r.entry(clean, dirEntry)
		if entryErr != nil {
			return Directory{}, entryErr
		}
		result = append(result, entry)
	}
	sortEntries(result)
	return Directory{
		Root:      r.root,
		Path:      slash(clean),
		Entries:   result,
		Truncated: truncated,
	}, nil
}

func (r *Reader) File(path string) (File, error) {
	clean, err := cleanPath(path, false)
	if err != nil {
		return File{}, err
	}
	handle, info, err := r.openRegularFile(clean)
	if err != nil {
		return File{}, err
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
	utf8Data, valid := completeUTF8Prefix(data, truncated)
	binary := bytes.IndexByte(data, 0) >= 0 || !valid
	content := ""
	if !binary {
		content = string(utf8Data)
	}
	return File{
		Root:      r.root,
		Name:      filepath.Base(clean),
		Path:      slash(clean),
		Size:      info.Size(),
		MimeType:  http.DetectContentType(data),
		Content:   content,
		Binary:    binary,
		Truncated: truncated,
	}, nil
}

func (r *Reader) OpenFile(path string) (*os.File, fs.FileInfo, error) {
	clean, err := cleanPath(path, false)
	if err != nil {
		return nil, nil, err
	}
	return r.openRegularFile(clean)
}

func (r *Reader) openRegularFile(clean string) (*os.File, fs.FileInfo, error) {
	handle, err := r.rootHandle.OpenFile(rootPath(clean), secureReadOnlyFlags, 0)
	if err != nil {
		return nil, nil, classifyPathError(err)
	}
	info, err := handle.Stat()
	if err != nil {
		handle.Close()
		return nil, nil, classifyPathError(err)
	}
	if !info.Mode().IsRegular() {
		handle.Close()
		return nil, nil, ErrTypeMismatch
	}
	return handle, info, nil
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

	err := fs.WalkDir(r.rootHandle.FS(), ".", func(
		path string,
		entry fs.DirEntry,
		walkErr error,
	) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) ||
				errors.Is(walkErr, os.ErrPermission) {
				return nil
			}
			return walkErr
		}
		if path == "." {
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
		relative := strings.TrimPrefix(path, "./")
		if !strings.Contains(strings.ToLower(relative), needle) {
			return nil
		}
		if len(matches) == maxSearchResults {
			truncated = true
			return stop
		}
		result, resultErr := r.entry(pathpkg.Dir(relative), entry)
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

func cleanPath(path string, allowRoot bool) (string, error) {
	if strings.IndexByte(path, 0) >= 0 || filepath.IsAbs(path) {
		return "", ErrInvalidPath
	}
	clean := filepath.Clean(path)
	if path == "" || clean == "." {
		if !allowRoot && path == "" {
			return "", ErrInvalidPath
		}
		clean = ""
	}
	if clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", ErrInvalidPath
	}
	return clean, nil
}

func (r *Reader) entry(parent string, entry fs.DirEntry) (Entry, error) {
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
	case strings.Contains(err.Error(), "path escapes from parent"):
		return ErrInvalidPath
	case errors.Is(err, os.ErrPermission):
		return err
	default:
		return err
	}
}

func completeUTF8Prefix(data []byte, allowIncompleteSuffix bool) ([]byte, bool) {
	for offset := 0; offset < len(data); {
		if !utf8.FullRune(data[offset:]) {
			if allowIncompleteSuffix {
				return data[:offset], true
			}
			return nil, false
		}
		runeValue, size := utf8.DecodeRune(data[offset:])
		if runeValue == utf8.RuneError && size == 1 {
			return nil, false
		}
		offset += size
	}
	return data, true
}

func rootPath(path string) string {
	if path == "" {
		return "."
	}
	return filepath.ToSlash(path)
}

func slash(path string) string {
	if path == "" || path == "." {
		return ""
	}
	return filepath.ToSlash(path)
}
