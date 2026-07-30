---
name: euphony-annotate
description: Use when an agent running inside Euphony has created or revised a Markdown or HTML artifact that would benefit from direct human review before work continues.
---

# Euphony Annotate

Request review in the Euphony pane associated with the current agent.

## Workflow

1. Choose where the review file belongs:
   - For a review-only artifact, create a temporary directory with `mktemp -d`
     and write a `.md` or `.html` file inside it. This is the default.
   - Use a repository path only when the artifact is intended to remain in the
     repository.
2. Finish a coherent Markdown or HTML draft at that path.
3. Run `euphony annotate <path>` in the foreground. Do not background it.
4. Wait for the command to exit after the user sends comments.
5. Parse the JSON object from stdout at `result.comments`.
6. Locate selection feedback by `quote` first. Treat `startOffset` and
   `endOffset` as hints into rendered text, not source-file byte offsets.
7. Apply relevant feedback and continue the task. An empty comments array is
   explicit approval.

## Temporary Review File

Use a temporary directory so the review file can retain the extension required
by `euphony annotate`. Across agent tool calls:

1. Run `mktemp -d` and continue only if it succeeds.
2. Record the exact absolute path printed by the command.
3. Write the complete draft to `review.md` or `review.html` under that path.
4. Run `euphony annotate` with that exact file path.
5. After processing stdout, delete only the exact temporary directory created
   in step 1.

## Quick Reference

| Input | Meaning |
| --- | --- |
| Review-only artifact | File under a directory created by `mktemp -d` |
| Durable artifact | Intended repository path |
| `kind: "selection"` | Feedback attached to quoted rendered text |
| `kind: "global"` | Feedback about the whole artifact |
| `body` | Requested change or review note |

## Common Mistakes

- Do not use the command outside an Euphony terminal; it requires
  `EUPHONY_TERMINAL_ID`.
- Do not use unsupported files. Pass `.md`, `.markdown`, `.html`, or `.htm`.
- Do not put a review-only artifact in the repository.
- Do not continue while the command is waiting.
- Do not treat an empty comment list as missing feedback.
