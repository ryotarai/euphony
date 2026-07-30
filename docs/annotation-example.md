# Project Aurora: Launch Brief

Project Aurora is a lightweight team dashboard designed to make daily priorities
visible without adding another meeting.

## Goals

- Help each teammate identify the day's most important task.
- Surface blockers before they become schedule risks.
- Keep status updates short enough to complete in under two minutes.

## Proposed Milestones

| Milestone | Deliverable | Target |
| --- | --- | --- |
| Prototype | Clickable dashboard with sample data | August 8 |
| Pilot | Private release for two internal teams | August 22 |
| Review | Pilot findings and launch recommendation | August 29 |

## Example Configuration

```yaml
dashboard:
  refresh_interval: 60s
  show_blockers: true
  daily_prompt: "What matters most today?"
```

## Open Questions

1. Should completed tasks remain visible until the end of the day?
2. Who owns follow-up when a blocker has no assigned responder?
3. Which pilot metrics should determine whether the project launches?

## Review Checklist

- [ ] The goals are specific and measurable.
- [ ] The milestones are realistic.
- [ ] The open questions have clear owners.

> Reviewer note: Select any sentence to leave targeted feedback, or add a
> global comment about the document as a whole.
