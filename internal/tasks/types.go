package tasks

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	PriorityLow    = "low"
	PriorityMedium = "medium"
	PriorityHigh   = "high"

	StatusTodo       = "todo"
	StatusInProgress = "in_progress"
	StatusBlocked    = "blocked"
	StatusDone       = "done"

	UpdateUserInstruction = "user_instruction"
	UpdateAgentStatus     = "agent_status"
	UpdateAgentSummary    = "agent_summary"
	UpdateSystem          = "system"
	UpdateError           = "error"

	maxTitleRunes       = 160
	maxDescriptionBytes = 32 << 10
	maxUpdateBodyBytes  = 16 << 10
)

var ErrNotFound = errors.New("task not found")

type Task struct {
	ID          string       `json:"id"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Priority    string       `json:"priority"`
	Status      string       `json:"status"`
	TerminalID  string       `json:"terminalId,omitempty"`
	Agent       string       `json:"agent,omitempty"`
	CreatedAt   time.Time    `json:"createdAt"`
	UpdatedAt   time.Time    `json:"updatedAt"`
	Updates     []TaskUpdate `json:"updates,omitempty"`
}

type TaskUpdate struct {
	ID         string    `json:"id"`
	TaskID     string    `json:"taskId"`
	TerminalID string    `json:"terminalId,omitempty"`
	Kind       string    `json:"kind"`
	Body       string    `json:"body"`
	CreatedAt  time.Time `json:"createdAt"`
}

type CreateInput struct {
	Title       string
	Description string
	Priority    string
	Status      string
}

type UpdateInput struct {
	Title       *string
	Description *string
	Priority    *string
	Status      *string
}

type TaskRefinement struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    string `json:"priority"`
	Status      string `json:"status"`
	Rationale   string `json:"rationale"`
}

func ValidateTaskFields(title, description, priority, status string) error {
	title = strings.TrimSpace(title)
	if title == "" {
		return errors.New("task title is required")
	}
	if utf8.RuneCountInString(title) > maxTitleRunes {
		return fmt.Errorf("task title must be at most %d characters", maxTitleRunes)
	}
	if len(description) > maxDescriptionBytes {
		return fmt.Errorf("task description must be at most %d bytes", maxDescriptionBytes)
	}
	if !validPriority(priority) {
		return fmt.Errorf("invalid task priority %q", priority)
	}
	if !validStatus(status) {
		return fmt.Errorf("invalid task status %q", status)
	}
	return nil
}

func ValidateUpdateBody(body string) error {
	if body == "" {
		return errors.New("task update body is required")
	}
	if len(body) > maxUpdateBodyBytes {
		return fmt.Errorf("task update body must be at most %d bytes", maxUpdateBodyBytes)
	}
	return nil
}

func validPriority(value string) bool {
	return value == PriorityLow || value == PriorityMedium || value == PriorityHigh
}

func validStatus(value string) bool {
	return value == StatusTodo || value == StatusInProgress ||
		value == StatusBlocked || value == StatusDone
}

func cloneTask(task Task) Task {
	task.Updates = append([]TaskUpdate(nil), task.Updates...)
	return task
}
