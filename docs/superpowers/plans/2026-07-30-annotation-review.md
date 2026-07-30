# Annotation Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a terminal agent run `euphony annotate FILE`, collect text-selection and global comments in a third pane-local tab, and receive those comments as JSON when the user submits.

**Architecture:** A concurrency-safe in-memory annotation store owns transient review sessions and blocking waiters. New v1 handlers and client methods connect the CLI and browser to that store, while existing API events trigger pane-local discovery and automatic tab selection. A focused React annotation view safely renders Markdown or sanitized HTML and builds structured comments.

**Tech Stack:** Go 1.24, `net/http`, existing v1 JSON envelopes and event hub, React 19, TypeScript, shadcn tabs/buttons/textarea, `react-markdown`, `remark-gfm`, DOMPurify, Vitest, Playwright.

## Global Constraints

- Work only in `tmp/worktrees/annotate` until the verified branch is merged.
- Only one active annotation may exist per terminal.
- Annotation document content is UTF-8 and no larger than 1 MiB.
- The API accepts document content and a display filename, never a filesystem path.
- Markdown raw HTML and active HTML content must not execute.
- Keep Terminal and Agent log mounted while Annotation is visible.
- End-to-end servers use an isolated SQLite database and state-mutating tests run with one worker.
- CLI stdout contains only the final stable JSON envelope.

---

### Task 1: Add the transient annotation domain

**Files:**
- Create: `internal/annotation/store.go`
- Create: `internal/annotation/store_test.go`

**Interfaces:**
- Produces:

```go
type Format string
const (
    FormatMarkdown Format = "markdown"
    FormatHTML Format = "html"
)

type Session struct {
    ID string `json:"id"`
    TerminalID string `json:"terminalId"`
    Filename string `json:"filename"`
    Format Format `json:"format"`
    Content string `json:"content"`
    CreatedAt time.Time `json:"createdAt"`
}

type Comment struct {
    Kind string `json:"kind"`
    Body string `json:"body"`
    Quote string `json:"quote,omitempty"`
    StartOffset *int `json:"startOffset,omitempty"`
    EndOffset *int `json:"endOffset,omitempty"`
}

type Result struct {
    AnnotationID string `json:"annotationId"`
    Comments []Comment `json:"comments"`
}

func NewStore(now func() time.Time, newID func() string) *Store
func (s *Store) Create(terminalID, filename string, format Format, content string) (Session, error)
func (s *Store) Current(terminalID string) (Session, bool)
func (s *Store) Wait(ctx context.Context, id string) (Result, error)
func (s *Store) Complete(id string, comments []Comment) (Result, Session, error)
func (s *Store) Cancel(id string) (Session, error)
```

- Typed sentinels: `ErrActive`, `ErrNotFound`, `ErrCanceled`.

- [ ] **Step 1: Write failing store tests**

Add tests that create a deterministic session, reject a second session for the
same terminal, allow independent terminals, block `Wait` until `Complete`,
return copied immutable comment slices, wake a canceled waiter with
`ErrCanceled`, reject duplicate completion, and return `context.Canceled`
when the wait context ends.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
go test ./internal/annotation
```

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement the minimal concurrency-safe store**

Use one `sync.Mutex`, maps by annotation ID and terminal ID, and a buffered
one-result channel per session. Never send while holding the mutex. Clone
sessions and comments at public boundaries.

- [ ] **Step 4: Re-run focused tests**

Run:

```bash
go test ./internal/annotation
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/annotation
git commit -m "feat: add transient annotation sessions"
```

### Task 2: Expose annotation sessions through the v1 API

**Files:**
- Create: `internal/server/v1_annotation.go`
- Create: `internal/server/v1_annotation_test.go`
- Modify: `internal/server/server.go`
- Modify: `internal/control/service.go`
- Modify: `internal/server/openapi.json`

**Interfaces:**
- Consumes the Task 1 store.
- Produces:

```go
func (s *Service) Publish(eventType string, data any) Event
```

- Produces the five endpoints from the design.

- [ ] **Step 1: Write failing handler tests**

Build a test server and assert:

```text
POST /api/v1/annotations
  404 terminal_not_found for an unknown terminal
  400 invalid_request for invalid format/content/filename
  201 for a valid request
  409 annotation_active for the same terminal
GET /api/v1/terminals/{id}/annotation
  200 with annotation:null before creation
  200 with the created session after creation
POST /api/v1/annotations/{id}/complete
  400 invalid_request for malformed comments
  200 with the ordered result for valid comments
DELETE /api/v1/annotations/{id}
  200 for an active review and 404 afterward
```

Subscribe to events before mutations and assert
`annotation.created`, `annotation.completed`, and `annotation.canceled`
contain only `id` and `terminalId`.

- [ ] **Step 2: Run server tests and verify route failures**

Run:

```bash
go test ./internal/server
```

Expected: FAIL because annotation routes are not registered.

- [ ] **Step 3: Implement handlers and event publication**

Add `annotations *annotation.Store` to `Server`, initialize it with
`time.Now` and UUID generation, validate requests before store calls, and map
typed store errors to stable v1 error codes. Add `Service.Publish` as the
single public gateway to the existing event hub.

- [ ] **Step 4: Document the endpoint schemas**

Add annotation schemas, paths, response envelopes, and event enum values to
`internal/server/openapi.json`. Verify it remains valid JSON:

```bash
go test ./internal/server -run TestV1Schema
```

- [ ] **Step 5: Re-run focused tests**

Run:

```bash
go test ./internal/control ./internal/server
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/annotation internal/control/service.go internal/server
git commit -m "feat: expose annotation review api"
```

### Task 3: Add API client and blocking annotate CLI

**Files:**
- Modify: `internal/apiclient/client.go`
- Modify: `internal/apiclient/client_test.go`
- Modify: `cmd/euphony/cli.go`
- Modify: `cmd/euphony/cli_test.go`
- Modify: `cmd/euphony/main.go`
- Modify: `cmd/euphony/main_test.go`
- Modify: `docs/automation.md`
- Modify: `README.md`

**Interfaces:**
- Produces:

```go
type CreateAnnotationRequest struct {
    TerminalID string `json:"terminalId"`
    Filename string `json:"filename"`
    Format annotation.Format `json:"format"`
    Content string `json:"content"`
}
func (c *Client) CreateAnnotation(context.Context, CreateAnnotationRequest) (annotation.Session, error)
func (c *Client) CurrentAnnotation(context.Context, string) (*annotation.Session, error)
func (c *Client) WaitAnnotation(context.Context, string) (annotation.Result, error)
func (c *Client) CompleteAnnotation(context.Context, string, []annotation.Comment) (annotation.Result, error)
func (c *Client) CancelAnnotation(context.Context, string) error
```

- Produces `runAnnotate(ctx, args, stdout, stderr)` and
`inferAnnotationFormat(path string) (annotation.Format, error)`.

- [ ] **Step 1: Write failing client and CLI tests**

Use `httptest.Server` to verify every client method and a completion test whose
wait response is released after create. CLI assertions:

```text
missing FILE -> usage error
missing EUPHONY_TERMINAL_ID -> invalid request
.txt -> invalid request without an API call
invalid UTF-8 -> invalid request
>1 MiB -> invalid request
.md and .html -> correct format, basename, content, and terminal ID
completion -> stdout contains absolute path and ordered comments
context cancellation -> DELETE is attempted
```

- [ ] **Step 2: Run focused tests and verify missing behavior**

Run:

```bash
go test ./internal/apiclient ./cmd/euphony
```

Expected: FAIL for undefined annotation methods and command.

- [ ] **Step 3: Implement client and CLI**

Thread a signal-aware context from `run` into annotate, read with
`io.LimitReader(max+1)`, validate `utf8.Valid`, use `filepath.Abs`, and print
through `writeCLISuccess`. Cancel using a fresh two-second context so cleanup
is not skipped after the wait context is canceled.

- [ ] **Step 4: Update English user documentation**

Document the command, supported formats, required terminal environment,
blocking behavior, JSON shape, and explicit no-comment approval.

- [ ] **Step 5: Verify both HTTP and Unix-socket API paths**

Run:

```bash
go test ./internal/apiclient ./cmd/euphony ./internal/localapi
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cmd/euphony internal/apiclient docs/automation.md README.md
git commit -m "feat: add blocking annotate command"
```

### Task 4: Install the agent annotation skill

**Files:**
- Create: `internal/setup/skills/euphony-annotate/SKILL.md`
- Modify: `internal/setup/setup.go`
- Modify: `internal/setup/setup_test.go`
- Modify: `cmd/euphony/main_test.go`

**Interfaces:**
- Embeds the English skill with `//go:embed skills/euphony-annotate/SKILL.md`.
- Installs the file at `<agent-config>/skills/euphony-annotate/SKILL.md`.

- [ ] **Step 1: Write failing setup tests**

Extend the temporary Codex/Claude homes and assert both skill files:

- exist after setup;
- exactly match the embedded asset;
- remain unchanged after the second setup;
- preserve existing neighboring skills and settings.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
go test ./internal/setup ./cmd/euphony
```

Expected: FAIL because setup installs hooks only.

- [ ] **Step 3: Write the English skill**

The skill frontmatter name is `euphony-annotate`. Its instructions require:

```text
Use `euphony annotate <path>` for user review of a generated Markdown or HTML
artifact when running inside Euphony. Wait for the command. Parse the stable
JSON result, locate selection comments by quote first and offsets second,
apply relevant feedback, and treat an empty comments array as explicit
approval. Do not background the command.
```

- [ ] **Step 4: Embed and atomically install the skill**

Reuse `writeAtomic`, create skill directories with mode `0700`, and write the
file with mode `0600`. Report skill installation as part of the existing
agent setup result without adding interactive prompts.

- [ ] **Step 5: Re-run setup tests**

Run:

```bash
go test ./internal/setup ./cmd/euphony
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/setup cmd/euphony/main_test.go
git commit -m "feat: install annotation review skill"
```

### Task 5: Add browser annotation discovery and the third pane tab

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/api.test.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/TerminalPane.tsx`
- Modify: `web/src/components/TerminalPane.test.tsx`

**Interfaces:**
- Produces `AnnotationSession`, `AnnotationComment`, and `AnnotationResult`
  TypeScript types mirroring Go.
- Produces `ApiClient.getCurrentAnnotation()` and
  `ApiClient.completeAnnotation()`.
- Adds `annotationRevision: number` to `TerminalPane`.

- [ ] **Step 1: Write failing browser API and pane tests**

Assert v1 request paths and bodies. For `TerminalPane`, assert:

- initial current-annotation fetch;
- no third tab for `null`;
- a new annotation appears and becomes active after revision changes;
- terminal and Agent log remain mounted;
- completing removes the tab and returns to Terminal;
- a failed discovery does not hide an already-loaded annotation.

- [ ] **Step 2: Run focused tests and verify failures**

Run:

```bash
cd web
npm test -- --run src/api.test.ts src/components/TerminalPane.test.tsx
```

Expected: FAIL for missing types, methods, and third tab.

- [ ] **Step 3: Implement event-to-pane synchronization**

In `App`, increment one revision for created/completed/canceled annotation
events without refreshing terminal sessions. Pass it to every pane. In
`TerminalPane`, fetch on mount/revision, ignore stale responses with an effect
cleanup flag, auto-select unseen IDs, and preserve the existing keyboard tab
cycle as Terminal → Agent log → Annotation → Terminal when Annotation exists.

- [ ] **Step 4: Re-run focused tests and typecheck**

Run:

```bash
cd web
npm test -- --run src/api.test.ts src/components/TerminalPane.test.tsx src/App.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat: add annotation pane source"
```

### Task 6: Build the annotation reader and comment composer

**Files:**
- Create: `web/src/components/AnnotationView.tsx`
- Create: `web/src/components/AnnotationView.test.tsx`
- Create: `web/src/annotationSelection.ts`
- Create: `web/src/annotationSelection.test.ts`
- Modify: `web/src/components/TerminalPane.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`

**Interfaces:**
- Produces:

```ts
export function selectionAnchor(
  root: HTMLElement,
  selection: Selection,
): { quote: string; startOffset: number; endOffset: number } | null;
```

- Produces:

```ts
interface AnnotationViewProps {
  annotation: AnnotationSession;
  api: ApiClient;
  onCompleted(): void;
}
```

- [ ] **Step 1: Write failing selection and component tests**

Cover selections spanning nested elements, reversed selections, whitespace
normalization without offset corruption, and selections outside the document.
Component tests assert:

- GFM headings, tables, links, and code render semantically;
- Markdown raw HTML stays inert;
- HTML scripts, event handlers, forms, iframes, inline style, and `javascript:`
  links are removed;
- selection opens the quoted comment editor;
- selection and global comments can be added and removed;
- empty comment bodies cannot be added;
- Send comments allows an empty array;
- failed submit retains comments and exposes retry;
- successful submit calls `onCompleted`.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
cd web
npm test -- --run src/annotationSelection.test.ts src/components/AnnotationView.test.tsx
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Add DOMPurify**

Run:

```bash
cd web
npm install dompurify
```

- [ ] **Step 4: Implement selection anchoring and safe rendering**

Use DOM `Range` objects measured from the document root. Render Markdown
without `rehypeRaw`. Sanitize HTML with explicit forbidden tags and
attributes, then post-process links to set `target="_blank"` and
`rel="noopener noreferrer"`.

- [ ] **Step 5: Implement the comment rail and responsive styling**

Use existing shadcn `Button` and `Textarea`. Keep one selection draft and one
global draft, render saved comments in order, show amber quote markers, and
disable mutations while submitting. Add a `@container` breakpoint at 720px
for side-by-side versus stacked layout.

- [ ] **Step 6: Re-run all web tests and typecheck**

Run:

```bash
cd web
npm test -- --run
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web
git commit -m "feat: add annotation comment interface"
```

### Task 7: Verify the public workflow end to end

**Files:**
- Create: `web/e2e/annotation.spec.ts`
- Modify: `web/playwright.config.ts` only if the isolated fixture needs
  environment wiring.
- Modify: `AGENTS.md` only if implementation feedback reveals a reusable
  workflow rule.

**Interfaces:**
- Exercises the built CLI through the public TCP and Unix-socket API.

- [ ] **Step 1: Write the failing Playwright scenario**

Start Euphony with a temporary `EUPHONY_DB`, token, socket runtime directory,
and dedicated port. Create a terminal, run a shell command that invokes the
built binary:

```bash
euphony annotate /fixture/review.md
```

In the browser, assert the third tab auto-selects, select visible text, add a
selection comment, add a global comment, submit, then read terminal output and
assert the stable JSON contains both comments and the absolute fixture path.
Run state-mutating steps serially.

- [ ] **Step 2: Run Playwright and verify the scenario**

Run:

```bash
make build
cd web
npx playwright test e2e/annotation.spec.ts --workers=1
```

Expected: PASS after the feature implementation.

- [ ] **Step 3: Exercise the same API over the Unix socket**

Run the focused Go transport test that creates, waits, completes, and consumes
an annotation using `apiclient.Config{SocketPath: ...}`.

```bash
go test ./internal/apiclient ./internal/localapi -run Annotation
```

Expected: PASS.

- [ ] **Step 4: Run the full verification suite**

Run:

```bash
go test ./...
cd web
npm test -- --run
npm run typecheck
npm run build
npx playwright test --workers=1
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit final verification changes**

```bash
git add web/e2e web/playwright.config.ts AGENTS.md
git commit -m "test: verify annotation workflow end to end"
```

- [ ] **Step 6: Merge the verified branch**

From the base checkout:

```bash
git merge --no-ff codex/annotate -m "merge: annotation review workflow"
```

Then run `go test ./...` and `npm test -- --run` from the merged base checkout.
