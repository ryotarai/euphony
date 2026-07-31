# Startup Agent Setup Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offer interactive installation when Euphony's coding-agent hooks or bundled skill need setup, and permanently suppress the offer after a decline.

**Architecture:** Add a read-only `setup.Inspect` operation that compares supported agents' installed hooks, Codex feature flag, and bundled skill with the current executable. Call a focused startup prompt helper before the server starts only when stdin is a terminal; reuse `setup.Install` after acceptance and persist decline state under the Euphony user data directory.

**Tech Stack:** Go 1.24, standard library JSON/file APIs, `github.com/mattn/go-isatty`, Go tests.

## Global Constraints

- The prompt and all CLI output added by this feature are English.
- The exact prompt suffix is `(Y/n)`, with Enter selecting yes.
- A `no` response permanently suppresses later startup prompts.
- The decline message names `euphony setup` as the manual installation path.
- Both startup prompting and explicit setup explain the hook purpose, skill
  purpose, and preservation of existing agent settings before installation.
- Non-interactive server launches never block for input.
- Inspection or optional setup failures do not prevent the server from starting.

---

### Task 1: Read-only agent setup inspection

**Files:**
- Modify: `internal/setup/setup.go`
- Modify: `internal/setup/setup_test.go`

**Interfaces:**
- Consumes: `setup.Config`, the existing embedded `annotationSkill`, `agentHooks`, `readJSONObject`, `containsCommand`, and `findExecutable`.
- Produces: `type Status struct { NeedsSetup []string }` and `func Inspect(Config) (Status, error)`.

- [ ] **Step 1: Write failing inspection tests**

Add tests that create executable `codex` and `claude` fixtures and assert:

```go
status, err := Inspect(config)
if err != nil {
    t.Fatalf("Inspect() error = %v", err)
}
if got := strings.Join(status.NeedsSetup, ","); got != "codex,claude" {
    t.Fatalf("NeedsSetup = %q, want codex,claude", got)
}
```

After `Install(config)`, assert `NeedsSetup` is empty. Replace one installed
skill with `outdated\n`, assert only that agent is reported, and verify the
inspection did not rewrite the skill.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
go test ./internal/setup -run 'TestInspect' -count=1
```

Expected: compilation fails because `Inspect` and `Status` do not exist.

- [ ] **Step 3: Implement the minimum read-only inspection**

Implement:

```go
type Status struct {
    NeedsSetup []string
}

func Inspect(config Config) (Status, error)
```

For each supported agent on `PATH`, resolve its config directory, parse its
hook JSON, require the exact current executable command for every event, check
Codex's `[features]` section for `hooks = true`, and compare the skill bytes
with `annotationSkill`. Return agents in stable `codex`, `claude` order. Do not
write any file.

- [ ] **Step 4: Run setup tests and verify GREEN**

Run:

```bash
go test ./internal/setup -count=1
```

Expected: all setup package tests pass.

- [ ] **Step 5: Commit the inspection**

```bash
git add internal/setup/setup.go internal/setup/setup_test.go
git commit -m "feat(setup): inspect agent integration state"
```

### Task 2: Interactive startup offer and persistent decline

**Files:**
- Modify: `cmd/euphony/main.go`
- Modify: `cmd/euphony/main_test.go`
- Modify: `go.mod`
- Modify: `go.sum`
- Modify: `README.md`

**Interfaces:**
- Consumes: `setup.Inspect(Config)`, `setup.Install(Config)`, the process home, agent config environment variables, current executable, and `PATH`.
- Produces: `func maybeOfferAgentSetup(setup.Config, io.Reader, io.Writer) error`, `func setupPromptDeclinedPath(string) string`, and terminal-only invocation from `runServer`.

- [ ] **Step 1: Write failing prompt-flow tests**

Create table-oriented tests using temporary homes and real setup fixtures:

```go
err := maybeOfferAgentSetup(config, strings.NewReader("n\n"), &output)
if err != nil {
    t.Fatalf("maybeOfferAgentSetup() error = %v", err)
}
if !strings.Contains(output.String(), "Install them now? (Y/n)") ||
    !strings.Contains(output.String(), "Run 'euphony setup'") {
    t.Fatalf("output = %q", output.String())
}
```

Assert the decline marker exists, a second call produces no output, Enter
installs the expected skill, `yes` is accepted, and invalid input emits
`Please answer y or n.` before asking again.

Add a `runSetup` test with isolated `HOME`, `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, and `PATH` values. Assert it explains the hook and skill,
states that existing settings are preserved, and only then reports successful
installation.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
go test ./cmd/euphony -run 'TestMaybeOfferAgentSetup|TestSetupPromptDeclinedPath' -count=1
```

Expected: compilation fails because the prompt helpers do not exist.

- [ ] **Step 3: Implement prompt, persistence, and terminal gating**

Implement `maybeOfferAgentSetup` so it:

1. returns silently when the decline marker exists;
2. calls `setup.Inspect` and returns silently when no agent needs setup;
3. explains that hooks report status/session metadata, the skill lets agents
   ask the user to annotate Markdown/HTML, and existing settings are preserved;
4. prints `Euphony hooks or skills are missing or outdated. Install them now? (Y/n) `;
5. treats Enter, `y`, and `yes` as acceptance and calls `setup.Install`;
6. treats `n` and `no` as decline, writes a `0600` marker below a `0700`
   directory, and prints
   `Skipped. Run 'euphony setup' to install hooks and skills later.`;
7. retries other responses after printing `Please answer y or n.`.

Use `github.com/mattn/go-isatty` to invoke this helper only when the default
server command's stdin is an actual terminal. Log helper errors and continue
server startup. Change explicit setup success output to
`Installed <agent> hooks and skills.`, and print the same explanation before
explicit setup starts.

- [ ] **Step 4: Document startup behavior**

Update the README coding-agent setup section to explain the automatic
interactive offer, persistent `n` choice, and `euphony setup` manual fallback.

- [ ] **Step 5: Run focused and package tests and verify GREEN**

Run:

```bash
go test ./cmd/euphony ./internal/setup -count=1
```

Expected: both packages pass.

- [ ] **Step 6: Run formatting and dependency normalization**

Run:

```bash
gofmt -w cmd/euphony/main.go cmd/euphony/main_test.go internal/setup/setup.go internal/setup/setup_test.go
go mod tidy
```

Then rerun:

```bash
go test ./cmd/euphony ./internal/setup -count=1
```

Expected: both packages still pass.

- [ ] **Step 7: Commit the startup interaction**

```bash
git add cmd/euphony/main.go cmd/euphony/main_test.go internal/setup/setup.go internal/setup/setup_test.go go.mod go.sum README.md docs/superpowers/plans/2026-07-31-startup-agent-setup-prompt.md
git commit -m "feat: offer agent setup on startup"
```

### Task 3: Full verification and integration

**Files:**
- Verify all committed files from Tasks 1 and 2.

**Interfaces:**
- Consumes: the complete startup setup feature.
- Produces: a verified branch ready to merge into the base branch.

- [ ] **Step 1: Verify formatting and diff hygiene**

Run:

```bash
test -z "$(gofmt -l cmd/euphony internal/setup)"
git diff --check HEAD^
```

Expected: both commands exit successfully with no output.

- [ ] **Step 2: Run the complete Go suite**

Run:

```bash
go test ./... -count=1
```

Expected: every package passes.

- [ ] **Step 3: Build the Euphony binary**

Run:

```bash
go build ./cmd/euphony
```

Expected: build exits successfully.

- [ ] **Step 4: Review requirements against the final diff**

Confirm that the final diff contains the exact English prompt and decline
message, persistent suppression, terminal gating, read-only current/outdated
detection, manual setup documentation, and non-fatal startup error handling.
