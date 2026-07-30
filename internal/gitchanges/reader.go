package gitchanges

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	maxChangedFiles        = 200
	maxPatchBytes          = 1024 * 1024
	maxStatusBytes         = 4 * 1024 * 1024
	maxUntrackedStatsBytes = 1024 * 1024
)

var hunkHeaderPattern = regexp.MustCompile(
	`^@@ -([0-9]+)(?:,[0-9]+)? \+([0-9]+)(?:,[0-9]+)? @@`,
)

// Read returns a complete snapshot, including retained patches for every file.
func Read(ctx context.Context, repoRoot string) (Snapshot, error) {
	return read(ctx, repoRoot, "", true)
}

// ReadSummary returns change metadata without loading any file patches.
func ReadSummary(ctx context.Context, repoRoot string) (Snapshot, error) {
	return read(ctx, repoRoot, "", false)
}

// ReadSelected returns change metadata and the patch for one changed path.
func ReadSelected(
	ctx context.Context,
	repoRoot string,
	selectedPath string,
) (Snapshot, error) {
	return read(ctx, repoRoot, selectedPath, false)
}

func read(
	ctx context.Context,
	repoRoot string,
	selectedPath string,
	includeAllPatches bool,
) (Snapshot, error) {
	candidate, err := filepath.Abs(repoRoot)
	if err != nil {
		return Snapshot{}, err
	}
	root, err := resolveRepositoryRoot(ctx, candidate)
	if err != nil {
		return Snapshot{}, err
	}
	statusOutput, statusTruncated, err := runGit(
		ctx,
		root,
		maxStatusBytes,
		false,
		"status",
		"--porcelain=v2",
		"--branch",
		"-z",
		"--untracked-files=all",
	)
	if err != nil {
		return Snapshot{}, err
	}
	if statusTruncated {
		return Snapshot{}, errors.New("Git status exceeded the supported size")
	}
	snapshot, err := parseStatus(root, statusOutput)
	if err != nil {
		return Snapshot{}, err
	}
	if selectedPath != "" && !snapshotHasPath(snapshot, selectedPath) {
		return Snapshot{}, ErrChangeNotFound
	}
	hasHead := gitHasHead(ctx, root)
	if err := populateTrackedCounts(ctx, root, hasHead, &snapshot); err != nil {
		return Snapshot{}, err
	}
	for index := range snapshot.Files {
		file := &snapshot.Files[index]
		if file.Status == "untracked" {
			countUntracked(root, file)
			if file.StatsTruncated {
				snapshot.StatsTruncated = true
			}
		}
		snapshot.Additions += file.Additions
		snapshot.Deletions += file.Deletions
		if includeAllPatches || file.Path == selectedPath {
			if err := populatePatch(ctx, root, hasHead, file); err != nil {
				return Snapshot{}, err
			}
		}
	}
	return snapshot, nil
}

func snapshotHasPath(snapshot Snapshot, path string) bool {
	for _, file := range snapshot.Files {
		if file.Path == path {
			return true
		}
	}
	return false
}

func resolveRepositoryRoot(ctx context.Context, candidate string) (string, error) {
	output, _, err := runGit(
		ctx,
		candidate,
		64*1024,
		false,
		"rev-parse",
		"--path-format=absolute",
		"--show-toplevel",
	)
	if err != nil {
		return "", ErrNotRepository
	}
	root := strings.TrimSpace(string(output))
	if root == "" || !filepath.IsAbs(root) {
		return "", ErrNotRepository
	}
	return filepath.Clean(root), nil
}

func gitHasHead(ctx context.Context, root string) bool {
	_, _, err := runGit(ctx, root, 128, false, "rev-parse", "--verify", "HEAD")
	return err == nil
}

func parseStatus(root string, data []byte) (Snapshot, error) {
	snapshot := Snapshot{RepoRoot: root, Files: []File{}}
	records := bytes.Split(data, []byte{0})
	for index := 0; index < len(records); index++ {
		record := string(records[index])
		switch {
		case strings.HasPrefix(record, "# branch.head "):
			snapshot.Branch = strings.TrimPrefix(record, "# branch.head ")
			if snapshot.Branch == "(detached)" {
				snapshot.Branch = "Detached HEAD"
			}
		case strings.HasPrefix(record, "# branch.upstream "):
			snapshot.Upstream = strings.TrimPrefix(record, "# branch.upstream ")
		case strings.HasPrefix(record, "# branch.ab "):
			fields := strings.Fields(strings.TrimPrefix(record, "# branch.ab "))
			if len(fields) == 2 {
				snapshot.Ahead, _ = strconv.Atoi(strings.TrimPrefix(fields[0], "+"))
				snapshot.Behind, _ = strconv.Atoi(strings.TrimPrefix(fields[1], "-"))
			}
		case strings.HasPrefix(record, "1 "):
			fields := strings.SplitN(record, " ", 9)
			if len(fields) != 9 {
				return Snapshot{}, fmt.Errorf("invalid ordinary Git status record")
			}
			path := fields[8]
			if !safeRelativePath(path) {
				return Snapshot{}, fmt.Errorf("invalid changed path %q", path)
			}
			snapshot.Files = append(snapshot.Files, File{
				Path: path, Status: statusLabel(fields[1]), Hunks: []Hunk{},
			})
		case strings.HasPrefix(record, "2 "):
			fields := strings.SplitN(record, " ", 10)
			if len(fields) != 10 || index+1 >= len(records) {
				return Snapshot{}, fmt.Errorf("invalid renamed Git status record")
			}
			index++
			path := fields[9]
			previousPath := string(records[index])
			if !safeRelativePath(path) || !safeRelativePath(previousPath) {
				return Snapshot{}, fmt.Errorf("invalid renamed paths")
			}
			snapshot.Files = append(snapshot.Files, File{
				Path: path, PreviousPath: previousPath, Status: "renamed", Hunks: []Hunk{},
			})
		case strings.HasPrefix(record, "? "):
			path := strings.TrimPrefix(record, "? ")
			if !safeRelativePath(path) {
				return Snapshot{}, fmt.Errorf("invalid untracked path %q", path)
			}
			snapshot.Files = append(snapshot.Files, File{
				Path: path, Status: "untracked", Hunks: []Hunk{},
			})
		}
		if len(snapshot.Files) == maxChangedFiles {
			snapshot.Truncated = hasMoreStatusRecords(records[index+1:])
			break
		}
	}
	sort.SliceStable(snapshot.Files, func(i, j int) bool {
		return snapshot.Files[i].Path < snapshot.Files[j].Path
	})
	return snapshot, nil
}

func hasMoreStatusRecords(records [][]byte) bool {
	for _, record := range records {
		if len(record) > 0 && record[0] != '#' {
			return true
		}
	}
	return false
}

func safeRelativePath(path string) bool {
	if path == "" || filepath.IsAbs(path) {
		return false
	}
	clean := filepath.Clean(path)
	return clean != ".." &&
		!strings.HasPrefix(clean, ".."+string(filepath.Separator))
}

func statusLabel(xy string) string {
	for _, marker := range xy {
		switch marker {
		case 'R', 'C':
			return "renamed"
		case 'A':
			return "added"
		case 'D':
			return "deleted"
		}
	}
	return "modified"
}

func populateTrackedCounts(
	ctx context.Context,
	root string,
	hasHead bool,
	snapshot *Snapshot,
) error {
	args := []string{"diff", "--numstat", "-z"}
	if hasHead {
		args = append(args, "HEAD")
	} else {
		args = append(args, "--cached")
	}
	args = append(args, "--")
	output, truncated, err := runGit(ctx, root, maxStatusBytes, false, args...)
	if err != nil {
		return err
	}
	if truncated {
		return errors.New("Git numstat exceeded the supported size")
	}
	counts, err := parseNumstat(output)
	if err != nil {
		return err
	}
	for index := range snapshot.Files {
		file := &snapshot.Files[index]
		if file.Status == "untracked" {
			continue
		}
		if count, ok := counts[file.Path]; ok {
			file.Additions = count.additions
			file.Deletions = count.deletions
			file.Binary = count.binary
		}
	}
	return nil
}

type changeCount struct {
	additions int
	deletions int
	binary    bool
}

func parseNumstat(data []byte) (map[string]changeCount, error) {
	result := make(map[string]changeCount)
	cursor := 0
	for cursor < len(data) {
		added, next, ok := readUntil(data, cursor, '\t')
		if !ok {
			break
		}
		deleted, next, ok := readUntil(data, next, '\t')
		if !ok {
			return nil, errors.New("invalid Git numstat deletion count")
		}
		path, next, ok := readUntil(data, next, 0)
		if !ok {
			return nil, errors.New("invalid Git numstat path")
		}
		cursor = next
		if path == "" {
			_, next, ok = readUntil(data, cursor, 0)
			if !ok {
				return nil, errors.New("invalid Git numstat previous path")
			}
			path, cursor, ok = readUntil(data, next, 0)
			if !ok {
				return nil, errors.New("invalid Git numstat renamed path")
			}
		}
		count := changeCount{}
		if added == "-" || deleted == "-" {
			count.binary = true
		} else {
			count.additions, _ = strconv.Atoi(added)
			count.deletions, _ = strconv.Atoi(deleted)
		}
		result[path] = count
	}
	return result, nil
}

func readUntil(data []byte, start int, delimiter byte) (string, int, bool) {
	if start > len(data) {
		return "", start, false
	}
	offset := bytes.IndexByte(data[start:], delimiter)
	if offset < 0 {
		return "", start, false
	}
	end := start + offset
	return string(data[start:end]), end + 1, true
}

func countUntracked(root string, file *File) {
	path := filepath.Join(root, filepath.FromSlash(file.Path))
	info, err := os.Lstat(path)
	if err != nil {
		return
	}
	if info.Mode()&os.ModeSymlink != 0 {
		file.Additions = 1
		return
	}
	if !info.Mode().IsRegular() {
		file.Binary = true
		return
	}
	if info.Size() > maxUntrackedStatsBytes {
		file.StatsTruncated = true
		return
	}
	input, err := os.Open(path)
	if err != nil {
		return
	}
	defer input.Close()
	buffer := make([]byte, 32*1024)
	sawData := false
	lastByte := byte(0)
	for {
		count, readErr := input.Read(buffer)
		if count > 0 {
			chunk := buffer[:count]
			sawData = true
			lastByte = chunk[len(chunk)-1]
			if bytes.IndexByte(chunk, 0) >= 0 {
				file.Binary = true
				file.Additions = 0
				return
			}
			file.Additions += bytes.Count(chunk, []byte{'\n'})
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			file.Additions = 0
			return
		}
	}
	if sawData && lastByte != '\n' {
		file.Additions++
	}
}

func populatePatch(
	ctx context.Context,
	root string,
	hasHead bool,
	file *File,
) error {
	var args []string
	acceptDifference := false
	if file.Status == "untracked" {
		args = []string{
			"diff", "--no-ext-diff", "--no-color", "--no-index", "--unified=3",
			"--", "/dev/null", file.Path,
		}
		acceptDifference = true
	} else {
		args = []string{"diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=3"}
		if hasHead {
			args = append(args, "HEAD")
		} else {
			args = append(args, "--cached")
		}
		args = append(args, "--", file.Path)
	}
	output, truncated, err := runGit(
		ctx,
		root,
		maxPatchBytes,
		acceptDifference,
		args...,
	)
	if err != nil {
		return err
	}
	file.PatchLoaded = true
	file.Truncated = truncated
	file.Hunks = parsePatch(output)
	if bytes.Contains(output, []byte("Binary files ")) ||
		bytes.Contains(output, []byte("GIT binary patch")) {
		file.Binary = true
	}
	return nil
}

func parsePatch(data []byte) []Hunk {
	hunks := []Hunk{}
	var current *Hunk
	oldLine := 0
	newLine := 0
	for _, rawLine := range strings.Split(string(data), "\n") {
		if matches := hunkHeaderPattern.FindStringSubmatch(rawLine); matches != nil {
			oldLine, _ = strconv.Atoi(matches[1])
			newLine, _ = strconv.Atoi(matches[2])
			hunks = append(hunks, Hunk{
				Header: rawLine, OldStart: oldLine, NewStart: newLine, Lines: []Line{},
			})
			current = &hunks[len(hunks)-1]
			continue
		}
		if current == nil || rawLine == "" {
			continue
		}
		line := Line{}
		switch rawLine[0] {
		case ' ':
			line = Line{
				Kind: "context", OldLine: oldLine, NewLine: newLine, Content: rawLine[1:],
			}
			oldLine++
			newLine++
		case '-':
			line = Line{Kind: "deletion", OldLine: oldLine, Content: rawLine[1:]}
			oldLine++
		case '+':
			line = Line{Kind: "addition", NewLine: newLine, Content: rawLine[1:]}
			newLine++
		case '\\':
			line = Line{Kind: "meta", Content: rawLine}
		default:
			continue
		}
		current.Lines = append(current.Lines, line)
	}
	return hunks
}

type boundedBuffer struct {
	data      []byte
	max       int
	truncated bool
}

func (buffer *boundedBuffer) Write(data []byte) (int, error) {
	remaining := buffer.max - len(buffer.data)
	if remaining > 0 {
		retained := len(data)
		if retained > remaining {
			retained = remaining
		}
		buffer.data = append(buffer.data, data[:retained]...)
	}
	if len(data) > remaining {
		buffer.truncated = true
	}
	return len(data), nil
}

func runGit(
	ctx context.Context,
	root string,
	maxBytes int,
	acceptDifference bool,
	args ...string,
) ([]byte, bool, error) {
	commandArgs := append(
		[]string{
			"--no-optional-locks",
			"--literal-pathspecs",
			"-c",
			"core.quotePath=false",
			"-C",
			root,
		},
		args...,
	)
	command := exec.CommandContext(ctx, "git", commandArgs...)
	stdout := &boundedBuffer{max: maxBytes}
	stderr := &boundedBuffer{max: 16 * 1024}
	command.Stdout = stdout
	command.Stderr = stderr
	err := command.Run()
	if err != nil {
		var exitError *exec.ExitError
		if !(acceptDifference && errors.As(err, &exitError) && exitError.ExitCode() == 1) {
			return nil, stdout.truncated, fmt.Errorf(
				"git %s: %w: %s",
				args[0],
				err,
				strings.TrimSpace(string(stderr.data)),
			)
		}
	}
	return stdout.data, stdout.truncated, nil
}
