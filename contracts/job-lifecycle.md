# Contract: job-lifecycle

- **Status:** frozen v1
- **Owner:** job-runner module

## Exposes

- **submit(job) → JobRecord** — start (or queue) a background worker session:
  ```
  submit: {
    schema: 1,
    type: string,             // 'app-build' | 'story' | 'study' | 'brief' | 'research' | ... (open set)
    title: string,
    instruction: string,      // the worker session's task
    workdir: string,          // project directory the worker runs in
    env: 'minimal'            // workers ALWAYS get the default-deny allow-list env (FIX-H3); no override
  }
  ```
- **JobRecord** (persisted in SQLite; the only representation of a worker):
  ```
  {
    schema: 1,
    id: string, type: string, title: string,
    status: 'queued'|'running'|'succeeded'|'failed'|'killed',
    pid: number|null,         // live process id while running
    sessionId: string|null,   // worker's Claude session id
    workdir: string, logPath: string,
    attempts: number,         // bounded; cap exhaustion → terminal 'failed'
    createdAt/startedAt/endedAt: ISO 8601 | null,
    sentinelPath: string      // where the completion sentinel must appear
  }
  ```
- **kill(id)**, **get(id)**, **list(filter)** — operator controls (exposed to the
  assistant session as tools).
- **onFinish(JobRecord)** — event to the session manager/transport: every terminal
  transition produces exactly one operator notification (success or failure + log tail).

## Consumes

- The `claude` CLI for worker sessions, spawned with the **default-deny environment
  allow-list** — infra credentials (Coolify, Cloudflare, Postgres-admin, bot token,
  SMTP) are never present (security carryover FIX-H3).
- SQLite (ADR 0004): `jobs` table; guarded-transition helper.

## Schema / wire

**State machine (guarded; the ONLY legal transitions):**
```
queued → running | killed
running → succeeded | failed | killed
```
- Terminal states (`succeeded`, `failed`, `killed`) are FINAL — a late exit handler
  cannot overwrite them (ENH-02). Rejected transitions are logged, never applied.
- `attempts` is bounded (default 2): a failed launch increments it and re-queues until
  the cap, then terminal `failed`; every failure path releases its resources first
  (no infinite retry loops — FIX-C3).

**Completion sentinel (ENH-10):** a worker signals success ONLY by writing a JSON
sentinel file at `sentinelPath`:
```
{ schema: 1, status: 'success'|'failure', summary: string, outputs?: string[], url?: string, port?: number }
```
Exit code + sentinel are jointly authoritative: clean exit WITHOUT a sentinel = failed.
No progress heuristics, no log-grepping for URLs.

**Reconciliation (ENH-01):** on daemon startup and every poll tick, each `running`
record is checked against its `pid`. Dead process → run the exit routine (sentinel
check → succeeded/failed). This — not the row count — is what concurrency limits
count.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
