package agentlog

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
)

const reverseScanChunkBytes = 64 << 10

var ErrCursorBeyondEnd = errors.New("agent log cursor is beyond the transcript")

type Page struct {
	Entries     []Entry
	StartCursor int64
	EndCursor   int64
	HasMore     bool
}

func ReadPage(
	agent string,
	file *os.File,
	before int64,
	recordLimit int,
) (Page, error) {
	if before < 0 || recordLimit <= 0 {
		return Page{}, fmt.Errorf("invalid agent log page")
	}
	info, err := file.Stat()
	if err != nil {
		return Page{}, fmt.Errorf("stat transcript: %w", err)
	}
	if before > info.Size() {
		before = info.Size()
	}
	if before == info.Size() {
		before, err = completeJSONLEnd(file, before)
		if err != nil {
			return Page{}, err
		}
	}
	start, err := pageStart(file, before, recordLimit)
	if err != nil {
		return Page{}, err
	}
	entries, err := ParseAt(
		agent,
		io.NewSectionReader(file, start, before-start),
		start,
	)
	if err != nil {
		return Page{}, err
	}
	return Page{
		Entries:     CompactTools(entries),
		StartCursor: start,
		EndCursor:   before,
		HasMore:     start > 0,
	}, nil
}

func ReadAfter(agent string, file *os.File, after int64) (Page, error) {
	if after < 0 {
		return Page{}, fmt.Errorf("invalid agent log cursor")
	}
	info, err := file.Stat()
	if err != nil {
		return Page{}, fmt.Errorf("stat transcript: %w", err)
	}
	if after > info.Size() {
		return Page{}, ErrCursorBeyondEnd
	}
	end, err := completeJSONLEnd(file, info.Size())
	if err != nil {
		return Page{}, err
	}
	if after > end {
		return Page{}, ErrCursorBeyondEnd
	}
	entries, err := ParseAt(
		agent,
		io.NewSectionReader(file, after, end-after),
		after,
	)
	if err != nil {
		return Page{}, err
	}
	return Page{
		Entries:     CompactTools(entries),
		StartCursor: after,
		EndCursor:   end,
	}, nil
}

func CompactTools(entries []Entry) []Entry {
	compacted := make([]Entry, 0, len(entries))
	var group Entry
	flush := func() {
		if group.ToolCalls > 0 {
			compacted = append(compacted, group)
		}
		group = Entry{}
	}
	for _, entry := range entries {
		if entry.Kind != "tool" && entry.Kind != "tool_result" {
			flush()
			compacted = append(compacted, entry)
			continue
		}
		if entry.Kind != "tool" {
			continue
		}
		if group.ToolCalls == 0 {
			group = Entry{
				ID:        entry.ID,
				Kind:      "tool_group",
				Timestamp: entry.Timestamp,
			}
		}
		group.ToolCalls++
	}
	flush()
	return compacted
}

func pageStart(file *os.File, before int64, recordLimit int) (int64, error) {
	if before == 0 {
		return 0, nil
	}
	buffer := make([]byte, reverseScanChunkBytes)
	cursor := before
	boundaries := 0
	for cursor > 0 {
		start := cursor - int64(len(buffer))
		if start < 0 {
			start = 0
		}
		length := int(cursor - start)
		n, err := file.ReadAt(buffer[:length], start)
		if err != nil && !errors.Is(err, io.EOF) {
			return 0, fmt.Errorf("scan transcript: %w", err)
		}
		for index := n - 1; index >= 0; index-- {
			position := start + int64(index)
			if buffer[index] != '\n' || position == before-1 {
				continue
			}
			boundaries++
			if boundaries == recordLimit {
				return position + 1, nil
			}
		}
		cursor = start
	}
	return 0, nil
}

func completeJSONLEnd(file *os.File, size int64) (int64, error) {
	if size == 0 {
		return 0, nil
	}
	last := []byte{0}
	if _, err := file.ReadAt(last, size-1); err != nil {
		return 0, fmt.Errorf("read transcript end: %w", err)
	}
	if last[0] == '\n' {
		return size, nil
	}
	start, err := pageStart(file, size, 1)
	if err != nil {
		return 0, err
	}
	record := make([]byte, size-start)
	if _, err := file.ReadAt(record, start); err != nil && !errors.Is(err, io.EOF) {
		return 0, fmt.Errorf("read transcript record: %w", err)
	}
	if json.Valid(record) {
		return size, nil
	}
	return start, nil
}
