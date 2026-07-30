import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import type { ApiClient } from "../api";
import type {
  Session,
  WorkspaceDirectory,
  WorkspaceFile,
  WorkspaceSearchResult,
} from "../types";
import { WorkspaceFilesView } from "./WorkspaceFilesView";

const session: Session = {
  id: "terminal-1",
  name: "Terminal one",
  state: "running",
  cwd: "/repo",
  createdAt: "2026-07-31T00:00:00Z",
};

const rootDirectory: WorkspaceDirectory = {
  root: "/repo",
  path: "",
  entries: [
    { name: "docs", path: "docs", kind: "directory" },
    { name: "README.md", path: "README.md", kind: "file", size: 7 },
  ],
};

function filesAPI(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    getWorkspaceDirectory: vi.fn().mockResolvedValue(rootDirectory),
    searchWorkspace: vi.fn().mockResolvedValue({
      root: "/repo",
      query: "",
      matches: [],
    }),
    getWorkspaceFile: vi.fn().mockResolvedValue({
      root: "/repo",
      name: "README.md",
      path: "README.md",
      size: 7,
      content: "# Read\n",
    }),
    ...overrides,
  } as unknown as ApiClient;
}

test("loads the workspace only while active and shows its root", async () => {
  const getWorkspaceDirectory = vi.fn().mockResolvedValue(rootDirectory);
  const api = filesAPI({ getWorkspaceDirectory });
  const { rerender } = render(
    <WorkspaceFilesView session={session} api={api} active={false} />,
  );

  expect(getWorkspaceDirectory).not.toHaveBeenCalled();

  rerender(<WorkspaceFilesView session={session} api={api} active />);

  expect(await screen.findByRole("navigation", {
    name: "Workspace files",
  })).toBeVisible();
  expect(screen.getByText("/repo")).toBeVisible();
  expect(getWorkspaceDirectory).toHaveBeenCalledWith("terminal-1");
  expect(screen.getByRole("button", { name: "Expand docs" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Open README.md" })).toBeVisible();
  expect(screen.getByText("Open a file")).toBeVisible();
});

test("expands directories and renders a selected text file with line numbers", async () => {
  const user = userEvent.setup();
  const getWorkspaceDirectory = vi.fn()
    .mockResolvedValueOnce(rootDirectory)
    .mockResolvedValueOnce({
      root: "/repo",
      path: "docs",
      entries: [
        {
          name: "User Guide.md",
          path: "docs/User Guide.md",
          kind: "file",
          size: 13,
        },
      ],
    } satisfies WorkspaceDirectory);
  const getWorkspaceFile = vi.fn().mockResolvedValue({
    root: "/repo",
    name: "User Guide.md",
    path: "docs/User Guide.md",
    size: 13,
    content: "first\nsecond\n",
  } satisfies WorkspaceFile);
  render(
    <WorkspaceFilesView
      session={session}
      api={filesAPI({ getWorkspaceDirectory, getWorkspaceFile })}
      active
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Expand docs" }));
  await user.click(
    await screen.findByRole("button", { name: "Open docs/User Guide.md" }),
  );

  expect(getWorkspaceDirectory).toHaveBeenLastCalledWith("terminal-1", "docs");
  expect(getWorkspaceFile).toHaveBeenCalledWith(
    "terminal-1",
    "docs/User Guide.md",
  );
  expect(await screen.findByRole("heading", { name: "User Guide.md" })).toBeVisible();
  const source = screen.getByRole("table", {
    name: "Contents of docs/User Guide.md",
  });
  expect(source).toHaveTextContent("1first");
  expect(source).toHaveTextContent("2second");
});

test("searches the workspace and opens a matching file", async () => {
  const user = userEvent.setup();
  const searchResult: WorkspaceSearchResult = {
    root: "/repo",
    query: "guide",
    matches: [
      {
        name: "User Guide.md",
        path: "docs/User Guide.md",
        kind: "file",
        size: 13,
      },
    ],
  };
  const searchWorkspace = vi.fn().mockResolvedValue(searchResult);
  const getWorkspaceFile = vi.fn().mockResolvedValue({
    root: "/repo",
    name: "User Guide.md",
    path: "docs/User Guide.md",
    size: 13,
    content: "guide",
  } satisfies WorkspaceFile);
  render(
    <WorkspaceFilesView
      session={session}
      api={filesAPI({ searchWorkspace, getWorkspaceFile })}
      active
    />,
  );

  const search = await screen.findByRole("searchbox", {
    name: "Filter workspace files",
  });
  await user.type(search, "guide");

  await waitFor(() => {
    expect(searchWorkspace).toHaveBeenCalledWith("terminal-1", "guide");
  });
  await user.click(
    await screen.findByRole("button", {
      name: "Open search result docs/User Guide.md",
    }),
  );

  expect(await screen.findByRole("heading", { name: "User Guide.md" })).toBeVisible();
});

test("explains binary files and marks truncated text", async () => {
  const user = userEvent.setup();
  const getWorkspaceFile = vi.fn()
    .mockResolvedValueOnce({
      root: "/repo",
      name: "binary.dat",
      path: "binary.dat",
      size: 32,
      binary: true,
    } satisfies WorkspaceFile)
    .mockResolvedValueOnce({
      root: "/repo",
      name: "large.txt",
      path: "large.txt",
      size: 2_000_000,
      content: "prefix",
      truncated: true,
    } satisfies WorkspaceFile);
  const directory: WorkspaceDirectory = {
    root: "/repo",
    path: "",
    entries: [
      { name: "binary.dat", path: "binary.dat", kind: "file", size: 32 },
      { name: "large.txt", path: "large.txt", kind: "file", size: 2_000_000 },
    ],
  };
  render(
    <WorkspaceFilesView
      session={session}
      api={filesAPI({
        getWorkspaceDirectory: vi.fn().mockResolvedValue(directory),
        getWorkspaceFile,
      })}
      active
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Open binary.dat" }));
  expect(await screen.findByText("Binary file")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Open large.txt" }));
  expect(await screen.findByText("Only the first 1 MiB is shown.")).toBeVisible();
});

test("ignores a stale file response after another file is selected", async () => {
  const user = userEvent.setup();
  let resolveSlow: ((file: WorkspaceFile) => void) | undefined;
  const slow = new Promise<WorkspaceFile>((resolve) => {
    resolveSlow = resolve;
  });
  const getWorkspaceFile = vi.fn()
    .mockImplementationOnce(() => slow)
    .mockResolvedValueOnce({
      root: "/repo",
      name: "second.txt",
      path: "second.txt",
      size: 6,
      content: "second",
    } satisfies WorkspaceFile);
  const directory: WorkspaceDirectory = {
    root: "/repo",
    path: "",
    entries: [
      { name: "first.txt", path: "first.txt", kind: "file", size: 5 },
      { name: "second.txt", path: "second.txt", kind: "file", size: 6 },
    ],
  };
  render(
    <WorkspaceFilesView
      session={session}
      api={filesAPI({
        getWorkspaceDirectory: vi.fn().mockResolvedValue(directory),
        getWorkspaceFile,
      })}
      active
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Open first.txt" }));
  await user.click(screen.getByRole("button", { name: "Open second.txt" }));
  expect(await screen.findByRole("heading", { name: "second.txt" })).toBeVisible();

  resolveSlow?.({
    root: "/repo",
    name: "first.txt",
    path: "first.txt",
    size: 5,
    content: "first",
  });
  fireEvent.focus(window);

  await waitFor(() => {
    expect(screen.getByRole("heading", { name: "second.txt" })).toBeVisible();
  });
});

test("refresh invalidates child directories and reloads the selected file", async () => {
  const user = userEvent.setup();
  const child: WorkspaceDirectory = {
    root: "/repo",
    path: "docs",
    entries: [
      { name: "guide.md", path: "docs/guide.md", kind: "file", size: 5 },
    ],
  };
  const getWorkspaceDirectory = vi.fn()
    .mockResolvedValueOnce(rootDirectory)
    .mockResolvedValueOnce(child)
    .mockResolvedValueOnce(rootDirectory)
    .mockResolvedValueOnce(child);
  const getWorkspaceFile = vi.fn().mockResolvedValue({
    root: "/repo",
    name: "guide.md",
    path: "docs/guide.md",
    size: 5,
    content: "guide",
  } satisfies WorkspaceFile);
  render(
    <WorkspaceFilesView
      session={session}
      api={filesAPI({ getWorkspaceDirectory, getWorkspaceFile })}
      active
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Expand docs" }));
  await user.click(
    await screen.findByRole("button", { name: "Open docs/guide.md" }),
  );
  expect(await screen.findByRole("heading", { name: "guide.md" })).toBeVisible();

  await user.click(screen.getByRole("button", {
    name: "Refresh workspace files",
  }));

  await waitFor(() => {
    expect(getWorkspaceDirectory).toHaveBeenCalledTimes(3);
    expect(getWorkspaceFile).toHaveBeenCalledTimes(2);
  });
  expect(screen.queryByRole("button", { name: "Open docs/guide.md" }))
    .not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Expand docs" }));
  expect(await screen.findByRole("button", { name: "Open docs/guide.md" }))
    .toBeVisible();
  expect(getWorkspaceDirectory).toHaveBeenCalledTimes(4);
});

test("ignores a child directory response from before refresh", async () => {
  const user = userEvent.setup();
  let resolveStale: ((directory: WorkspaceDirectory) => void) | undefined;
  const stale = new Promise<WorkspaceDirectory>((resolve) => {
    resolveStale = resolve;
  });
  let childRequest = 0;
  const getWorkspaceDirectory = vi.fn(
    (_id: string, path?: string) => {
      if (!path) return Promise.resolve(rootDirectory);
      childRequest += 1;
      if (childRequest === 1) return stale;
      return Promise.resolve({
        root: "/repo",
        path: "docs",
        entries: [
          { name: "fresh.md", path: "docs/fresh.md", kind: "file" },
        ],
      } satisfies WorkspaceDirectory);
    },
  );
  render(
    <WorkspaceFilesView
      session={session}
      api={filesAPI({ getWorkspaceDirectory })}
      active
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Expand docs" }));
  await user.click(screen.getByRole("button", {
    name: "Refresh workspace files",
  }));
  resolveStale?.({
    root: "/repo",
    path: "docs",
    entries: [
      { name: "stale.md", path: "docs/stale.md", kind: "file" },
    ],
  });
  await waitFor(() => {
    expect(getWorkspaceDirectory).toHaveBeenCalledTimes(3);
  });

  expect(screen.queryByRole("button", { name: "Open docs/stale.md" }))
    .not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Expand docs" }));
  expect(await screen.findByRole("button", { name: "Open docs/fresh.md" }))
    .toBeVisible();
});

test("shows child directory empty and retry states", async () => {
  const user = userEvent.setup();
  const directory: WorkspaceDirectory = {
    root: "/repo",
    path: "",
    entries: [
      { name: "empty", path: "empty", kind: "directory" },
      { name: "unavailable", path: "unavailable", kind: "directory" },
    ],
  };
  const getWorkspaceDirectory = vi.fn()
    .mockResolvedValueOnce(directory)
    .mockResolvedValueOnce({
      root: "/repo",
      path: "empty",
      entries: [],
    } satisfies WorkspaceDirectory)
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({
      root: "/repo",
      path: "unavailable",
      entries: [
        { name: "ready.txt", path: "unavailable/ready.txt", kind: "file" },
      ],
    } satisfies WorkspaceDirectory);
  render(
    <WorkspaceFilesView
      session={session}
      api={filesAPI({ getWorkspaceDirectory })}
      active
    />,
  );

  await user.click(await screen.findByRole("button", { name: "Expand empty" }));
  expect(await screen.findByText("This directory is empty.")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "Expand unavailable" }));
  expect(await screen.findByText("Directory unavailable.")).toBeVisible();
  await user.click(screen.getByRole("button", {
    name: "Retry unavailable directory",
  }));
  expect(await screen.findByRole("button", {
    name: "Open unavailable/ready.txt",
  })).toBeVisible();
});

test("caps rendered code lines", async () => {
  const user = userEvent.setup();
  const directory: WorkspaceDirectory = {
    root: "/repo",
    path: "",
    entries: [
      { name: "many-lines.txt", path: "many-lines.txt", kind: "file" },
    ],
  };
  render(
    <WorkspaceFilesView
      session={session}
      api={filesAPI({
        getWorkspaceDirectory: vi.fn().mockResolvedValue(directory),
        getWorkspaceFile: vi.fn().mockResolvedValue({
          root: "/repo",
          name: "many-lines.txt",
          path: "many-lines.txt",
          size: 12_000,
          content: "x\n".repeat(6_000),
        } satisfies WorkspaceFile),
      })}
      active
    />,
  );

  await user.click(await screen.findByRole("button", {
    name: "Open many-lines.txt",
  }));

  expect(await screen.findByText("Only the first 5,000 lines are shown."))
    .toBeVisible();
  expect(screen.getAllByRole("row")).toHaveLength(5_000);
});
