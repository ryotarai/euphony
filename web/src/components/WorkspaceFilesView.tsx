import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  BinaryIcon,
  ChevronRightIcon,
  FileTextIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import type { ApiClient } from "../api";
import type {
  Session,
  WorkspaceDirectory,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSearchResult,
} from "../types";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

interface WorkspaceFilesViewProps {
  session: Session;
  api: ApiClient;
  active: boolean;
}

interface WorkspaceFilesState {
  directories: Record<string, WorkspaceDirectory>;
  expanded: Set<string>;
  loadingDirectories: Set<string>;
  directoryErrors: Set<string>;
  rootLoading: boolean;
  rootError: unknown;
  refreshVersion: number;
  query: string;
  searchResult: WorkspaceSearchResult | null;
  searching: boolean;
  searchError: boolean;
  selectedPath: string | null;
  selectedFile: WorkspaceFile | null;
  fileLoading: boolean;
  fileError: boolean;
}

const initialWorkspaceFilesState: WorkspaceFilesState = {
  directories: {},
  expanded: new Set(),
  loadingDirectories: new Set(),
  directoryErrors: new Set(),
  rootLoading: false,
  rootError: null,
  refreshVersion: 0,
  query: "",
  searchResult: null,
  searching: false,
  searchError: false,
  selectedPath: null,
  selectedFile: null,
  fileLoading: false,
  fileError: false,
};

type WorkspaceFilesAction =
  | { type: "rootRequestStarted" }
  | { type: "rootLoaded"; directory: WorkspaceDirectory }
  | { type: "rootFailed"; error: unknown }
  | { type: "rootRequestFinished" }
  | { type: "queryChanged"; query: string }
  | { type: "searchCleared" }
  | { type: "searchRequestStarted" }
  | { type: "searchLoaded"; result: WorkspaceSearchResult }
  | { type: "searchFailed" }
  | { type: "fileSelected"; path: string }
  | { type: "fileRequestStarted" }
  | { type: "fileLoaded"; file: WorkspaceFile }
  | { type: "fileFailed" }
  | { type: "directoryRequestStarted"; path: string }
  | {
    type: "directoryLoaded";
    path: string;
    directory: WorkspaceDirectory;
  }
  | { type: "directoryFailed"; path: string }
  | { type: "directoryToggled"; path: string }
  | { type: "refreshRequested" };

function workspaceFilesReducer(
  state: WorkspaceFilesState,
  action: WorkspaceFilesAction,
): WorkspaceFilesState {
  switch (action.type) {
    case "rootRequestStarted":
      return { ...state, rootLoading: true };
    case "rootLoaded":
      return {
        ...state,
        directories: { ...state.directories, "": action.directory },
        rootError: null,
      };
    case "rootFailed":
      return { ...state, rootError: action.error };
    case "rootRequestFinished":
      return { ...state, rootLoading: false };
    case "queryChanged":
      return { ...state, query: action.query };
    case "searchCleared":
      return {
        ...state,
        searchResult: null,
        searching: false,
        searchError: false,
      };
    case "searchRequestStarted":
      return { ...state, searching: true };
    case "searchLoaded":
      return {
        ...state,
        searchResult: action.result,
        searching: false,
        searchError: false,
      };
    case "searchFailed":
      return {
        ...state,
        searchResult: null,
        searching: false,
        searchError: true,
      };
    case "fileSelected":
      return {
        ...state,
        selectedPath: action.path,
        selectedFile: state.selectedFile?.path === action.path
          ? state.selectedFile
          : null,
      };
    case "fileRequestStarted":
      return { ...state, fileLoading: true, fileError: false };
    case "fileLoaded":
      return { ...state, selectedFile: action.file, fileLoading: false };
    case "fileFailed":
      return {
        ...state,
        selectedFile: null,
        fileLoading: false,
        fileError: true,
      };
    case "directoryRequestStarted": {
      const directoryErrors = new Set(state.directoryErrors);
      directoryErrors.delete(action.path);
      const loadingDirectories = new Set(state.loadingDirectories);
      loadingDirectories.add(action.path);
      return { ...state, directoryErrors, loadingDirectories };
    }
    case "directoryLoaded": {
      const loadingDirectories = new Set(state.loadingDirectories);
      loadingDirectories.delete(action.path);
      return {
        ...state,
        directories: {
          ...state.directories,
          [action.path]: action.directory,
        },
        loadingDirectories,
      };
    }
    case "directoryFailed": {
      const directoryErrors = new Set(state.directoryErrors);
      directoryErrors.add(action.path);
      const loadingDirectories = new Set(state.loadingDirectories);
      loadingDirectories.delete(action.path);
      return { ...state, directoryErrors, loadingDirectories };
    }
    case "directoryToggled": {
      const expanded = new Set(state.expanded);
      if (expanded.has(action.path)) expanded.delete(action.path);
      else expanded.add(action.path);
      return { ...state, expanded };
    }
    case "refreshRequested": {
      const directories: Record<string, WorkspaceDirectory> = {};
      if (state.directories[""]) directories[""] = state.directories[""];
      return {
        ...state,
        directories,
        expanded: new Set(),
        loadingDirectories: new Set(),
        directoryErrors: new Set(),
        refreshVersion: state.refreshVersion + 1,
      };
    }
  }
}

const searchDelay = 180;
const maxRenderedLines = 5_000;
const treeListStyle: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
};
const codeTableStyle: CSSProperties = {
  display: "block",
  minWidth: "100%",
  width: "max-content",
  padding: "0.65rem 0 1.5rem",
};
const codeTableBodyStyle: CSSProperties = {
  display: "block",
  minWidth: "100%",
};
const codeLineNumberStyle: CSSProperties = {
  display: "block",
  padding: "0 0.6rem",
  color: "#515151",
  background: "#080808",
  borderRight: "1px solid #1c1c1c",
  fontVariantNumeric: "tabular-nums",
  textAlign: "right",
  userSelect: "none",
};
const codeContentStyle: CSSProperties = {
  display: "block",
  padding: "0 0.8rem",
  font: "inherit",
  whiteSpace: "pre",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function fileKind(path: string): string {
  const extension = path.split(".").at(-1);
  if (!extension || extension === path) return "Text";
  return extension.toUpperCase();
}

function fileLines(content: string): { lines: string[]; truncated: boolean } {
  if (content === "") return { lines: [""], truncated: false };
  const lines: string[] = [];
  let start = 0;
  while (lines.length < maxRenderedLines) {
    const end = content.indexOf("\n", start);
    if (end < 0) {
      lines.push(content.slice(start));
      return { lines, truncated: false };
    }
    lines.push(content.slice(start, end));
    start = end + 1;
    if (start === content.length) {
      return { lines, truncated: false };
    }
  }
  return { lines, truncated: start < content.length };
}

function entryIcon(entry: WorkspaceEntry, expanded: boolean) {
  if (entry.kind === "directory") {
    return expanded
      ? <FolderOpenIcon aria-hidden="true" />
      : <FolderIcon aria-hidden="true" />;
  }
  return <FileTextIcon aria-hidden="true" />;
}

interface WorkspaceTreeProps {
  root: WorkspaceDirectory;
  directories: Record<string, WorkspaceDirectory>;
  expanded: Set<string>;
  loadingDirectories: Set<string>;
  directoryErrors: Set<string>;
  selectedPath: string | null;
  onLoadDirectory: (entry: WorkspaceEntry) => void;
  onToggleDirectory: (entry: WorkspaceEntry) => void;
  onOpenFile: (path: string) => void;
}

function renderWorkspaceTree({
  root,
  directories,
  expanded,
  loadingDirectories,
  directoryErrors,
  selectedPath,
  onLoadDirectory,
  onToggleDirectory,
  onOpenFile,
}: WorkspaceTreeProps) {
  const renderEntries = (path: string, depth = 0): ReactNode => {
    const directory = directories[path];
    if (!directory) return null;
    return (
      <>
        {directory.entries.map((entry) => {
          const isExpanded = expanded.has(entry.path);
          const isDirectory = entry.kind === "directory";
          const isFile = entry.kind === "file";
          const label = isDirectory
            ? `${isExpanded ? "Collapse" : "Expand"} ${entry.path}`
            : isFile
              ? `Open ${entry.path}`
              : `Unavailable ${entry.path}`;
          return (
            <li
              className="workspace-tree-node"
              key={entry.path}
            >
              <button
                type="button"
                className="workspace-tree-row"
                aria-label={label}
                aria-current={entry.path === selectedPath ? "true" : undefined}
                disabled={!isDirectory && !isFile}
                style={{ "--tree-depth": depth } as CSSProperties}
                onClick={() => isDirectory
                  ? onToggleDirectory(entry)
                  : onOpenFile(entry.path)}
              >
                <ChevronRightIcon
                  className="workspace-tree-chevron"
                  data-expanded={isExpanded || undefined}
                  aria-hidden="true"
                />
                {entryIcon(entry, isExpanded)}
                <span>{entry.name}</span>
              </button>
              {isDirectory && isExpanded && (
                <ul style={treeListStyle}>
                  {directoryErrors.has(entry.path)
                    ? (
                      <li className="workspace-tree-feedback" role="status">
                        <span>Directory unavailable.</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          aria-label={`Retry ${entry.path} directory`}
                          onClick={() => onLoadDirectory(entry)}
                        >
                          Retry
                        </Button>
                      </li>
                    )
                    : loadingDirectories.has(entry.path)
                    ? (
                      <li className="workspace-tree-loading" role="status">
                        Loading {entry.path}…
                      </li>
                    )
                    : directories[entry.path]?.entries.length === 0
                      ? (
                        <li className="workspace-tree-empty">
                          This directory is empty.
                        </li>
                      )
                      : renderEntries(entry.path, depth + 1)}
                </ul>
              )}
            </li>
          );
        })}
        {directory.truncated && (
          <li className="workspace-files-note">
            Only the first 500 entries are shown.
          </li>
        )}
      </>
    );
  };

  return <ul style={treeListStyle}>{renderEntries(root.path)}</ul>;
}

interface WorkspaceFileViewerProps {
  fileLoading: boolean;
  fileError: boolean;
  selectedFile: WorkspaceFile | null;
  renderedFile: ReturnType<typeof fileLines>;
}

function renderWorkspaceFileViewer({
  fileLoading,
  fileError,
  selectedFile,
  renderedFile,
}: WorkspaceFileViewerProps) {
  return (
    <article className="workspace-file-viewer">
      {fileLoading && (
        <div className="workspace-file-loading" role="status">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      )}
      {!fileLoading && fileError && (
        <Empty className="workspace-files-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileTextIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>File unavailable</EmptyTitle>
            <EmptyDescription>
              The selected file could not be read.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {!fileLoading && !fileError && !selectedFile && (
        <Empty className="workspace-files-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderOpenIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Open a file</EmptyTitle>
            <EmptyDescription>
              Select a text file from the workspace tree.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {!fileLoading && selectedFile && (
        <>
          <header className="workspace-file-header">
            <div>
              <h2>{selectedFile.name}</h2>
              <span>{selectedFile.path}</span>
            </div>
            <span>
              {fileKind(selectedFile.path)} · {formatBytes(selectedFile.size)}
            </span>
          </header>
          {selectedFile.binary
            ? (
              <Empty className="workspace-files-empty">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <BinaryIcon aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>Binary file</EmptyTitle>
                  <EmptyDescription>
                    Binary content is not displayed in the read-only viewer.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
            : (
              <div className="workspace-code-scroll">
                <table
                  className="workspace-code-table"
                  style={codeTableStyle}
                  aria-label={`Contents of ${selectedFile.path}`}
                >
                  <tbody style={codeTableBodyStyle}>
                    {renderedFile.lines.map((line, index) => (
                      <tr className="workspace-code-row" key={index}>
                        <td style={codeLineNumberStyle}>{index + 1}</td>
                        <td style={codeContentStyle}>{line || " "}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {renderedFile.truncated && (
                  <p className="workspace-files-note">
                    Only the first 5,000 lines are shown.
                  </p>
                )}
                {selectedFile.truncated && (
                  <p className="workspace-files-note">
                    Only the first 1 MiB is shown.
                  </p>
                )}
              </div>
            )}
        </>
      )}
    </article>
  );
}

interface WorkspaceFileNavigatorProps {
  root: WorkspaceDirectory | undefined;
  rootLoading: boolean;
  rootError: unknown;
  workspaceRoot: string;
  query: string;
  searchResult: WorkspaceSearchResult | null;
  searching: boolean;
  searchError: boolean;
  directories: Record<string, WorkspaceDirectory>;
  expanded: Set<string>;
  loadingDirectories: Set<string>;
  directoryErrors: Set<string>;
  selectedPath: string | null;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onLoadDirectory: (entry: WorkspaceEntry) => void;
  onToggleDirectory: (entry: WorkspaceEntry) => void;
  onOpenFile: (path: string) => void;
}

function renderWorkspaceFileNavigator({
  root,
  rootLoading,
  rootError,
  workspaceRoot,
  query,
  searchResult,
  searching,
  searchError,
  directories,
  expanded,
  loadingDirectories,
  directoryErrors,
  selectedPath,
  onQueryChange,
  onRefresh,
  onLoadDirectory,
  onToggleDirectory,
  onOpenFile,
}: WorkspaceFileNavigatorProps) {
  return (
    <aside className="workspace-file-navigator">
      <header className="workspace-navigator-header">
        <div className="workspace-root-line">
          <FolderTreeIcon aria-hidden="true" />
          <span title={workspaceRoot}>{workspaceRoot}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            title="Refresh workspace files"
            onClick={onRefresh}
          >
            <RefreshCwIcon aria-hidden="true" />
          </Button>
        </div>
        <label className="workspace-search-field">
          <SearchIcon aria-hidden="true" />
          <Input
            type="search"
            value={query}
            aria-label="Filter workspace files"
            placeholder="Filter files…"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
      </header>

      <div className="workspace-tree-scroll">
        {rootLoading && !root && (
          <div className="workspace-tree-skeleton" role="status">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        )}
        {!rootLoading && !root && Boolean(rootError) && (
          <Empty className="workspace-navigator-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderTreeIcon aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>Workspace unavailable</EmptyTitle>
              <EmptyDescription>
                The terminal workspace could not be read.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={onRefresh}
              >
                Retry
              </Button>
            </EmptyContent>
          </Empty>
        )}
        {query.trim()
          ? (
            <nav
              className="workspace-search-results"
              aria-label="Workspace search results"
            >
              {searching && (
                <p className="workspace-search-state" role="status">
                  Searching…
                </p>
              )}
              {!searching && searchError && (
                <p className="workspace-search-state" role="status">
                  Search unavailable.
                </p>
              )}
              {!searching && !searchError &&
                searchResult?.matches.length === 0 && (
                <p className="workspace-search-state">No matching files.</p>
              )}
              {searchResult?.matches.map((entry) => (
                <button
                  type="button"
                  className="workspace-search-row"
                  key={entry.path}
                  aria-label={entry.kind === "file"
                    ? `Open search result ${entry.path}`
                    : `Directory search result ${entry.path}`}
                  disabled={entry.kind !== "file"}
                  onClick={() => {
                    if (entry.kind === "file") onOpenFile(entry.path);
                  }}
                >
                  {entryIcon(entry, false)}
                  <span>
                    <strong>{entry.name}</strong>
                    <small>{entry.path}</small>
                  </span>
                </button>
              ))}
              {searchResult?.truncated && (
                <p className="workspace-files-note">
                  Only the first 200 matches are shown.
                </p>
              )}
            </nav>
          )
          : root && (
            <nav
              className="workspace-tree"
              aria-label="Workspace files"
            >
              {renderWorkspaceTree({
                root,
                directories,
                expanded,
                loadingDirectories,
                directoryErrors,
                selectedPath,
                onLoadDirectory,
                onToggleDirectory,
                onOpenFile,
              })}
              {root.entries.length === 0 && (
                <p className="workspace-search-state">
                  This directory is empty.
                </p>
              )}
            </nav>
          )}
      </div>
      {root && Boolean(rootError) && (
        <p className="workspace-refresh-warning" role="status">
          Workspace could not be refreshed.
        </p>
      )}
    </aside>
  );
}

function WorkspaceFilesViewContent({
  session,
  api,
  active,
}: WorkspaceFilesViewProps) {
  const [state, dispatch] = useReducer(
    workspaceFilesReducer,
    initialWorkspaceFilesState,
  );
  const {
    directories,
    expanded,
    loadingDirectories,
    directoryErrors,
    rootLoading,
    rootError,
    refreshVersion,
    query,
    searchResult,
    searching,
    searchError,
    selectedPath,
    selectedFile,
    fileLoading,
    fileError,
  } = state;
  const sessionIDRef = useRef(session.id);
  const refreshGenerationRef = useRef(0);

  useLayoutEffect(() => {
    sessionIDRef.current = session.id;
    return () => {
      refreshGenerationRef.current += 1;
    };
  }, [session.id]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    dispatch({ type: "rootRequestStarted" });
    void api.getWorkspaceDirectory(session.id).then((directory) => {
      if (!current) return;
      dispatch({ type: "rootLoaded", directory });
    }).catch((error) => {
      if (current) dispatch({ type: "rootFailed", error });
    }).finally(() => {
      if (current) dispatch({ type: "rootRequestFinished" });
    });
    return () => {
      current = false;
    };
  }, [active, api, refreshVersion, session.id]);

  useEffect(() => {
    if (!active) return;
    const trimmed = query.trim();
    if (!trimmed) {
      dispatch({ type: "searchCleared" });
      return;
    }
    let current = true;
    dispatch({ type: "searchRequestStarted" });
    const timer = window.setTimeout(() => {
      void api.searchWorkspace(session.id, trimmed).then((result) => {
        if (!current) return;
        dispatch({ type: "searchLoaded", result });
      }).catch(() => {
        if (!current) return;
        dispatch({ type: "searchFailed" });
      });
    }, searchDelay);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [active, api, query, refreshVersion, session.id]);

  useEffect(() => {
    if (!active || !selectedPath) return;
    let current = true;
    dispatch({ type: "fileRequestStarted" });
    void api.getWorkspaceFile(session.id, selectedPath).then((file) => {
      if (current) dispatch({ type: "fileLoaded", file });
    }).catch(() => {
      if (!current) return;
      dispatch({ type: "fileFailed" });
    });
    return () => {
      current = false;
    };
  }, [active, api, refreshVersion, selectedPath, session.id]);

  const root = directories[""];
  const workspaceRoot = root?.root ?? searchResult?.root ?? session.cwd;

  const loadDirectory = (entry: WorkspaceEntry) => {
    const requestSessionID = session.id;
    const requestGeneration = refreshGenerationRef.current;
    dispatch({ type: "directoryRequestStarted", path: entry.path });
    void api.getWorkspaceDirectory(session.id, entry.path).then((directory) => {
      if (
        sessionIDRef.current !== requestSessionID ||
        refreshGenerationRef.current !== requestGeneration
      ) return;
      dispatch({ type: "directoryLoaded", path: entry.path, directory });
    }).catch(() => {
      if (
        sessionIDRef.current !== requestSessionID ||
        refreshGenerationRef.current !== requestGeneration
      ) return;
      dispatch({ type: "directoryFailed", path: entry.path });
    });
  };

  const toggleDirectory = (entry: WorkspaceEntry) => {
    if (entry.kind !== "directory") return;
    if (expanded.has(entry.path)) {
      dispatch({ type: "directoryToggled", path: entry.path });
      return;
    }
    dispatch({ type: "directoryToggled", path: entry.path });
    if (directories[entry.path] || loadingDirectories.has(entry.path)) return;
    loadDirectory(entry);
  };

  const refreshWorkspace = () => {
    refreshGenerationRef.current += 1;
    dispatch({ type: "refreshRequested" });
  };

  const openFile = (path: string) => {
    dispatch({ type: "fileSelected", path });
  };

  const renderedFile = useMemo(
    () => selectedFile && !selectedFile.binary
      ? fileLines(selectedFile.content ?? "")
      : { lines: [], truncated: false },
    [selectedFile],
  );

  return (
    <section
      className="workspace-files-view"
      aria-label="Workspace files"
    >
      <div className="workspace-files-layout">
        {renderWorkspaceFileViewer({
          fileLoading,
          fileError,
          selectedFile,
          renderedFile,
        })}
        {renderWorkspaceFileNavigator({
          root,
          rootLoading,
          rootError,
          workspaceRoot,
          query,
          searchResult,
          searching,
          searchError,
          directories,
          expanded,
          loadingDirectories,
          directoryErrors,
          selectedPath,
          onQueryChange: (nextQuery) => {
            dispatch({ type: "queryChanged", query: nextQuery });
          },
          onRefresh: refreshWorkspace,
          onLoadDirectory: loadDirectory,
          onToggleDirectory: toggleDirectory,
          onOpenFile: openFile,
        })}
      </div>
    </section>
  );
}

export function WorkspaceFilesView(props: WorkspaceFilesViewProps) {
  return <WorkspaceFilesViewContent key={props.session.id} {...props} />;
}
