import { parsePatchFiles } from "@pierre/diffs";
import { expect, test } from "vitest";
import type { GitChangedFile } from "../types";
import { gitChangedFileToPatch } from "./gitChangesPatch";

function assertSingleFilePatch(patch: string, name: string): void {
  const parsed = parsePatchFiles(patch, undefined, true);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.files).toHaveLength(1);
  expect(parsed[0]?.files[0]?.name).toBe(name);
}

test("reconstructs a modified file patch and preserves metadata lines", () => {
  const file: GitChangedFile = {
    path: "src/app.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    hunks: [{
      header: "@@ -1,2 +1,2 @@ function render",
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: "context", oldLine: 1, newLine: 1, content: "const ready = true;" },
        { kind: "deletion", oldLine: 2, content: "return before;" },
        { kind: "addition", newLine: 2, content: "return after;" },
        { kind: "meta", content: "\\ No newline at end of file" },
      ],
    }],
  };

  const patch = gitChangedFileToPatch(file);

  expect(patch).toBe(
    "diff --git a/src/app.ts b/src/app.ts\n" +
      "--- a/src/app.ts\n" +
      "+++ b/src/app.ts\n" +
      "@@ -1,2 +1,2 @@ function render\n" +
      " const ready = true;\n" +
      "-return before;\n" +
      "+return after;\n" +
      "\\ No newline at end of file\n",
  );
  assertSingleFilePatch(patch, "src/app.ts");
});

test("reconstructs an added file patch against /dev/null", () => {
  const file: GitChangedFile = {
    path: "draft file.md",
    status: "added",
    additions: 1,
    deletions: 0,
    hunks: [{
      header: "@@ -0,0 +1 @@",
      oldStart: 0,
      newStart: 1,
      lines: [{ kind: "addition", newLine: 1, content: "# Draft" }],
    }],
  };

  const patch = gitChangedFileToPatch(file);

  expect(patch).toBe(
    "diff --git a/draft file.md b/draft file.md\n" +
      "new file mode 100644\n" +
      "--- /dev/null\n" +
      "+++ b/draft file.md\n" +
      "@@ -0,0 +1 @@\n" +
      "+# Draft\n",
  );
  assertSingleFilePatch(patch, "draft file.md");
});

test("reconstructs a deleted file patch against /dev/null", () => {
  const file: GitChangedFile = {
    path: "old.md",
    status: "deleted",
    additions: 0,
    deletions: 1,
    hunks: [{
      header: "@@ -1 +0,0 @@",
      oldStart: 1,
      newStart: 0,
      lines: [{ kind: "deletion", oldLine: 1, content: "# Old" }],
    }],
  };

  const patch = gitChangedFileToPatch(file);

  expect(patch).toBe(
    "diff --git a/old.md b/old.md\n" +
      "deleted file mode 100644\n" +
      "--- a/old.md\n" +
      "+++ /dev/null\n" +
      "@@ -1 +0,0 @@\n" +
      "-# Old\n",
  );
  assertSingleFilePatch(patch, "old.md");
});

test("reconstructs a pure rename with rename metadata", () => {
  const file: GitChangedFile = {
    path: "new name.txt",
    previousPath: "old name.txt",
    status: "renamed",
    additions: 0,
    deletions: 0,
    hunks: [],
  };

  const patch = gitChangedFileToPatch(file);

  expect(patch).toBe(
    "diff --git a/old name.txt b/new name.txt\n" +
      "similarity index 100%\n" +
      "rename from old name.txt\n" +
      "rename to new name.txt\n",
  );
  assertSingleFilePatch(patch, "new name.txt");
});

test("keeps a changed rename's old and new file headers", () => {
  const file: GitChangedFile = {
    path: "new.txt",
    previousPath: "old.txt",
    status: "renamed",
    additions: 1,
    deletions: 1,
    hunks: [{
      header: "@@ -1 +1 @@",
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: "deletion", oldLine: 1, content: "old" },
        { kind: "addition", newLine: 1, content: "new" },
      ],
    }],
  };

  const patch = gitChangedFileToPatch(file);

  expect(patch).toContain("rename from old.txt\nrename to new.txt\n");
  expect(patch).toContain("--- a/old.txt\n+++ b/new.txt\n");
  assertSingleFilePatch(patch, "new.txt");
});
