import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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

const searchDelay = 180;

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

function fileLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines : [""];
}

function entryIcon(entry: WorkspaceEntry, expanded: boolean) {
  if (entry.kind === "directory") {
    return expanded
      ? <FolderOpenIcon aria-hidden="true" />
      : <FolderIcon aria-hidden="true" />;
  }
  return <FileTextIcon aria-hidden="true" />;
}

export function WorkspaceFilesView({
  session,
  api,
  active,
}: WorkspaceFilesViewProps) {
  const [directories, setDirectories] = useState<
    Record<string, WorkspaceDirectory>
  >({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(
    new Set(),
  );
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<unknown>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] =
    useState<WorkspaceSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<WorkspaceFile | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileError, setFileError] = useState(false);
  const sessionIDRef = useRef(session.id);
  sessionIDRef.current = session.id;

  useEffect(() => {
    setDirectories({});
    setExpanded(new Set());
    setLoadingDirectories(new Set());
    setRootError(null);
    setQuery("");
    setSearchResult(null);
    setSelectedPath(null);
    setSelectedFile(null);
    setFileError(false);
  }, [session.id]);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setRootLoading(true);
    void api.getWorkspaceDirectory(session.id).then((directory) => {
      if (!current) return;
      setDirectories((existing) => ({ ...existing, "": directory }));
      setRootError(null);
    }).catch((error) => {
      if (current) setRootError(error);
    }).finally(() => {
      if (current) setRootLoading(false);
    });
    return () => {
      current = false;
    };
  }, [active, api, refreshVersion, session.id]);

  useEffect(() => {
    if (!active) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResult(null);
      setSearching(false);
      setSearchError(false);
      return;
    }
    let current = true;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void api.searchWorkspace(session.id, trimmed).then((result) => {
        if (!current) return;
        setSearchResult(result);
        setSearchError(false);
      }).catch(() => {
        if (!current) return;
        setSearchResult(null);
        setSearchError(true);
      }).finally(() => {
        if (current) setSearching(false);
      });
    }, searchDelay);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [active, api, query, session.id]);

  useEffect(() => {
    if (!active || !selectedPath) return;
    let current = true;
    setFileLoading(true);
    setFileError(false);
    void api.getWorkspaceFile(session.id, selectedPath).then((file) => {
      if (current) setSelectedFile(file);
    }).catch(() => {
      if (!current) return;
      setSelectedFile(null);
      setFileError(true);
    }).finally(() => {
      if (current) setFileLoading(false);
    });
    return () => {
      current = false;
    };
  }, [active, api, selectedPath, session.id]);

  const root = directories[""];
  const workspaceRoot = root?.root ?? searchResult?.root ?? session.cwd;

  const toggleDirectory = (entry: WorkspaceEntry) => {
    if (entry.kind !== "directory") return;
    if (expanded.has(entry.path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(entry.path));
    if (directories[entry.path] || loadingDirectories.has(entry.path)) return;

    const requestSessionID = session.id;
    setLoadingDirectories((current) => new Set(current).add(entry.path));
    void api.getWorkspaceDirectory(session.id, entry.path).then((directory) => {
      if (sessionIDRef.current !== requestSessionID) return;
      setDirectories((current) => ({
        ...current,
        [entry.path]: directory,
      }));
    }).catch(() => {
      if (sessionIDRef.current !== requestSessionID) return;
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
    }).finally(() => {
      if (sessionIDRef.current !== requestSessionID) return;
      setLoadingDirectories((current) => {
        const next = new Set(current);
        next.delete(entry.path);
        return next;
      });
    });
  };

  const openFile = (path: string) => {
    setSelectedPath(path);
    setSelectedFile((current) => current?.path === path ? current : null);
  };

  const renderEntries = (path: string, depth = 0) => {
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
            <div
              className="workspace-tree-node"
              role="treeitem"
              aria-expanded={isDirectory ? isExpanded : undefined}
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
                  ? toggleDirectory(entry)
                  : openFile(entry.path)}
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
                <div role="group">
                  {loadingDirectories.has(entry.path)
                    ? (
                      <span className="workspace-tree-loading" role="status">
                        Loading {entry.path}…
                      </span>
                    )
                    : renderEntries(entry.path, depth + 1)}
                </div>
              )}
            </div>
          );
        })}
        {directory.truncated && (
          <p className="workspace-files-note">
            Only the first 500 entries are shown.
          </p>
        )}
      </>
    );
  };

  const lines = useMemo(
    () => selectedFile && !selectedFile.binary
      ? fileLines(selectedFile.content ?? "")
      : [],
    [selectedFile],
  );

  return (
    <section
      className="workspace-files-view"
      role="region"
      aria-label="Workspace files"
    >
      <div className="workspace-files-layout">
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
                    <div
                      className="workspace-code-table"
                      role="table"
                      aria-label={`Contents of ${selectedFile.path}`}
                    >
                      {lines.map((line, index) => (
                        <div className="workspace-code-row" role="row" key={index}>
                          <span role="cell">{index + 1}</span>
                          <code role="cell">{line || " "}</code>
                        </div>
                      ))}
                    </div>
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
                onClick={() => setRefreshVersion((current) => current + 1)}
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
                onChange={(event) => setQuery(event.target.value)}
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
            {!rootLoading && !root && rootError && (
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
                    onClick={() => setRefreshVersion((current) => current + 1)}
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
                        : `Browse search result ${entry.path}`}
                      disabled={
                        entry.kind !== "file" && entry.kind !== "directory"
                      }
                      onClick={() => {
                        if (entry.kind === "file") openFile(entry.path);
                        if (entry.kind === "directory") {
                          setQuery("");
                          toggleDirectory(entry);
                        }
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
                  role="tree"
                  aria-label="Workspace files"
                >
                  {renderEntries("")}
                  {root.entries.length === 0 && (
                    <p className="workspace-search-state">
                      This directory is empty.
                    </p>
                  )}
                </nav>
              )}
          </div>
        </aside>
      </div>
    </section>
  );
}
