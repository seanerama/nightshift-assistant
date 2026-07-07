# Contract: promotion

- **Status:** frozen v1
- **Owner:** promotion module (daemon-resident; ADR 0008)

## Exposes

- `POST /api/v1/promote` (behind the control-api gates: kill-switch + bearer):
  ```
  { path: string,            // content dir, confined to $HOME/projects
    slug?: string,           // default: slugified basename
    title?: string,          // human title for the index/README
    confirm: boolean }       // false/absent → DRY RUN (plan only, no side effects)
  ```
  → `{ ok, promotion: PromotionRecord }` (dry run: `status:'planned'` + the step plan)
- `nightshift promote <path> [--slug s] [--title t] [--dry-run|--yes]` — 1:1 CLI face.
- **PromotionRecord** (persisted; the only representation of a promotion):
  ```
  { schema: 1, id, slug, title, sourcePath,
    status: 'planned'|'running'|'live'|'failed'|'removed',
    repoUrl: string|null, url: string|null,   // https://<slug>.<NSAF_DOMAIN>
    steps: Array<{ name, ok, detail }>,       // validate, scan, repo, coolify, route, dns, health
    createdAt, endedAt: ISO 8601|null, error: string|null }
  ```
- Exactly ONE live promotion per slug; re-promoting an existing slug updates the
  same target (repo push + Coolify rebuild), never a duplicate.

## Consumes

- Env (daemon-only; NEVER in any worker env — `workerEnv()` hard-blocks the
  prefixes): `COOLIFY_API_URL`, `COOLIFY_API_TOKEN`, `COOLIFY_PROJECT_UUID`,
  `COOLIFY_SERVER_UUID`, `COOLIFY_ENVIRONMENT`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`,
  `CF_TUNNEL_ID`, `CF_DNS_TOKEN`, `NSAF_DOMAIN`. Host `git` + `gh` (daemon user).
- `contracts/control-api.md` gates; `contracts/webex-ingress.md` send() for the
  completion notice.

## Schema / wire

**Pipeline (fixed order; each step recorded; first failure stops the run):**
1. **validate** — path confined to `$HOME/projects`; content shape recognized
   (study: `guides/*.html` or `textbook.md`; story: final video/PDF); generate
   `index.html` if absent (title + links).
2. **scan** — secret scan (filename patterns: .env*, *key*, credentials*, plus
   content patterns) → any hit ABORTS before git init.
3. **repo** — git init/commit → public GitHub repo `seanerama/<slug>` (create or
   push-update).
4. **coolify** — create-or-reuse static app on the existing project/server; set
   domain `<slug>.<NSAF_DOMAIN>`; trigger build; wait for success.
5. **route** — Cloudflare tunnel ingress route for the hostname (old-NSAF pattern).
6. **dns** — CNAME `<slug>` → tunnel, proxied.
7. **health** — GET `https://<slug>.<NSAF_DOMAIN>` until 200 (bounded wait).

**Gating:** `confirm:false` → steps are PLANNED and returned, nothing executes.
Kill-switch: `NIGHTSHIFT_PROMOTE_ENABLED` (default OFF) darkens endpoint + CLI.

## Versioning

Frozen at **v1**. Changes are **additive only** — a breaking change is a NEW
contract, not an edit (framework-spec §4.3). Every consumer depends on this shape.
