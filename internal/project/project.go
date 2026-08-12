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
)

type Project struct {
	ID        string    `json:"id"`
	Path      string    `json:"path"`
	CreatedAt time.Time `json:"createdAt"`
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
	if err := s.repository.Create(ctx, project); err != nil {
		return Project{}, err
	}
	return project, nil
}

func normalizePath(path string) (string, error) {
	absolute, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", fmt.Errorf("normalize project path: %w", err)
	}
	absolute = filepath.Clean(absolute)
	info, err := os.Stat(absolute)
	if err != nil {
		return "", fmt.Errorf("stat project path: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("project path is not a directory: %s", absolute)
	}
	return absolute, nil
}

func sortProjects(projects []Project) {
	sort.SliceStable(projects, func(i, j int) bool {
		if projects[i].CreatedAt.Equal(projects[j].CreatedAt) {
			return projects[i].ID < projects[j].ID
		}
		return projects[i].CreatedAt.Before(projects[j].CreatedAt)
	})
}
