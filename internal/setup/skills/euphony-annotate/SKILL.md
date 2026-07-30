---
name: euphony-annotate
description: Use when an agent running inside Euphony has created or revised a Markdown or HTML artifact that would benefit from direct human review before work continues.
---

# Euphony Annotate

Request review in the Euphony pane associated with the current agent.

## Workflow

1. Finish a coherent Markdown or HTML draft on disk.
2. Run `euphony annotate <path>` in the foreground. Do not background it.
3. Wait for the command to exit after the user sends comments.
4. Parse the JSON object from stdout at `result.comments`.
5. Locate selection feedback by `quote` first. Treat `startOffset` and
   `endOffset` as hints into rendered text, not source-file byte offsets.
6. Apply relevant feedback and continue the task. An empty comments array is
   explicit approval.

## Quick Reference

| Input | Meaning |
| --- | --- |
| `kind: "selection"` | Feedback attached to quoted rendered text |
| `kind: "global"` | Feedback about the whole artifact |
| `body` | Requested change or review note |

## Common Mistakes

- Do not use the command outside an Euphony terminal; it requires
  `EUPHONY_TERMINAL_ID`.
- Do not use unsupported files. Pass `.md`, `.markdown`, `.html`, or `.htm`.
- Do not continue while the command is waiting.
- Do not treat an empty comment list as missing feedback.
