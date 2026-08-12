# Project Sidebar Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce persisted projects as the required workspace boundary, then merge Inbox agent signals into a project-grouped sidebar where users can create terminals or agents inside a chosen project.

**Architecture:** Add an `internal/project` service and SQLite-backed repository. Persist `ProjectID` on terminal metadata, expose project list/create endpoints, and make project-scoped terminal creation resolve the directory server-side. Build a focused React project sidebar from explicit projects and summaries, keep legacy unassigned sessions visible, and remove the standalone Agents/Done pane and sidebar multi-selection controls.

**Tech Stack:** Go, SQLite, React 19, TypeScript, Vitest, Testing Library, Playwright, existing lucide-react icons and CSS theme.

## Global Constraints

- Users create a project with an existing directory before creating new terminal or agent work.
- A project is persisted with a stable ID, canonical path, and creation timestamp.
- `Session.ProjectID` is persisted; legacy sessions are migrated into projects at startup.
- Project-scoped terminal creation uses the project directory resolved by the server.
- Unread agent rows use bold typography and do not change lifecycle status semantics.
- Existing selection, Tasks, agent summaries, and backend automation APIs remain compatible.
- No terminal/agent split checkbox is rendered by the new sidebar.
- Done summaries remain backend-compatible but are omitted from the sidebar Inbox surface.
- Every behavior change follows RED → GREEN → REFACTOR, with the failing test observed first.

---

### Task 1: Add the persisted Project domain and storage

**Files:**
- Create: `internal/project/project.go`
- Create: `internal/project/store.go`
- Create: `internal/project/service_test.go`
- Create: `internal/project/store_test.go`

**Interfaces:**
- Produces `project.Project{ID, Path, CreatedAt}`.
- Produces `project.Service.List`, `project.Service.Get`, and
  `project.Service.Create`.
- `project.Repository` supports memory and SQLite implementations plus `Close`.

- [ ] **Step 1: Write failing service tests**

```go
func TestCreateCanonicalizesAndPersistsAnExistingDirectory(t *testing.T) {
    repo := NewMemoryRepository()
    service := NewService(repo, func() time.Time { return time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC) }, func() string { return "project-1" })
    directory := t.TempDir()

    created, err := service.Create(context.Background(), directory+"/.")
    if err != nil { t.Fatalf("Create() error = %v", err) }
    if created.ID != "project-1" || created.Path != directory {
        t.Fatalf("created project = %#v", created)
    }
    listed, err := service.List(context.Background())
    if err != nil || len(listed) != 1 || listed[0].ID != created.ID {
        t.Fatalf("List() = %#v, %v", listed, err)
    }
}

func TestCreateRejectsMissingAndDuplicateDirectories(t *testing.T) {
    repo := NewMemoryRepository()
    service := NewService(repo, time.Now, uuid.NewString)
    directory := t.TempDir()
    if _, err := service.Create(context.Background(), filepath.Join(directory, "missing")); err == nil {
        t.Fatal("Create(missing) error = nil")
    }
    if _, err := service.Create(context.Background(), directory); err != nil { t.Fatal(err) }
    if _, err := service.Create(context.Background(), directory); !errors.Is(err, ErrAlreadyExists) {
        t.Fatalf("duplicate error = %v", err)
    }
}
```

- [ ] **Step 2: Run tests to verify the service fails**

Run: `go test ./internal/project -run 'TestCreate' -count=1`

Expected: FAIL because the project package and service do not exist.

- [ ] **Step 3: Implement memory repository, validation, and service**

Normalize with `filepath.Abs` and `filepath.Clean`, require `os.Stat(path)` to
return a directory, reject duplicate normalized paths, generate the ID and
timestamp in the service, and sort `List` by `CreatedAt` then ID.

- [ ] **Step 4: Add SQLite migration and round-trip test**

Create `projects(id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL)` and test reopening a temporary database preserves the project. Use `:memory:` only for an isolated in-process test.

- [ ] **Step 5: Run project tests and commit**

Run: `go test ./internal/project -count=1`

Expected: PASS.

```bash
git add internal/project
git commit -m "feat: add persisted projects"
```

### Task 2: Link terminal metadata to projects and expose project APIs

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/session/manager_test.go`
- Modify: `internal/session/sqlite_store_test.go`
- Modify: `internal/server/server.go`
- Create: `internal/server/projects.go`
- Create: `internal/server/projects_test.go`
- Modify: `internal/server/v1_terminal.go`
- Modify: `internal/apiclient/client.go`
- Modify: `internal/apiclient/client_test.go`

**Interfaces:**
- `session.Metadata.ProjectID string` serializes as `projectId` when present.
- `Manager.CreateInProject(ctx, name, projectID, cwd)` creates and persists a
  linked terminal; existing `Manager.Create` remains unchanged for legacy API
  callers.
- HTTP: `GET /api/projects`, `POST /api/projects`, and project-aware
  `POST /api/v1/terminals`.
- Browser API: `listProjects`, `createProject`, and
  `createTerminal(name, projectID, selectionMode)`.

- [ ] **Step 1: Write failing metadata/API tests**

```go
func TestCreateInProjectRoundTripsProjectID(t *testing.T) {
    manager := newPersistentTestManager(t)
    created, err := manager.CreateInProject(t.Context(), "Terminal", "project-1", t.TempDir())
    if err != nil { t.Fatal(err) }
    listed := manager.ListCurrent()
    if listed[0].ID != created.ID || listed[0].ProjectID != "project-1" {
        t.Fatalf("metadata = %#v", listed[0])
    }
}
```

```go
func TestProjectsEndpointCreatesAndListsProjects(t *testing.T) {
    srv := newProjectTestServer(t)
    directory := t.TempDir()
    created := performRequest(t, srv, http.MethodPost, "/api/projects", `{"path":`+strconv.Quote(directory)+`}`)
    if created.Code != http.StatusCreated { t.Fatalf("create status = %d", created.Code) }
    listed := performRequest(t, srv, http.MethodGet, "/api/projects", "")
    if listed.Code != http.StatusOK || !strings.Contains(listed.Body.String(), directory) { t.Fatalf("list = %s", listed.Body.String()) }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/session ./internal/server -run 'Project|Projects' -count=1`

Expected: FAIL because ProjectID, project routes, and project-aware creation do not exist.

- [ ] **Step 3: Add the ProjectID migration and manager method**

Add `project_id TEXT NOT NULL DEFAULT ''` to the terminal schema with a guarded `ALTER TABLE` for existing databases. Include it in `Load` and `Save`. Factor the existing `Manager.Create` implementation through an internal helper that accepts an optional project ID, then expose `CreateInProject` without changing existing call sites.

- [ ] **Step 4: Wire project service into the server and migrate legacy terminals**

Open the project repository using the configured database path. Before serving
requests, create a project for each legacy terminal whose ProjectID is empty,
using its current directory, and persist the assignment through a new manager
assignment helper. Close the project service during server shutdown and close
it on all construction error paths.

- [ ] **Step 5: Add project endpoints and project-scoped terminal creation**

`POST /api/projects` accepts only `{ "path": "..." }`, rejects unknown fields,
and returns stable error codes for invalid or duplicate paths. Extend the v1
terminal request with optional `projectId`; when present, resolve the project,
use its path as CWD, and persist the ProjectID. Keep absent projectId behavior
for legacy automation callers, while the browser always sends it.

- [ ] **Step 6: Add browser API methods and run focused tests**

Run: `go test ./internal/session ./internal/server ./internal/apiclient -count=1`

Expected: PASS, including terminal ProjectID round trips and HTTP request bodies.

```bash
git add internal/session internal/server internal/apiclient
git commit -m "feat: link terminals to projects"
```

### Task 3: Add project-first browser state and creation flow

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/api.test.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- `Project { id: string; path: string; createdAt: string }`.
- `ApiClient.listProjects(): Promise<Project[]>` and
  `ApiClient.createProject(path: string): Promise<Project>`.
- `App` stores projects independently from sessions and passes a selected
  `projectId` into creation callbacks.

- [ ] **Step 1: Write failing tests for project-first behavior**

```tsx
test("shows the project setup action without creating an implicit terminal", async () => {
    mockProjects([]);
    mockSessions([]);
    render(<App initialToken="valid-token" syncSelection={false} syncEvents={false} />);
    expect(await screen.findByRole("button", { name: "Add project" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Select Terminal/ })).not.toBeInTheDocument();
});

test("creates a project and renders its empty project section", async () => {
    mockProjects([]);
    mockSessions([]);
    render(<App initialToken="valid-token" syncSelection={false} syncEvents={false} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add project" }));
    await user.type(screen.getByLabelText("Project directory"), "/workspace/new-project");
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByRole("heading", { name: "/workspace/new-project" })).toBeVisible();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/App.test.tsx -t "project setup|creates a project"`

Expected: FAIL because the App creates an implicit terminal and has no project API/state.

- [ ] **Step 3: Implement project loading and creation**

Load projects alongside sessions. If the project endpoint is unavailable in an
older test/server, derive a read-only legacy project list from session fields;
do not use that fallback for new creation. When the server returns no projects,
keep sessions empty and render the project-first empty state. The create form
must keep open on API errors and close only after a successful response.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm test -- src/api.test.ts src/App.test.tsx -t "project|implicit terminal"`

Expected: PASS.

```bash
git add web/src/types.ts web/src/api.ts web/src/api.test.ts web/src/App.tsx web/src/App.test.tsx
git commit -m "feat: require projects before browser work"
```

### Task 4: Build the project-grouped Inbox sidebar

**Files:**
- Create: `web/src/components/ProjectSidebar.tsx`
- Create: `web/src/components/ProjectSidebar.test.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`

**Interfaces:**
- `ProjectSidebar` consumes `projects`, `sessions`, `agentSummaries`,
  `selectedID`, `onSelectSession`, `onCreateTerminal(projectID)`,
  `onCreateAgent(projectID)`, and `onAddProject`.
- It produces project sections, empty project headers, terminal/agent rows, and
  no split checkboxes or Inbox dashboard button.

- [ ] **Step 1: Write failing component tests**

```tsx
test("renders persisted projects including an empty project", () => {
    render(<ProjectSidebar {...props} projects={[project, emptyProject]} />);
    expect(screen.getByRole("heading", { name: project.path })).toBeVisible();
    expect(screen.getByRole("heading", { name: emptyProject.path })).toBeVisible();
});

test("renders unread purpose, latest status, and required action", () => {
    render(<ProjectSidebar {...props} />);
    const row = screen.getByRole("button", { name: /Select Codex.*Approve the pending change/i });
    expect(row).toHaveAttribute("data-unread", "true");
    expect(row).toHaveTextContent("Updating the API");
    expect(row).toHaveTextContent("Approve the pending change");
});

test("starts terminal or agent work only through project callbacks", async () => {
    const user = userEvent.setup();
    render(<ProjectSidebar {...props} />);
    await user.click(screen.getByRole("button", { name: `Create terminal in ${project.path}` }));
    await user.click(screen.getByRole("button", { name: `Start agent in ${project.path}` }));
    expect(props.onCreateTerminal).toHaveBeenCalledWith(project.id);
    expect(props.onCreateAgent).toHaveBeenCalledWith(project.id);
});
```

- [ ] **Step 2: Run the component test to verify it fails**

Run: `npm test -- src/components/ProjectSidebar.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the component and navigation integration**

Group sessions by `ProjectID`. Render a separate bounded `Unassigned` group for
legacy rows, project headers with terminal/agent controls, and rows whose
summary lookup is by terminal ID. Use one focusable button per row; delete is a
separate sibling action. Keep mobile drawer closing on single selection.

- [ ] **Step 4: Update navigation tests and run them**

Run: `npm test -- src/components/ProjectSidebar.test.tsx src/components/SessionNavigation.test.tsx`

Expected: PASS after replacing assertions that explicitly require Inbox/Done
tabs or `Include … in split` checkboxes.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ProjectSidebar.tsx web/src/components/ProjectSidebar.test.tsx web/src/components/SessionNavigation.tsx web/src/components/SessionNavigation.test.tsx
git commit -m "feat: render inbox inside project sidebar"
```

### Task 5: Integrate project terminal/agent creation and remove the Inbox pane

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/src/styles.test.ts`

**Interfaces:**
- `createTerminalInProject(projectID)` calls `createTerminal` with that ID.
- `createAgentInProject(projectID, kind)` creates a project-linked terminal,
  then starts the requested provider through `ApiClient.startAgent`.
- Agent row selection calls the existing read endpoint and single terminal
  selection path.

- [ ] **Step 1: Write failing App/style tests**

```tsx
test("opens an agent row as a terminal and marks its summary read", async () => {
    mockProjects([project]);
    mockSessions([agentSession]);
    mockSummaries([unreadSummary]);
    render(<App initialToken="valid-token" syncEvents={false} />);
    await userEvent.setup().click(await screen.findByRole("button", { name: /Select Codex/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
        "/api/agent-summaries/agent-1/read",
        expect.objectContaining({ method: "POST" }),
    ));
});

test("creates and starts an agent in the chosen project", async () => {
    // Mock project terminal creation and /api/v1/agents/created/start.
    render(<App initialToken="valid-token" syncEvents={false} />);
    await userEvent.setup().click(screen.getByRole("button", { name: `Start agent in ${project.path}` }));
    await userEvent.setup().click(screen.getByRole("button", { name: "Start Codex agent" }));
    expect(fetch).toHaveBeenCalledWith(
        "/api/v1/agents/created/start",
        expect.objectContaining({ method: "POST" }),
    );
});
```

```typescript
test("defines project sidebar unread and action selectors", () => {
    expect(stylesheet).toContain(".project-sidebar");
    expect(stylesheet).toContain(".project-session-row[data-unread=\"true\"]");
    expect(stylesheet).toContain(".project-create-agent");
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `npm test -- src/App.test.tsx src/styles.test.ts -t "agent row|chosen project|project sidebar"`

Expected: FAIL because the sidebar is not wired into App and the new selectors do not exist.

- [ ] **Step 3: Implement project-scoped creation**

Add the agent provider dialog with Codex/Claude choices. On terminal creation,
apply the returned selection and append the project-linked session. On agent
creation, leave the created terminal visible if start fails and surface the
error. A row click calls `markAgentSummaryRead` and then the normal single
terminal selection path.

- [ ] **Step 4: Remove normal Inbox/Done dashboard rendering**

Stop exposing the Agents pane and `/inbox` route in normal navigation. Keep
summary fetching, revision guards, backend Done endpoints, and the standalone
`AgentsView` module only as dead-code compatibility until its tests are
retired. Retain Tasks and internal selection machinery.

- [ ] **Step 5: Add CSS and run focused tests**

Use the existing black theme, hairline dividers, amber action rail, focus
outlines, 44px mobile action hit targets, and reduced-motion rules. Run:

`npm test -- src/App.test.tsx src/styles.test.ts -t "agent row|chosen project|project sidebar"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/App.tsx web/src/App.test.tsx web/src/styles.css web/src/styles.test.ts
git commit -m "feat: launch project work from sidebar"
```

### Task 6: Verify, review, and merge

**Files:**
- Modify: `web/e2e/euphony.spec.ts` only for assertions that describe removed
  Inbox/Done pages or split checkboxes.

- [ ] **Step 1: Run Go tests**

Run: `go test ./...`

Expected: PASS with no project migration, endpoint, or terminal-link failures.

- [ ] **Step 2: Run Web tests, typecheck, and build**

Run: `cd web && npm test && npm run typecheck && npm run build`

Expected: all commands exit 0.

- [ ] **Step 3: Run Playwright with an isolated backend**

Run the existing isolated test server flow from `scripts/dev_test.sh`, then:
`cd web && npm run e2e -- e2e/euphony.spec.ts`

Expected: project creation precedes terminal creation, project headers show
both actions, agent rows render Inbox signals, and no standalone Inbox pane or
Done tab is mounted.

- [ ] **Step 4: Inspect final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors, no generated artifacts/test databases, and only intended source/tests/docs changes.

- [ ] **Step 5: Commit and merge**

```bash
git add internal web/src web/e2e docs/superpowers
git commit -m "feat: add project-first inbox sidebar"
git switch main
git merge --ff-only feat/inbox-sidebar
```
