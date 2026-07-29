# Contract: memory-graph

- **Status:** frozen v1 (owner-authored draft reviewed and frozen 2026-07-29;
  extraction architecture settled by ADR 0017 — framework-spec §4.3: NEW
  contract, not an edit to `assistant-session`)
- **Owner:** memory-graph module (`src/memory/`)

Durable memory as a bi-temporal entity graph instead of a growing prose pile.
Two problems this exists to kill: the seed budget silently truncating memory as
it grows, and contradictory facts coexisting with no resolution. Facts are
never deleted — they are superseded, with provenance and an audit trail.

## Exposes

- **ingest(episode, facts) → IngestResult** — the ONE write door. The rotation
  ritual calls it with the structured block a DEDICATED EXTRACTION TURN emits in
  the retiring session, after the summary turn (ADR 0017: same full
  conversation context, separate prompt — `SUMMARY_PROMPT` is never modified).
  The door is caller-agnostic by design: future callers (in-turn
  remember/correct, or a transcript-replay job in an agent built from this
  blueprint) use the same shapes.
  ```
  EpisodeInput: {
    schema: 1,
    date: string,             // local YYYY-MM-DD (rotation's stamp)
    sessionId: string,
    summaryPath: string, transcriptPath: string
  }
  FactInput: {
    schema: 1,
    module: string,           // registered module id ('user-model' | a domain id)
    source: string,           // entity NAME as stated — resolution happens INSIDE
    sourceType: string,       // must be in the module's entityTypes
    relation: string,         // must be in the module's closed vocabulary
    target: string, targetType: string,
    statement: string,        // NL sentence — the thing later injected into context
    temporalHint?: string,    // free text from the model ('since March', 'as of today')
    confidence?: number       // 0..1, default 0.7
  }
  IngestResult: {
    schema: 1,
    episodeId: number,
    accepted: number, duplicates: number, superseded: number,
    offVocabulary: number,    // landed as RELATED_TO with raw_relation preserved
    rejected: Array<{ index: number, reason: string }>,
    entitiesCreated: number
  }
  ```
  Ingest is **best-effort and never blocks its caller**: a malformed or absent
  structured block yields `accepted: 0` plus a logged failure. Rotation completes
  regardless — same discipline as the summary turn (a wedged extraction must not
  prevent a session's retirement).

- **recall(query) → RecallResult** — bounded, entity-centric retrieval. This is
  what replaces full-context stuffing.
  ```
  RecallQuery: {
    schema: 1,
    text: string,             // the inbound message (entity resolution seed)
    modules?: string[],       // default: every registered module
    maxFacts?: number,        // default NIGHTSHIFT_MEMORY_RECALL_MAX_FACTS (40)
    maxBytes?: number         // default NIGHTSHIFT_MEMORY_RECALL_MAX_BYTES (8192)
  }
  RecallResult: {
    schema: 1,
    statements: string[],     // NL statements, rank order — the injectable payload
    facts: Array<{ id, module, relation, statement, score, observedAt }>,
    seedEntities: Array<{ id, name, type }>,
    truncated: boolean        // a cap dropped ranked-in facts
  }
  ```

- **profile(module?) → string** — the distilled core profile: top-N live facts
  for the owner entity by `score`, rendered as prose, bounded by
  `NIGHTSHIFT_MEMORY_PROFILE_MAX_BYTES` (default 4096). This — not the
  concatenation of `memory/` — is what a new session is seeded with once the
  retrieval stage lands. Returns `''` when the graph is empty, and the caller
  then falls back to `buildSeed()` (`src/session/seed.ts`) unchanged.

- **remember(statement, opts?) → IngestResult** / **correct(statement, opts?) →
  IngestResult** — first-class, IN-TURN corrections. Invalidation happens on the
  turn the owner states it, never deferred to the 04:00 ritual. `correct()`
  resolves the fact(s) the statement contradicts and sets `invalid_at` with
  `invalid_reason='corrected'` before inserting the replacement.

- **MemoryModule** — the domain-module interface (see *Domain modules* below) and
  its registry: **registerMemoryModule(m)**, **getMemoryModule(id)**,
  **knownMemoryModules() → string[]**.

- **CLI face** (`bin/nightshift`, 1:1 over the control API per ADR 0007 — the
  transport for retrieval is the CLI seam, NOT a new MCP server):
  - `nightshift memory remember "<fact>" [--module <id>]`
  - `nightshift memory correct "<fact>" [--module <id>]`
  - `nightshift memory recall "<text>" [--module <id>] [--json]`
  - `nightshift memory stats [--module <id>]` — entity/fact/episode counts, live
    vs superseded, off-vocabulary count, last ingest
  - `nightshift memory entity <name>` — one entity's live facts + provenance

## Consumes

- `contracts/assistant-session.md` v1 — consumed AS-IS. The rotation ritual's
  step 3 (durable-fact promotion) gains an **additive substep**: after the
  summary turn completes, a SECOND, dedicated extraction turn runs in the same
  retiring session and emits the structured fact block (ADR 0017). The summary
  turn and `SUMMARY_PROMPT` are untouched — the summary/prose path is
  byte-identical even with the graph flag ON (extraction-turn failure degrades
  to zero facts, never to a changed summary). `rotate()` and `RotationRecord`
  are unchanged; `memory/` + `logs/daily/` remain OWNED by the session manager
  and keep being written. The graph is a second consumer of the same retiring
  context, never a replacement writer.
- `contracts/job-lifecycle.md` v1 — consolidation ("sleep") runs as a registered
  job type via `submit()`, with no new lifecycle states. Domain-module external
  sync likewise runs as a registered job type (see `SyncSpec.jobType`).
- `contracts/control-api.md` v1 — `POST /api/v1/memory/remember`,
  `POST /api/v1/memory/correct`, `GET /api/v1/memory/recall`,
  `GET /api/v1/memory/stats` behind the existing kill-switch + bearer gates. The
  CLI is the only face the conversational session touches.
- SQLite (ADR 0004): migration ladder is the only DDL source; every migration
  additive. `better-sqlite3` + FTS5 (bundled). **No Neo4j. No embeddings in v1** —
  `sqlite-vec` is a later, separately-gated stage (trigger defined below).

## Schema / wire

### Tables

```sql
CREATE TABLE memory_entities (
  id         INTEGER PRIMARY KEY,
  module     TEXT NOT NULL,        -- registered module id
  type       TEXT NOT NULL,        -- from the module's entityTypes
  name       TEXT NOT NULL,        -- as first observed (display form)
  name_key   TEXT NOT NULL,        -- normalized: lowercased, trimmed, ws-collapsed
  aliases    TEXT,                 -- JSON array of name_keys (entity resolution)
  attrs      TEXT,                 -- JSON
  merged_into INTEGER REFERENCES memory_entities(id),  -- non-null = merged away
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_memory_entities_key ON memory_entities (module, type, name_key);

CREATE TABLE memory_facts (
  id          INTEGER PRIMARY KEY,
  module      TEXT NOT NULL,
  source_id   INTEGER NOT NULL REFERENCES memory_entities(id),
  relation    TEXT NOT NULL,       -- module vocabulary, or 'RELATED_TO'
  raw_relation TEXT,               -- what the model actually said when off-vocabulary
  vocab_ok    INTEGER NOT NULL DEFAULT 1,   -- 0 = fell back to RELATED_TO
  target_id   INTEGER NOT NULL REFERENCES memory_entities(id),
  statement   TEXT NOT NULL,       -- NL sentence; the thing injected into context
  valid_at    TEXT,                -- when the fact became true (temporalHint-derived)
  invalid_at  TEXT,                -- NULL = live. Set, never deleted.
  observed_at TEXT NOT NULL,       -- when we learned it
  invalid_reason TEXT,             -- 'superseded'|'corrected'|'decayed'|'merged'|NULL
  superseded_by INTEGER REFERENCES memory_facts(id),
  episode_id  INTEGER REFERENCES memory_episodes(id),
  origin      TEXT NOT NULL DEFAULT 'observed',  -- 'observed'|'inferred'|'synced'
  confidence  REAL NOT NULL DEFAULT 0.7,
  weight      REAL NOT NULL DEFAULT 1.0,
  retrieved_count  INTEGER NOT NULL DEFAULT 0,
  last_retrieved_at TEXT
);
CREATE INDEX idx_memory_facts_live ON memory_facts (module, source_id, relation)
  WHERE invalid_at IS NULL;
CREATE INDEX idx_memory_facts_target ON memory_facts (target_id) WHERE invalid_at IS NULL;

CREATE TABLE memory_episodes (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL, session_id TEXT NOT NULL,
  summary_path TEXT, transcript_path TEXT, created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE memory_fact_search USING fts5(
  statement, content='memory_facts', content_rowid='id'
);
-- External-content FTS5 requires sync triggers (insert/delete/update); they are
-- part of the same migration. FTS is a lexical INDEX, never a source of truth.

-- Created by the consolidation stage's own additive migration:
CREATE TABLE memory_proposals (
  id INTEGER PRIMARY KEY, module TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'relation'|'entity-type'|'merge'
  proposal TEXT NOT NULL,           -- JSON
  evidence_count INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'approved'|'rejected'
  created_at TEXT NOT NULL, decided_at TEXT
);
```

### Bi-temporal rules (the invariants)

- **Nothing is ever deleted.** `DELETE` on `memory_facts` and `memory_entities`
  is forbidden — supersession sets `invalid_at` + `invalid_reason`, and entity
  merges set `merged_into`. Every read path filters `invalid_at IS NULL` to get
  the live graph; the full row set is the audit trail.
- **Contradiction is per `(module, source_id, relation)`**, resolved against the
  relation's declared `cardinality`: `'one'` ⇒ a new fact supersedes the live one
  (`invalid_at` = new fact's `observed_at`, `invalid_reason='superseded'`,
  `superseded_by` = new id); `'many'` ⇒ the facts coexist.
- **Duplicate** (same source, relation, target, and equivalent statement) is NOT
  a new row: bump `weight` and refresh `observed_at` on the existing fact.
- **`origin` governs authority.** `'synced'` facts on a relation listed in the
  module's `SyncSpec.authoritative` may only be superseded by another sync — a
  conversational fact that contradicts one is recorded with lower confidence and
  flagged, never allowed to overwrite the source of truth. `'inferred'` facts
  (consolidation-derived) carry lower confidence and are cheaper to invalidate
  than `'observed'` ones.
- **Closed vocabulary, no free-form predicates.** A relation outside the module's
  list lands as `RELATED_TO` with `vocab_ok=0` and `raw_relation` preserved — the
  raw statement is never lost. Recurring off-vocabulary patterns are what
  consolidation turns into `memory_proposals`. Vocabularies are extended or
  deprecated under governance, **never mutated** — same rule as the contracts.

### Retrieval

Two tiers, both bounded — no path re-introduces full-context stuffing:

1. **Seed:** `profile()` — top-N live facts for the owner entity, prose-rendered,
   a few KB. Replaces the `memory/` concatenation in `seed.ts`.
2. **On demand:** `recall()` — resolve entities in the inbound text (exact
   `name_key` / alias match, then FTS5 over `statement`) → walk 1..`maxHops`
   from the seed entities along the module's `retrieval` shape → filter
   `invalid_at IS NULL` → rank → apply fact and byte caps → return statements.

```
score = weight × confidence × exp(-ln(2) × ageDays / halfLifeDays)
        ageDays     = now − observed_at
        halfLifeDays = NIGHTSHIFT_MEMORY_HALF_LIFE_DAYS (default 60)
```
Every returned fact gets `retrieved_count += 1` and `last_retrieved_at = now` —
that counter, not a guess, is what the decay pass reads.

**Decay:** consolidation downweights live facts unretrieved for
`NIGHTSHIFT_MEMORY_DECAY_DAYS` (default 90); below the weight floor (default 0.1)
they get `invalid_at` with `invalid_reason='decayed'`. Decayed facts remain
readable and are restorable by a later observation of the same fact.

### Domain modules

A module is a **declarative TypeScript object in a registry** — the same shape
precedent as `JobTypeEntry` (`src/jobs/types.ts`), not a class hierarchy and not
an external manifest file. Registration is code, so vocabulary changes go through
review like every other contract change.

```ts
export interface MemoryModule {
  /** Registry id — the `module` column value on every entity and fact it owns. */
  id: string;
  label: string;
  /** CLOSED entity-type vocabulary. Extraction may not invent types. */
  entityTypes: readonly string[];
  /** CLOSED relation vocabulary, ~15–30 entries. RELATED_TO is implicit and always legal. */
  relations: readonly RelationSpec[];
  /** Appended to the rotation extraction prompt: what to look for, what to ignore. */
  extractionGuidance: string;
  /** How recall() walks out from resolved seed entities. */
  retrieval: RetrievalSpec;
  /** Optional external source of truth. Absent = conversation-only module. */
  sync?: SyncSpec;
}

export interface RelationSpec {
  name: string;                    // UPPER_SNAKE: 'PREFERS', 'CONNECTED_TO'
  source: readonly string[];       // legal source entity types
  target: readonly string[];       // legal target entity types
  cardinality: 'one' | 'many';     // 'one' ⇒ a new fact supersedes the live one
  symmetric: boolean;              // NEAR: true. DEPENDS_ON: false.
  description: string;             // one line — goes verbatim into the extraction prompt
}

export interface RetrievalSpec {
  strategy: 'hierarchy' | 'lateral';
  /** hierarchy: relations walked upward for roll-up (Property→Block→Neighborhood→City). */
  containment?: readonly string[];
  maxHops: number;                 // 1–3
  maxFacts: number;
}

export interface SyncSpec {
  /** Registered job-lifecycle type that performs the pull. Sync is a JOB, never inline. */
  jobType: string;
  /** Relations the external source OWNS — conversation may not supersede these. */
  authoritative: readonly string[];
}
```

Two modules prove the interface is real rather than shaped around one case: a
**hierarchy** module (containment roll-up — `Property→Block→Neighborhood→City`,
`NEAR`/`SERVES`) and a **lateral** one (dense topology —
`Device→Interface CONNECTED_TO`, `DEPENDS_ON` chains, path and blast-radius
walks). `user-model` (shared: preferences, working style, projects, routines,
history) is module #1 and is conversation-only (no `SyncSpec`).

**Cross-module facts are legal** — `(Sean) -[RESPONSIBLE_FOR]-> (Core-Switch-01)`
spans `user-model` and a domain module. The fact's `module` is the module owning
the RELATION; both endpoint entities keep their own `module`.

### Gating

- Kill-switch `NIGHTSHIFT_MEMORY_GRAPH_ENABLED` (default OFF) darkens ingest,
  the CLI subcommands, and the API routes. With it off, rotation and seeding
  behave byte-identically to today.
- `NIGHTSHIFT_MEMORY_SEED_FROM_GRAPH` (default OFF, separate from the above)
  gates the `seed.ts` swap specifically, so graph population and the seed change
  can be enabled independently and rolled back independently.
- Extraction failure, ingest failure, and recall failure are all **non-fatal**:
  they log and degrade to today's behavior. Memory is an enhancement to the
  conversation, never a precondition for it.
- **Embeddings trigger (settled, not open):** `sqlite-vec` is added only when the
  eval harness shows FTS5 lexical recall below **0.8 recall@10** on the standing
  probe set across two consecutive runs. Absent that measurement, v1 stays
  lexical.

## Versioning

Frozen at **v1** on approval. Changes are **additive only** — a breaking change
is a NEW contract, not an edit (framework-spec §4.3). Additive here explicitly
includes: new modules, new relations/entity types within a module, new `origin`
values, and new optional `MemoryModule` fields. It explicitly excludes: removing
or renaming a relation (deprecate instead), changing a relation's `cardinality`
(that rewrites history — issue a new relation), and any destructive migration.
