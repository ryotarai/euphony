import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent,
  type CSSProperties,
  type ReactElement,
} from "react";
import { FileTree as FileTreeModel } from "@pierre/trees";
import { FileTree as PierreFileTree } from "@pierre/trees/react";
import { File as PierreFile } from "@pierre/diffs/react";
import {
  BinaryIcon,
  DownloadIcon,
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
const treeHostStyle = {
  minWidth: "100%",
  minHeight: "100%",
  height: "100%",
  "--trees-bg-override": "#0b0d0f",
  "--trees-bg-muted-override": "#151515",
  "--trees-fg-override": "#a3a3a3",
  "--trees-selected-bg-override": "#191919",
  "--trees-selected-fg-override": "#ffffff",
  "--trees-border-color-override": "#262626",
  "--trees-focus-ring-color-override": "#b8f34a",
  "--trees-font-family-override": '"SFMono-Regular", Consolas, monospace',
  "--trees-font-size-override": "0.66rem",
  "--trees-density-override": "0.75",
} as CSSProperties;
const fileSurfaceStyle: CSSProperties = {
  display: "block",
  width: "100%",
  height: "100%",
  minHeight: 0,
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

const imageFilePattern = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/iu;

function isImageFile(file: WorkspaceFile): boolean {
  return file.mimeType?.split(";", 1)[0].trim().toLocaleLowerCase().startsWith("image/")
    || imageFilePattern.test(file.path);
}

function fileContents(content: string): { content: string; truncated: boolean } {
  if (content === "") return { content: "", truncated: false };
  let start = 0;
  let lines = 0;
  while (lines < maxRenderedLines) {
    const end = content.indexOf("\n", start);
    if (end < 0) {
      return { content, truncated: false };
    }
    lines += 1;
    start = end + 1;
    if (start === content.length) {
      return { content, truncated: false };
    }
  }
  return { content: content.slice(0, start), truncated: start < content.length };
}

function entryIcon(entry: WorkspaceEntry) {
  if (entry.kind === "directory") return <FolderIcon aria-hidden="true" />;
  return <FileTextIcon aria-hidden="true" />;
}

function canonicalDirectoryPath(path: string): string {
  if (path === "") return "";
  return path.endsWith("/") ? path : `${path}/`;
}

function workspacePathFromTreePath(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function deselectTreePath(model: FileTreeModel, path: string): void {
  model.getItem(path)?.deselect();
}

function selectOnlyTreePath(model: FileTreeModel, path: string): void {
  for (const selectedPath of model.getSelectedPaths()) {
    if (selectedPath !== path) deselectTreePath(model, selectedPath);
  }
  model.getItem(path)?.select();
}

function treePathsFromDirectories(
  directories: Record<string, WorkspaceDirectory>,
): string[] {
  const paths = new Set<string>();
  for (const directory of Object.values(directories)) {
    for (const entry of directory.entries) {
      if (entry.path === "") continue;
      paths.add(entry.kind === "directory"
        ? canonicalDirectoryPath(entry.path)
        : entry.path);
    }
  }
  return [...paths];
}

function directoryEntriesFromDirectories(
  directories: Record<string, WorkspaceDirectory>,
): Map<string, WorkspaceEntry> {
  const entries = new Map<string, WorkspaceEntry>();
  for (const directory of Object.values(directories)) {
    for (const entry of directory.entries) {
      if (entry.kind === "directory") entries.set(entry.path, entry);
    }
  }
  return entries;
}

function workspaceEntriesFromDirectories(
  directories: Record<string, WorkspaceDirectory>,
): Map<string, WorkspaceEntry> {
  const entries = new Map<string, WorkspaceEntry>();
  for (const directory of Object.values(directories)) {
    for (const entry of directory.entries) entries.set(entry.path, entry);
  }
  return entries;
}

interface WorkspaceFileViewerProps {
  fileLoading: boolean;
  fileError: boolean;
  selectedFile: WorkspaceFile | null;
  renderedFile: ReturnType<typeof fileContents>;
  imagePreview: { path: string; url: string } | null;
  imagePreviewLoading: boolean;
  imagePreviewError: boolean;
  downloadError: boolean;
  downloading: boolean;
  onDownload(): void;
}

function renderWorkspaceFileViewer({
  fileLoading,
  fileError,
  selectedFile,
  renderedFile,
  imagePreview,
  imagePreviewLoading,
  imagePreviewError,
  downloadError,
  downloading,
  onDownload,
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
            <div className="workspace-file-header-actions">
              <span>
                {fileKind(selectedFile.path)} · {formatBytes(selectedFile.size)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label={`Download ${selectedFile.name}`}
                title={`Download ${selectedFile.name}`}
                disabled={downloading}
                onClick={onDownload}
              >
                <DownloadIcon aria-hidden="true" />
                <span>Download</span>
              </Button>
            </div>
          </header>
          {isImageFile(selectedFile)
            ? (
              imagePreviewLoading
                ? (
                  <div className="workspace-image-preview-state" role="status">
                    <Skeleton />
                    <span>Loading image preview…</span>
                  </div>
                )
                : imagePreviewError || imagePreview?.path !== selectedFile.path
                  ? (
                    <Empty className="workspace-files-empty">
                      <EmptyHeader>
                        <EmptyMedia variant="icon">
                          <FileTextIcon aria-hidden="true" />
                        </EmptyMedia>
                        <EmptyTitle>Image preview unavailable</EmptyTitle>
                        <EmptyDescription>
                          Download the file to open it in another application.
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )
                  : (
                    <figure className="workspace-image-preview">
                      <img src={imagePreview.url} alt={selectedFile.name} />
                      <figcaption>{selectedFile.path}</figcaption>
                    </figure>
                  )
            )
            : selectedFile.binary
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
                <PierreFile
                  key={selectedFile.path}
                  file={{
                    name: selectedFile.name,
                    contents: renderedFile.content,
                    cacheKey: selectedFile.path,
                  }}
                  options={{
                    disableFileHeader: true,
                    overflow: "scroll",
                    themeType: "dark",
                  }}
                  disableWorkerPool
                  className="workspace-pierre-file"
                  style={fileSurfaceStyle}
                />
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
          {downloadError && (
            <p className="workspace-file-download-error" role="status">
              The file could not be downloaded.
            </p>
          )}
        </>
      )}
    </article>
  );
}

interface WorkspaceDirectoryFeedbackProps {
  directories: Record<string, WorkspaceDirectory>;
  expanded: Set<string>;
  loadingDirectories: Set<string>;
  directoryErrors: Set<string>;
  directoryEntries: Map<string, WorkspaceEntry>;
  onLoadDirectory: (entry: WorkspaceEntry) => void;
}

function renderWorkspaceDirectoryFeedback({
  directories,
  expanded,
  loadingDirectories,
  directoryErrors,
  directoryEntries,
  onLoadDirectory,
}: WorkspaceDirectoryFeedbackProps): ReactElement[] {
  return [...expanded].flatMap((path) => {
    const entry = directoryEntries.get(path);
    if (!entry) return [];
    if (directoryErrors.has(path)) {
      return [
        <div className="workspace-tree-feedback" role="status" key={`${path}:error`}>
          <span>Directory unavailable.</span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label={`Retry ${path} directory`}
            onClick={() => onLoadDirectory(entry)}
          >
            Retry
          </Button>
        </div>,
      ];
    }
    if (loadingDirectories.has(path)) {
      return [
        <p className="workspace-tree-loading" role="status" key={`${path}:loading`}>
          Loading {path}…
        </p>,
      ];
    }
    const directory = directories[path];
    if (!directory) return [];
    const feedback: ReactElement[] = [];
    if (directory.entries.length === 0) {
      feedback.push(
        <p className="workspace-tree-empty" key={`${path}:empty`}>
          This directory is empty.
        </p>,
      );
    }
    if (directory.truncated) {
      feedback.push(
        <p className="workspace-files-note" key={`${path}:truncated`}>
          Only the first 500 entries are shown.
        </p>,
      );
    }
    return feedback;
  });
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
  directoryEntries: Map<string, WorkspaceEntry>;
  treeModel: FileTreeModel;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  onLoadDirectory: (entry: WorkspaceEntry) => void;
  onTreeClick: (event: MouseEvent<HTMLElement>) => void;
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
  directoryEntries,
  treeModel,
  onQueryChange,
  onRefresh,
  onLoadDirectory,
  onTreeClick,
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
                  {entryIcon(entry)}
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
              <PierreFileTree
                model={treeModel}
                aria-label="Workspace file tree"
                onClick={onTreeClick}
                style={treeHostStyle}
              />
              {root.entries.length === 0 && (
                <p className="workspace-search-state">
                  This directory is empty.
                </p>
              )}
              {root.truncated && (
                <p className="workspace-files-note">
                  Only the first 500 entries are shown.
                </p>
              )}
              {renderWorkspaceDirectoryFeedback({
                directories,
                expanded,
                loadingDirectories,
                directoryErrors,
                directoryEntries,
                onLoadDirectory,
              })}
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
  const [imagePreview, setImagePreview] = useState<{
    path: string;
    url: string;
  } | null>(null);
  const [imagePreviewLoading, setImagePreviewLoading] = useState(false);
  const [imagePreviewError, setImagePreviewError] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const sessionIDRef = useRef(session.id);
  const refreshGenerationRef = useRef(0);
  const treeSelectionRef = useRef<(paths: readonly string[]) => void>(() => {});
  const treeModel = useMemo(
    () => new FileTreeModel({
      paths: [],
      flattenEmptyDirectories: false,
      initialExpansion: "closed",
      onSelectionChange: (paths) => treeSelectionRef.current(paths),
    }),
    [],
  );
  const treePaths = useMemo(
    () => treePathsFromDirectories(directories),
    [directories],
  );
  const treePathSet = useMemo(() => new Set(treePaths), [treePaths]);
  const expandedTreePaths = useMemo(
    () => {
      const paths: string[] = [];
      for (const path of expanded) {
        const canonicalPath = canonicalDirectoryPath(path);
        if (treePathSet.has(canonicalPath)) paths.push(canonicalPath);
      }
      return paths;
    },
    [expanded, treePathSet],
  );
  const directoryEntries = useMemo(
    () => directoryEntriesFromDirectories(directories),
    [directories],
  );
  const workspaceEntries = useMemo(
    () => workspaceEntriesFromDirectories(directories),
    [directories],
  );

  useEffect(() => {
    return () => treeModel.cleanUp();
  }, [treeModel]);

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

  useEffect(() => {
    const filePath = selectedFile && isImageFile(selectedFile)
      ? selectedFile.path
      : null;
    let current = true;
    let objectURL: string | null = null;
    setImagePreview(null);
    setImagePreviewError(false);
    setImagePreviewLoading(Boolean(active && filePath));
    if (!active || !filePath) {
      return () => {
        current = false;
      };
    }

    void api.getWorkspaceFileContent(session.id, filePath).then((content) => {
      if (!current) return;
      objectURL = URL.createObjectURL(content);
      setImagePreview({ path: filePath, url: objectURL });
      setImagePreviewLoading(false);
    }).catch(() => {
      if (!current) return;
      setImagePreviewError(true);
      setImagePreviewLoading(false);
    });
    return () => {
      current = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [active, api, selectedFile, session.id]);

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

  const refreshWorkspace = () => {
    refreshGenerationRef.current += 1;
    dispatch({ type: "refreshRequested" });
  };

  const openFile = useCallback((path: string) => {
    dispatch({ type: "fileSelected", path });
  }, []);

  const downloadSelectedFile = useCallback(async () => {
    if (!selectedFile || downloading) return;
    setDownloading(true);
    setDownloadError(false);
    let url = imagePreview?.path === selectedFile.path ? imagePreview.url : null;
    let temporaryURL = false;
    try {
      if (!url) {
        const content = await api.getWorkspaceFileContent(session.id, selectedFile.path);
        url = URL.createObjectURL(content);
        temporaryURL = true;
      }
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = selectedFile.name;
      anchor.rel = "noopener";
      anchor.click();
      if (temporaryURL) {
        const downloadURL = url;
        window.setTimeout(() => URL.revokeObjectURL(downloadURL), 0);
      }
    } catch {
      if (temporaryURL && url) URL.revokeObjectURL(url);
      setDownloadError(true);
    } finally {
      setDownloading(false);
    }
  }, [api, downloading, imagePreview, selectedFile, session.id]);

  const handleTreeClick = (event: MouseEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    const item = event.nativeEvent.composedPath().find(
      (target): target is HTMLElement =>
        target instanceof HTMLElement && target.dataset.itemPath !== undefined,
    );
    if (!item || item.dataset.itemType !== "folder") return;
    const path = workspacePathFromTreePath(item.dataset.itemPath ?? "");
    const entry = directoryEntries.get(path);
    dispatch({ type: "directoryToggled", path });
    if (entry && !directories[path] && !loadingDirectories.has(path)) {
      loadDirectory(entry);
    }
  };

  useLayoutEffect(() => {
    treeSelectionRef.current = (paths) => {
      const filePath = paths.find((path) => {
        if (path.endsWith("/")) return false;
        return workspaceEntries.get(workspacePathFromTreePath(path))?.kind === "file";
      });
      for (const path of paths) {
        if (
          path.endsWith("/") ||
          workspaceEntries.get(workspacePathFromTreePath(path))?.kind !== "file"
        ) {
          deselectTreePath(treeModel, path);
        }
      }
      if (filePath) openFile(workspacePathFromTreePath(filePath));
    };
  }, [openFile, treeModel, workspaceEntries]);

  useLayoutEffect(() => {
    treeModel.resetPaths(treePaths, {
      initialExpandedPaths: expandedTreePaths,
    });
  }, [expandedTreePaths, treeModel, treePaths]);

  useLayoutEffect(() => {
    const selected = selectedPath && treeModel.getItem(selectedPath)
      ? selectedPath
      : null;
    const current = treeModel.getSelectedPaths();
    if (!selected) {
      for (const path of current) deselectTreePath(treeModel, path);
      return;
    }
    if (current.length !== 1 || current[0] !== selected) {
      selectOnlyTreePath(treeModel, selected);
    }
  }, [selectedPath, treeModel, treePaths]);

  const renderedFile = useMemo(
    () => selectedFile && !selectedFile.binary
      ? fileContents(selectedFile.content ?? "")
      : { content: "", truncated: false },
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
          imagePreview,
          imagePreviewLoading,
          imagePreviewError,
          downloadError,
          downloading,
          onDownload: () => void downloadSelectedFile(),
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
          directoryEntries,
          treeModel,
          onQueryChange: (nextQuery) => {
            dispatch({ type: "queryChanged", query: nextQuery });
          },
          onRefresh: refreshWorkspace,
          onLoadDirectory: loadDirectory,
          onTreeClick: handleTreeClick,
          onOpenFile: openFile,
        })}
      </div>
    </section>
  );
}

export function WorkspaceFilesView(props: WorkspaceFilesViewProps) {
  return <WorkspaceFilesViewContent key={props.session.id} {...props} />;
}
