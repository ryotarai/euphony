import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { ApiError, type ApiClient } from "../api";
import type { GitChangesSnapshot, Session } from "../types";
import { GitChangesView } from "./GitChangesView";

afterEach(() => {
  vi.useRealTimers();
});

const session: Session = {
  id: "terminal-1",
  name: "Terminal one",
  state: "running",
  cwd: "/repo",
  repoRoot: "/repo",
  createdAt: "2026-07-31T00:00:00Z",
};

const summary: GitChangesSnapshot = {
  repoRoot: "/repo",
  branch: "main",
  upstream: "origin/main",
  ahead: 2,
  behind: 1,
  additions: 3,
  deletions: 1,
  files: [
    {
      path: "src/app.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      hunks: [],
    },
    {
      path: "draft file.md",
      status: "untracked",
      additions: 1,
      deletions: 0,
      hunks: [],
    },
  ],
};

function detailed(path: string): GitChangesSnapshot {
  return {
    ...summary,
    files: summary.files.map((file) =>
      file.path === path
        ? {
            ...file,
            patchLoaded: true,
            hunks: [{
              header: path === "src/app.ts" ? "@@ -1 +1 @@" : "@@ -0,0 +1 @@",
              oldStart: 1,
              newStart: 1,
              lines: path === "src/app.ts"
                ? [
                    {
                      kind: "deletion",
                      oldLine: 1,
                      content: "const state = 'before';",
                    },
                    {
                      kind: "addition",
                      newLine: 1,
                      content: "const state = 'after';",
                    },
                  ]
                : [{
                    kind: "addition",
                    newLine: 1,
                    content: "# Draft",
                  }],
            }],
          }
        : file,
    ),
  };
}

function changesAPI(
  implementation: (path?: string) => Promise<GitChangesSnapshot>,
): ApiClient {
  return {
    getGitChanges: vi.fn((_id: string, path?: string) => implementation(path)),
  } as unknown as ApiClient;
}

test("loads only while active and renders the selected diff through Pierre", async () => {
  const api = changesAPI(async (path) => path ? detailed(path) : summary);
  const { rerender } = render(
    <GitChangesView session={session} api={api} active={false} />,
  );

  expect(api.getGitChanges).not.toHaveBeenCalled();

  rerender(<GitChangesView session={session} api={api} active />);

  expect(await screen.findByRole("button", { name: /src\/app\.ts/ }))
    .toHaveAttribute("aria-current", "true");
  await waitFor(() => {
    const diff = screen
      .getByLabelText("Diff for src/app.ts")
      .querySelector("diffs-container");
    expect(diff).toBeInTheDocument();
    expect(diff?.shadowRoot?.textContent).toContain("const state = 'after';");
  });
  expect(screen.getByText("main")).toBeVisible();
  expect(screen.getByText("origin/main")).toBeVisible();
  expect(screen.getByLabelText("2 commits ahead, 1 commit behind")).toBeVisible();
});

test("selects another changed file and retains it on refresh", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const api = changesAPI(async (path) => path ? detailed(path) : summary);
  render(<GitChangesView session={session} api={api} active />);

  const draft = await screen.findByRole("button", { name: /draft file\.md/ });
  await user.click(draft);
  await waitFor(() => {
    const diff = screen
      .getByLabelText("Diff for draft file.md")
      .querySelector("diffs-container");
    expect(diff?.shadowRoot?.textContent).toContain("# Draft");
  });
  expect(draft).toHaveAttribute("aria-current", "true");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });

  expect(draft).toHaveAttribute("aria-current", "true");
  expect(api.getGitChanges).toHaveBeenLastCalledWith(
    "terminal-1",
    "draft file.md",
  );
  vi.useRealTimers();
});

test("shows clean and non-repository guidance", async () => {
  const cleanAPI = changesAPI(async () => ({ ...summary, additions: 0, deletions: 0, files: [] }));
  const { rerender } = render(
    <GitChangesView session={session} api={cleanAPI} active />,
  );
  expect(await screen.findByText("No local changes")).toBeVisible();

  const plainAPI = changesAPI(async () => {
    throw new ApiError(
      404,
      "git_repository_not_found",
      "This terminal is not inside a Git worktree.",
    );
  });
  rerender(<GitChangesView session={session} api={plainAPI} active />);
  expect(await screen.findByText("No Git repository")).toBeVisible();
  expect(screen.getByText(/Start this terminal inside a Git worktree/)).toBeVisible();
});

test("does not overlap slow refresh requests", async () => {
  vi.useFakeTimers();
  let resolveRequest: ((snapshot: GitChangesSnapshot) => void) | undefined;
  const api = changesAPI(() => new Promise((resolve) => {
    resolveRequest = resolve;
  }));
  render(<GitChangesView session={session} api={api} active />);

  expect(api.getGitChanges).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(6_000);
  });
  expect(api.getGitChanges).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveRequest?.({ ...summary, additions: 0, deletions: 0, files: [] });
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_999);
  });
  expect(api.getGitChanges).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(api.getGitChanges).toHaveBeenCalledTimes(2);
});

test("distinguishes loaded empty patches and partial totals", async () => {
  const partial: GitChangesSnapshot = {
    ...summary,
    truncated: true,
    statsTruncated: true,
    files: [{
      path: "empty.txt",
      status: "untracked",
      additions: 0,
      deletions: 0,
      patchLoaded: true,
      hunks: [],
    }],
  };
  const api = changesAPI(async () => partial);
  render(<GitChangesView session={session} api={api} active />);

  expect(await screen.findByText("No textual changes.")).toBeVisible();
  expect(screen.getByText("1+ files")).toBeVisible();
  expect(screen.getByText("≥+3")).toBeVisible();
  expect(screen.getByText("≥−1")).toBeVisible();
});
