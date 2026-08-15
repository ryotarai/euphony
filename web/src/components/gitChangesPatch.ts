import type { GitChangedFile, GitDiffLine } from "../types";

function isAdded(file: GitChangedFile): boolean {
  return file.status === "added" || file.status === "untracked";
}

function isDeleted(file: GitChangedFile): boolean {
  return file.status === "deleted";
}

function isRenamed(file: GitChangedFile): boolean {
  return file.status === "renamed" && Boolean(file.previousPath);
}

function patchLine(line: GitDiffLine): string {
  switch (line.kind) {
    case "context":
      return ` ${line.content}`;
    case "addition":
      return `+${line.content}`;
    case "deletion":
      return `-${line.content}`;
    case "meta":
      return line.content.startsWith("\\") ? line.content : `\\ ${line.content}`;
  }
}

/**
 * Reconstruct one bounded Git patch from the normalized hunk data returned by
 * the API. The adapter emits only the selected file and never expands a hunk
 * into full file contents.
 */
export function gitChangedFileToPatch(file: GitChangedFile): string {
  const added = isAdded(file);
  const deleted = isDeleted(file);
  const renamed = isRenamed(file);
  const oldPath = file.previousPath ?? file.path;
  const lines = [`diff --git a/${oldPath} b/${file.path}`];

  if (added) {
    lines.push("new file mode 100644");
  } else if (deleted) {
    lines.push("deleted file mode 100644");
  } else if (renamed) {
    if (file.hunks.length === 0) {
      lines.push("similarity index 100%");
    }
    lines.push(`rename from ${oldPath}`, `rename to ${file.path}`);
  }

  if (!renamed || file.hunks.length > 0) {
    lines.push(
      `--- ${added ? "/dev/null" : `a/${oldPath}`}`,
      `+++ ${deleted ? "/dev/null" : `b/${file.path}`}`,
    );
  }

  for (const hunk of file.hunks) {
    lines.push(hunk.header);
    lines.push(...hunk.lines.map(patchLine));
  }

  return `${lines.join("\n")}\n`;
}
