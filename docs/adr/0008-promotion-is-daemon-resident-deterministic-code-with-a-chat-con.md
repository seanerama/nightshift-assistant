# 0008. Promotion is daemon-resident deterministic code with a chat confirm gate

- **Status:** Accepted
- **Date:** 2026-07-07

## Context

The vision doc kept promotion ("deploy this to *.seanmahoney.ai") but deferred the
design. Operator decisions (2026-07-07): reuse the proven GitHub → Coolify →
Cloudflare pipeline; trigger from chat with an explicit confirm; public repos.
Content (studies/stories: static HTML + assets) promotes first; apps are a later,
harder act. The tension: promotion needs infrastructure credentials (Coolify API,
Cloudflare API, GitHub), and the security carryover (FIX-H3) forbids infra creds
in any worker session.

## Decision

- **Daemon-resident deterministic TypeScript** — promotion is a fixed pipeline
  (validate → secret-scan → repo → Coolify → CF route + DNS → health-check), not
  an LLM task. No claude worker ever holds infra creds; `workerEnv()` blocking
  extends to `CF_`/`COOLIFY_` prefixes. The old NSAF implementation
  (`flask-app/bot/commands.py` `cmd_promote`/`_promote_study`) is the reference.
- **Chat + confirm**: the assistant runs `nightshift promote --dry-run <dir>` →
  relays the plan (slug, URL, repo) → operator confirms in chat → `--yes` executes.
  The CLI/API require the explicit `--yes`/`confirm:true`; the session preamble
  forbids promoting without an operator confirmation in the conversation.
- **Public GitHub repos** guarded by a pre-push secret scan (FIX-M8 carryover):
  filename patterns + content scan; any hit aborts before anything leaves the box.
- Promotions are **persisted** (a `promotions` table) — slug, source, repo, URL,
  status, timestamps — so "what's live where" is queryable truth, not memory.

## Alternatives considered

- **A `promote` job type (claude worker with infra creds)** — violates the
  never-give-workers-infra-creds invariant; an LLM adds nondeterminism to the one
  flow that must be boring. Rejected.
- **Old-NSAF bridge** (register Nightshift projects into the old DB) — couples the
  new system to the deprecated core it exists to replace. Rejected.
- **New static host (CF Pages etc.)** — fewer moving parts but new accounts/creds;
  the Coolify+CF path is proven on this exact domain. Deferred.

## Consequences

- Coolify/CF/GitHub credentials join the daemon `.env` (locations in
  deploy-access.md) — daemon-only by construction.
- The promotion module shells out to `git`/`gh` as the daemon user; those must
  exist on the host (they do — old NSAF uses them).
- App promotion later extends the same contract with a different validator/build
  config — additive.
