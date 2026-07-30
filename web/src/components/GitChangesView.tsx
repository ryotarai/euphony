import { useEffect, useMemo, useState } from "react";
import {
  CircleSlash2Icon,
  FileDiffIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
} from "lucide-react";
import { ApiError, type ApiClient } from "../api";
import type {
  GitChangedFile,
  GitChangesSnapshot,
  GitDiffLine,
  Session,
} from "../types";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";

interface GitChangesViewProps {
  session: Session;
  api: ApiClient;
  active: boolean;
}

const refreshInterval = 2_000;

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function fileDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function statusCode(file: GitChangedFile): string {
  switch (file.status) {
    case "added":
    case "untracked":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

function linePrefix(line: GitDiffLine): string {
  if (line.kind === "addition") return "+";
  if (line.kind === "deletion") return "-";
  if (line.kind === "meta") return "\\";
  return " ";
}

function errorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : "";
}

function branchMovement(snapshot: GitChangesSnapshot): string {
  return `${snapshot.ahead} ${snapshot.ahead === 1 ? "commit" : "commits"} ahead, ` +
    `${snapshot.behind} ${snapshot.behind === 1 ? "commit" : "commits"} behind`;
}

export function GitChangesView({
  session,
  api,
  active,
}: GitChangesViewProps) {
  const [snapshot, setSnapshot] = useState<GitChangesSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!active) return;
    let current = true;
    let refreshTimer: number | undefined;
    const load = async () => {
      if (!snapshot) setLoading(true);
      try {
        const next = await api.getGitChanges(
          session.id,
          selectedPath ?? undefined,
        );
        if (!current) return;
        setSnapshot(next);
        setError(null);
        setSelectedPath((selected) => {
          if (selected && next.files.some((file) => file.path === selected)) {
            return selected;
          }
          return next.files[0]?.path ?? null;
        });
      } catch (nextError) {
        if (!current) return;
        if (errorCode(nextError) === "git_change_not_found") {
          setSelectedPath(null);
          return;
        }
        setError(nextError);
      } finally {
        if (current) {
          setLoading(false);
          refreshTimer = window.setTimeout(() => void load(), refreshInterval);
        }
      }
    };
    void load();
    return () => {
      current = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
    };
  }, [active, api, selectedPath, session.id]);

  const selectedFile = useMemo(
    () => snapshot?.files.find((file) => file.path === selectedPath) ?? null,
    [selectedPath, snapshot],
  );
  const repositoryMissing = errorCode(error) === "git_repository_not_found";
  const partialStats = Boolean(snapshot?.truncated || snapshot?.statsTruncated);

  return (
    <section
      className="git-changes-view"
      role="region"
      aria-label="Git changes"
    >
      {loading && !snapshot && (
        <div className="git-changes-loading" role="status" aria-label="Loading Git changes">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      )}
      {repositoryMissing && (
        <Empty className="git-changes-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CircleSlash2Icon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No Git repository</EmptyTitle>
            <EmptyDescription>
              Start this terminal inside a Git worktree to inspect local changes.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {!repositoryMissing && !loading && snapshot?.files.length === 0 && (
        <Empty className="git-changes-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <GitCompareArrowsIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No local changes</EmptyTitle>
            <EmptyDescription>
              Modified and untracked files will appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {!repositoryMissing && !snapshot && !loading && Boolean(error) && (
        <Empty className="git-changes-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileDiffIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>Changes unavailable</EmptyTitle>
            <EmptyDescription>
              Git changes could not be refreshed.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {!repositoryMissing && snapshot && snapshot.files.length > 0 && (
        <div className="git-changes-layout">
          <aside className="git-file-instrument">
            <header className="git-changes-summary">
              <div className="git-branch-line">
                <GitBranchIcon aria-hidden="true" />
                <strong>{snapshot.branch || "Git worktree"}</strong>
                {snapshot.upstream && <span>{snapshot.upstream}</span>}
              </div>
              <div className="git-change-totals">
                {(snapshot.ahead > 0 || snapshot.behind > 0) && (
                  <span
                    className="git-branch-movement"
                    aria-label={branchMovement(snapshot)}
                  >
                    ↑{snapshot.ahead} ↓{snapshot.behind}
                  </span>
                )}
                <span>{snapshot.files.length}{snapshot.truncated ? "+" : ""} files</span>
                <span className="git-additions">
                  {partialStats ? "≥+" : "+"}{snapshot.additions}
                </span>
                <span className="git-deletions">
                  {partialStats ? "≥−" : "−"}{snapshot.deletions}
                </span>
              </div>
            </header>
            <nav className="git-file-list" aria-label="Changed files">
              {snapshot.files.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  className="git-file-row"
                  data-status={file.status}
                  aria-current={file.path === selectedPath ? "true" : undefined}
                  aria-label={`${file.path}, ${file.status}, ${file.additions} additions, ${file.deletions} deletions`}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span className="git-file-status" aria-hidden="true">
                    {statusCode(file)}
                  </span>
                  <span className="git-file-identity">
                    <strong>{fileName(file.path)}</strong>
                    {fileDirectory(file.path) && (
                      <small>{fileDirectory(file.path)}</small>
                    )}
                  </span>
                  <span className="git-file-counts" aria-hidden="true">
                    {file.additions > 0 && (
                      <span className="git-additions">+{file.additions}</span>
                    )}
                    {file.deletions > 0 && (
                      <span className="git-deletions">−{file.deletions}</span>
                    )}
                  </span>
                </button>
              ))}
            </nav>
            {snapshot.truncated && (
              <p className="git-changes-note">Only the first 200 files are shown.</p>
            )}
          </aside>
          <article
            className="git-diff-instrument"
            aria-label={selectedFile ? `Diff for ${selectedFile.path}` : "Selected diff"}
          >
            {selectedFile && (
              <>
                <header className="git-diff-header">
                  <div>
                    <strong>{selectedFile.path}</strong>
                    {selectedFile.previousPath && (
                      <span>{selectedFile.previousPath} →</span>
                    )}
                  </div>
                  <span>{selectedFile.status}</span>
                </header>
                <div className="git-diff-scroll">
                  {selectedFile.binary ? (
                    <p className="git-diff-message">Binary file changed.</p>
                  ) : !selectedFile.patchLoaded ? (
                    <p className="git-diff-message">Loading diff…</p>
                  ) : selectedFile.hunks.length === 0 ? (
                    <p className="git-diff-message">No textual changes.</p>
                  ) : (
                    <div className="git-diff-table" role="table">
                      {selectedFile.hunks.map((hunk, hunkIndex) => (
                        <div className="git-diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
                          <div className="git-diff-hunk-header" role="row">
                            <span aria-hidden="true" />
                            <span aria-hidden="true" />
                            <code>{hunk.header}</code>
                          </div>
                          {hunk.lines.map((line, lineIndex) => (
                            <div
                              className="git-diff-row"
                              data-kind={line.kind}
                              role="row"
                              key={`${line.kind}-${line.oldLine ?? ""}-${line.newLine ?? ""}-${lineIndex}`}
                            >
                              <span className="git-diff-old-line" role="cell">
                                {line.oldLine || ""}
                              </span>
                              <span className="git-diff-new-line" role="cell">
                                {line.newLine || ""}
                              </span>
                              <code role="cell">
                                <span className="git-diff-prefix" aria-hidden="true">
                                  {linePrefix(line)}
                                </span>
                                {line.content}
                              </code>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {selectedFile.truncated && (
                    <p className="git-changes-note">Diff truncated after 1 MiB.</p>
                  )}
                </div>
              </>
            )}
          </article>
          {Boolean(error) && snapshot && (
            <p className="git-changes-refresh-note" role="status">
              Changes could not be refreshed.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
