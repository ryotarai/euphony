# Summary Generation Additional Prompt

## Goal

Let users add workspace-wide instructions to every generated agent summary, save those instructions with the existing application settings, and edit them from the Settings dialog.

## Scope and assumptions

- The instruction applies to every summary generation, regardless of whether the selected provider is Claude or Codex.
- The setting is workspace-wide, matching the existing Summary provider setting; it is not per-terminal or per-agent.
- An empty value disables the extra instruction and restores the built-in prompt behavior.
- Existing databases migrate the new setting to an empty string without changing any other saved settings.
- The service continues to enforce its existing total prompt-size bound. The additional text is bounded independently before it is inserted into the prompt.

## Design

### Persistence and API

Extend `session.Settings` with `AgentSummaryPrompt string` and persist it in a new `settings.agent_summary_prompt` SQLite column. The migration advances the schema from version 11 to 12 and uses an empty string as the default. `GET /api/settings` returns the field and `PATCH /api/settings` accepts it, preserving the current value when an older client omits the field while allowing an explicit empty string to clear it.

The server validates the setting as UTF-8 text no longer than 8,000 runes. The value is saved as entered so intentional line breaks remain available to the model. The existing one-megabyte JSON request limit remains the outer transport guard.

### Prompt data flow

When the summary service creates a prompt, it reads the current `AgentSummaryPrompt` alongside the selected provider. `BuildPrompt` receives the additional text and renders it immediately after the built-in rules and before the session context:

```text
Additional instructions from the workspace owner:
<configured text>
```

The section is omitted when the setting is empty. The configured text is bounded to 8,000 runes and the final prompt remains capped at the existing `maxPromptBytes` limit. Existing transcript and terminal sanitization remains unchanged.

### Web UI

Add `agentSummaryPrompt` to the TypeScript `Settings` type, defaults, load/open/save draft synchronization, and PATCH payload. In the existing Settings dialog, place an accessible multi-line textarea directly below Summary provider. Use quiet, monospace-leaning helper copy consistent with the terminal workspace UI:

```text
Additional summary instructions
Optional guidance added to every agent summary.
```

The textarea uses the existing field primitives and a modest fixed minimum height so longer instructions remain comfortable without making the dialog unwieldy. It exposes the server limit with `maxLength`, while the API remains the source of truth for validation errors.

## Error handling

- A missing field in a PATCH request preserves the stored value for backwards compatibility.
- An explicit empty field clears the setting.
- Overlong input returns the existing `400 invalid_settings` response; the current Settings error surface remains unchanged because this field has no client-side parser requirement beyond the native `maxLength`.
- A summary generation failure still follows the existing error and previous-summary preservation path.

## Testing

- SQLite tests verify the default, migration to version 12, save/load round-trip, and reopen persistence.
- Server tests verify the settings response includes the field, valid text persists, omitted text preserves the previous value, and overlong text is rejected.
- Summary prompt tests verify the additional text is included, empty text is omitted, and the final prompt remains bounded.
- React tests verify the textarea loads, edits, clears, and is included in the PATCH body.
- Run focused TDD tests first, then the full Go suite, Web suite, typecheck, and production build.

## Self-review

- No placeholder requirements remain; the setting name, migration version, size bound, prompt placement, UI label, and test cases are explicit.
- The persistence, API, generation, and UI sections use the same field name and empty-value semantics.
- The scope is limited to one existing settings path and one existing prompt builder; no provider-specific configuration or per-terminal state is introduced.
