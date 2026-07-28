# Stage 25: App chat triad: messages 202, SSE resume, outbox poll, send fan-out

- **Type:** feature
- **Depends on:** 24

> **SUPERSEDED (2026-07-28) — do not build.** Folded into stage 24 by
> Intake/Planner Amendment 1: `agent-app-contract#v1.0.0` mandates `"chat"` in
> the manifest (`schemas/v1/manifest.json`, `contains: {"const": "chat"}`) and
> the conformance harness runs the chat-triad checks unconditionally, so the
> skeleton stage cannot reach harness exit 0 without the triad. Everything this
> spec required now lives, verbatim in substance, in
> `stage-instructions/stage-24-*.md` (§ "Chat triad"). Work item #61 closed as
> folded into #60. Stage 26's dependency re-pointed to 24. This file remains as
> the record of the original split and why it died.
