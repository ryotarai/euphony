package project

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/google/uuid"
)

var (
	ErrNotFound      = errors.New("project not found")
	ErrAlreadyExists = errors.New("project already exists")
	ErrInvalidPath   = errors.New("invalid project path")
	ErrInvalidOrder  = errors.New("invalid project order")
)

type Project struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	CreatedAt time.Time `json:"createdAt"`
	Order     int64     `json:"order,omitempty"`
}

type Service struct {
	repository Repository
	now        func() time.Time
	newID      func() string
}

func NewService(repository Repository, now func() time.Time, newID func() string) *Service {
	if repository == nil {
		repository = NewMemoryRepository()
	}
	if now == nil {
		now = time.Now
	}
	if newID == nil {
		newID = uuid.NewString
	}
	return &Service{repository: repository, now: now, newID: newID}
}

func (s *Service) List(ctx context.Context) ([]Project, error) {
	projects, err := s.repository.List(ctx)
	if err != nil {
		return nil, err
	}
	sortProjects(projects)
	return projects, nil
}

func (s *Service) Get(ctx context.Context, id string) (Project, error) {
	return s.repository.Get(ctx, id)
}

func (s *Service) Delete(ctx context.Context, id string) error {
	return s.repository.Delete(ctx, id)
}

func (s *Service) Create(ctx context.Context, path string) (Project, error) {
	path, err := normalizePath(path)
	if err != nil {
		return Project{}, err
	}
	projects, err := s.repository.List(ctx)
	if err != nil {
		return Project{}, err
	}
	for _, project := range projects {
		if project.Path == path {
			return Project{}, ErrAlreadyExists
		}
	}

	project := Project{ID: s.newID(), Path: path, CreatedAt: s.now().UTC()}
	for _, existing := range projects {
		if existing.Order > project.Order {
			project.Order = existing.Order
		}
	}
	if project.Order > 0 {
		project.Order++
	}
	if err := s.repository.Create(ctx, project); err != nil {
		return Project{}, err
	}
	return project, nil
}

func (s *Service) Reorder(ctx context.Context, orderedIDs []string) ([]Project, error) {
	projects, err := s.repository.List(ctx)
	if err != nil {
		return nil, err
	}
	if len(orderedIDs) != len(projects) {
		return nil, ErrInvalidOrder
	}
	known := make(map[string]struct{}, len(projects))
	for _, project := range projects {
		known[project.ID] = struct{}{}
	}
	seen := make(map[string]struct{}, len(orderedIDs))
	for _, id := range orderedIDs {
		if _, ok := known[id]; !ok {
			return nil, ErrNotFound
		}
		if _, duplicate := seen[id]; duplicate {
			return nil, ErrInvalidOrder
		}
		seen[id] = struct{}{}
	}
	if err := s.repository.Reorder(ctx, orderedIDs); err != nil {
		return nil, err
	}
	return s.List(ctx)
}

func normalizePath(path string) (string, error) {
	absolute, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("%w: normalize project path: %v", ErrInvalidPath, err)
	}
	absolute = filepath.Clean(absolute)
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("%w: stat project path: %v", ErrInvalidPath, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%w: project path is not a directory: %s", ErrInvalidPath, absolute)
	}
	return absolute, nil
}

func sortProjects(projects []Project) {
	sort.SliceStable(projects, func(i, j int) bool {
		if projects[i].Order != projects[j].Order {
			if projects[i].Order == 0 {
				return false
			}
			if projects[j].Order == 0 {
				return true
			}
			return projects[i].Order < projects[j].Order
		}
		if projects[i].CreatedAt.Equal(projects[j].CreatedAt) {
			return projects[i].ID < projects[j].ID
		}
		return projects[i].CreatedAt.Before(projects[j].CreatedAt)
	})
}
