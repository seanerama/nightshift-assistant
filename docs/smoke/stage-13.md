# UI smoke — Stage 13 (study promotion → www.<domain>/study-guides via the Astro website)

Verifies the rerouted study-promotion flow on the live daemon with the REAL
website repo: dry-run through chat now targets the WEBSITE (never a
subdomain), explicit confirm, the 6 recorded site steps (validate, scan,
stage, build, push, health), the live www URL, shared-repo safety, and
idempotent re-promote. First real subject: the finished subnetting study.

Prereqs on the host `.env`: everything Stage 11 required
(`NIGHTSHIFT_CONTROL_ENABLED=true`, `NIGHTSHIFT_PROMOTE_ENABLED=true`, the ten
infra vars) PLUS the Stage 13 pair:

- `NIGHTSHIFT_WEBSITE_REPO` — local clone of the Astro website repo (the host
  value mirrors the old `NSAF_WEBSITE_REPO`); the daemon user can
  `git pull`/`git push` it.
- `NIGHTSHIFT_BUN_PATH` — optional; defaults to `bun` (mirrors old
  `BUN_PATH`). `bun run build` must work in the website repo as the daemon
  user.

## 0. Fail-fast sanity (before the real run)

1. Temporarily unset `NIGHTSHIFT_WEBSITE_REPO` (promote still enabled) and
   restart: **expect** the daemon refuses to start, naming
   `NIGHTSHIFT_WEBSITE_REPO`. Point it at a non-git dir: **expect** "not a git
   clone". Restore the real clone; the daemon starts.
2. Note the website repo's current HEAD for later comparison:
   `git -C $NIGHTSHIFT_WEBSITE_REPO rev-parse --short HEAD`.

## 1. Dry run via chat — the reproduction, fixed

1. In Webex: *"promote the subnetting study"*.
2. **Expect:** the session runs `nightshift promote <dir>` (NO `--yes`) and
   relays the plan — slug, url
   `https://www.<NSAF_DOMAIN>/study-guides/<slug>`, repo = the WEBSITE repo's
   remote, and the six planned steps (validate, scan, stage, build, push,
   health). It must ASK for confirmation, not execute.
3. **Regression check (the Stage 11 bug):** the plan contains NO
   `repo`/`coolify`/`route`/`dns` steps, no `seanerama/<slug>` repo, and no
   `https://<slug>.<NSAF_DOMAIN>` URL anywhere.
4. Spot-check zero side effects over SSH: `git -C $NIGHTSHIFT_WEBSITE_REPO
   status --porcelain` is empty and HEAD is unchanged;
   `sqlite3 data/nightshift.db "SELECT slug,status FROM promotions"` shows the
   slug as `planned`.

## 2. Confirm and watch the 6 steps

1. Reply *"yes, promote it"*.
2. **Expect:** the session runs the same command with `--yes` and reports the
   promotion is running in the background (it must NOT poll).
3. Within a few minutes (bounded health wait: 20 × 15s after the push) a
   `🚀 **<title>** — promotion `<slug>` is live` notice arrives with the www
   URL. The promotions row is `live` with 6 ok steps
   (`SELECT status, steps FROM promotions WHERE slug='<slug>'`).
4. Open `https://www.<NSAF_DOMAIN>/study-guides/<slug>` — the guide card page
   renders with the extracted chapter titles; open a chapter and confirm the
   DARK theme (background `#0a0a0f`, not `#fafafa`). If the study has a
   textbook, `/study-guides/<slug>/textbook` renders it.
5. Inspect the website repo: `git -C $NIGHTSHIFT_WEBSITE_REPO log -1` shows
   `Add <title> study guide (<N> chapters)` and the commit touches ONLY
   `public/study-guides/<slug>/`, `src/content/studyGuides/<slug>.yaml` (and
   `src/content/textbooks/<slug>.md` when a textbook exists).

## 3. Shared-repo safety

1. **Existing guides still render:** open `https://www.<NSAF_DOMAIN>/study-guides`
   and one PRE-EXISTING guide — both load exactly as before the promote.
2. **Dirty-repo refusal:** create a scratch file in the website repo
   (`touch $NIGHTSHIFT_WEBSITE_REPO/wip.md`), dry-run + confirm again from
   chat. **Expect:** the run FAILS at the `stage` step, the error names
   `wip.md`, nothing was written or pushed, and the failure 🚀 notice arrives.
   Remove the scratch file.

## 4. Re-promote is idempotent

1. Touch the study content (e.g. edit a line in one chapter), dry-run again,
   confirm again.
2. **Expect:** the SAME promotions row updates (still exactly one row for the
   slug), the same `order:` in `<slug>.yaml` (position on the listing page
   unchanged), the guide files are overwritten in place, a second commit lands
   on the website repo, and the 🚀 notice arrives again. No duplicate YAML, no
   `<slug>.<NSAF_DOMAIN>` DNS/Coolify artifacts ever appear.

## 5. Story rejection is explicit

In Webex: *"promote the <finished-story> project"*. **Expect:** the reply
relays the API's 400 — "story promotion not yet designed" — and nothing is
persisted for the story slug (`SELECT slug FROM promotions` unchanged).
