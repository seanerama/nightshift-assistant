# 0017. Memory-graph extraction is a dedicated second turn in the retiring session

- **Status:** Accepted
- **Date:** 2026-07-29

## Context

The owner-authored memory-graph design (contracts/memory-graph.md, drafted
during the app-transport era, held until generative-UI shipped) needed one
open question settled before freezing: WHERE automatic fact extraction runs.
The draft had the existing rotation summary turn emit the fact block as a
second output — efficient (that turn holds the entire retiring conversation
in context) but asking one turn for three outputs (narrative summary, durable
prose, vocabulary-constrained JSON), and modifying `SUMMARY_PROMPT`, the
battle-tested prompt behind `memory/` promotion and seeding. The owner
studied the design space (multi-task output degradation, context economics,
chunking, idempotent-ingest dedup) and chose the two-turn architecture.

## Decision

- **Extraction is a SECOND, dedicated turn in the same retiring session**,
  sent after the summary turn completes: same full-conversation context, its
  own prompt carrying the rendered closed vocabulary + module
  extractionGuidance, emitting ONLY the delimited JSON fact block.
- **`SUMMARY_PROMPT` is never modified.** The summary/prose/seed path is
  byte-identical with the graph flag ON, not just OFF — an extraction failure
  degrades to zero facts, never to a changed summary. This upgrades the
  draft's flag-off-only safety property to a structural one.
- Extraction prompt quality is independently iterable: tuning it can never
  regress the summary.
- Cost accepted: one extra LLM turn per rotation (daily + manual — negligible,
  and the retiring session's context is already warm).
- **No transcript backfill.** Months of historical transcripts exist, but this
  project is a BLUEPRINT for future agents — one-off migration machinery has
  no place in a template. The `ingest()` door stays caller-agnostic (the
  contract states this), so an agent built from the blueprint can add a
  transcript-replay caller without a contract change if it ever needs one.
- **UI resources as graph entities: deferred with data** (the generative-UI
  brief's hook). v1 vocabulary stays people/project-focused; a UI-awareness
  module or guidance addition comes after retrieval exists and real usage
  shows the shape. Boundary note: the ui-state store (contracts/ui-state.md)
  is a DOCUMENT store owned by pages; the memory graph is a FACT store owned
  by the assistant — adjacent, never merged.

## Alternatives considered

- **Combined turn (the draft)** — rejected: multi-task degradation risk, a
  ~20-relation vocabulary inflating the summary prompt, and flag-on summary
  drift on the one prompt with the longest tuning history.
- **Transcript worker job as the primary path** — rejected: full transcript
  re-read cost per rotation, chunking with entity-coherence loss across
  chunk boundaries, and a registered job-type profile as a prerequisite
  (issue #81 shows the generic profile cannot carry it). Right shape for
  backfill — which is deliberately not wanted.
- **Per-turn extraction** — rejected: extraction on the conversational hot
  path, per-turn cost, noisy arc-less fragments; the contract's
  `remember`/`correct` verbs already cover immediate capture WITH owner
  intent, which is better signal.

## Consequences

- Rotation gains a turn and stays failure-isolated; the golden test for the
  dual-write stage becomes "summary output byte-identical in BOTH flag
  states" — stronger and simpler to assert than the draft's.
- The dedup story for multiple writers (extraction turn now, remember/correct
  later) rests on the contract's idempotent-ingest rule (duplicate → weight
  bump, cardinality-driven supersession) — unchanged from the draft.
- Re-baseline notes for the planner: migration number is 0011 (draft says
  0008); golden references are v0.15.0 (draft says Stage 23); stage-30's
  "extend SUMMARY_PROMPT" item becomes the extraction-turn item; consolidation
  and any sync remain REGISTERED job types with real permission profiles
  (issue #81), never `generic`.
