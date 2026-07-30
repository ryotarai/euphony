package annotation

import (
	"context"
	"errors"
	"sync"
	"time"
)

type Format string

const (
	FormatMarkdown Format = "markdown"
	FormatHTML     Format = "html"

	CommentSelection = "selection"
	CommentGlobal    = "global"
)

var (
	ErrActive   = errors.New("annotation already active")
	ErrNotFound = errors.New("annotation not found")
	ErrCanceled = errors.New("annotation canceled")
)

type Session struct {
	ID         string    `json:"id"`
	TerminalID string    `json:"terminalId"`
	Filename   string    `json:"filename"`
	Format     Format    `json:"format"`
	Content    string    `json:"content"`
	CreatedAt  time.Time `json:"createdAt"`
}

type Comment struct {
	Kind        string `json:"kind"`
	Body        string `json:"body"`
	Quote       string `json:"quote,omitempty"`
	StartOffset *int   `json:"startOffset,omitempty"`
	EndOffset   *int   `json:"endOffset,omitempty"`
}

type Result struct {
	AnnotationID string    `json:"annotationId"`
	Comments     []Comment `json:"comments"`
}

type entry struct {
	session     Session
	done        chan struct{}
	result      *Result
	canceled    bool
	waitStarted bool
	waiting     int
}

type Store struct {
	mu         sync.Mutex
	now        func() time.Time
	newID      func() string
	entries    map[string]*entry
	byTerminal map[string]string
}

func NewStore(now func() time.Time, newID func() string) *Store {
	return &Store{
		now:        now,
		newID:      newID,
		entries:    make(map[string]*entry),
		byTerminal: make(map[string]string),
	}
}

func (s *Store) Create(
	terminalID, filename string,
	format Format,
	content string,
) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.byTerminal[terminalID]; exists {
		return Session{}, ErrActive
	}
	session := Session{
		ID:         s.newID(),
		TerminalID: terminalID,
		Filename:   filename,
		Format:     format,
		Content:    content,
		CreatedAt:  s.now().UTC(),
	}
	s.entries[session.ID] = &entry{
		session: session,
		done:    make(chan struct{}),
	}
	s.byTerminal[terminalID] = session.ID
	return session, nil
}

func (s *Store) Current(terminalID string) (Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, found := s.byTerminal[terminalID]
	if !found {
		return Session{}, false
	}
	item, found := s.entries[id]
	if !found || item.result != nil || item.canceled {
		return Session{}, false
	}
	return item.session, true
}

func (s *Store) Wait(ctx context.Context, id string) (Result, error) {
	s.mu.Lock()
	item, found := s.entries[id]
	if !found {
		s.mu.Unlock()
		return Result{}, ErrNotFound
	}
	item.waitStarted = true
	item.waiting++
	done := item.done
	s.mu.Unlock()

	select {
	case <-ctx.Done():
		s.mu.Lock()
		item.waiting--
		if item.canceled && item.waiting == 0 {
			delete(s.entries, id)
		}
		s.mu.Unlock()
		return Result{}, ctx.Err()
	case <-done:
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	item, found = s.entries[id]
	if !found {
		return Result{}, ErrNotFound
	}
	item.waiting--
	delete(s.entries, id)
	if item.canceled {
		return Result{}, ErrCanceled
	}
	if item.result == nil {
		return Result{}, ErrNotFound
	}
	return cloneResult(*item.result), nil
}

func (s *Store) Complete(
	id string,
	comments []Comment,
) (Result, Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, found := s.entries[id]
	if !found || item.result != nil || item.canceled {
		return Result{}, Session{}, ErrNotFound
	}
	result := Result{
		AnnotationID: id,
		Comments:     cloneComments(comments),
	}
	item.result = &result
	delete(s.byTerminal, item.session.TerminalID)
	close(item.done)
	return cloneResult(result), item.session, nil
}

func (s *Store) Cancel(id string) (Session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, found := s.entries[id]
	if !found || item.result != nil || item.canceled {
		return Session{}, ErrNotFound
	}
	item.canceled = true
	delete(s.byTerminal, item.session.TerminalID)
	close(item.done)
	if item.waitStarted && item.waiting == 0 {
		delete(s.entries, id)
	}
	return item.session, nil
}

func cloneResult(result Result) Result {
	result.Comments = cloneComments(result.Comments)
	return result
}

func cloneComments(comments []Comment) []Comment {
	if comments == nil {
		return []Comment{}
	}
	cloned := make([]Comment, len(comments))
	for index, comment := range comments {
		cloned[index] = comment
		if comment.StartOffset != nil {
			value := *comment.StartOffset
			cloned[index].StartOffset = &value
		}
		if comment.EndOffset != nil {
			value := *comment.EndOffset
			cloned[index].EndOffset = &value
		}
	}
	return cloned
}
