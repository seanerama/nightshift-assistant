# UI smoke — Stage 11 (content promotion: study/story → *.seanmahoney.ai)

Verifies the operator-visible promotion flow on the live daemon with REAL
credentials: dry-run through chat, explicit confirm, the 7 recorded steps, the
live URL, idempotent re-promote, and the worker-env credential block. First
real subject: the finished subnetting study.

Prereqs on the host `.env`: `NIGHTSHIFT_CONTROL_ENABLED=true`,
`NIGHTSHIFT_PROMOTE_ENABLED=true`, and all ten infra vars set
(`COOLIFY_API_URL`, `COOLIFY_API_TOKEN`, `COOLIFY_PROJECT_UUID`,
`COOLIFY_SERVER_UUID`, `COOLIFY_ENVIRONMENT`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`,
`CF_TUNNEL_ID`, `CF_DNS_TOKEN`, `NSAF_DOMAIN`) — the daemon refuses to start
with any missing. `git` + `gh` work as the daemon user (`gh auth status`).

## 0. Kill-switch sanity (before flipping it on)

With `NIGHTSHIFT_PROMOTE_ENABLED` unset/false, over SSH:

```sh
nightshift promote ~/projects/<subnetting-study-dir>
# expect: error mentioning NIGHTSHIFT_PROMOTE_ENABLED, exit 1
```

Then set it true (with the ten vars), restart, and confirm the daemon starts.

## 1. Dry run via chat

1. In Webex: *"promote the subnetting study"*.
2. **Expect:** the session runs `nightshift promote <dir>` (NO `--yes`) and
   relays the plan — slug, `https://<slug>.<NSAF_DOMAIN>` URL, the
   `seanerama/<slug>` repo, and the seven planned steps (validate, scan, repo,
   coolify, route, dns, health). It must ASK for confirmation, not execute.
3. Spot-check zero side effects over SSH: no `.git` appeared in the content
   dir; `sqlite3 data/nightshift.db "SELECT slug,status FROM promotions"`
   shows the slug as `planned`.

## 2. Confirm and watch the 7 steps

1. Reply *"yes, promote it"*.
2. **Expect:** the session runs the same command with `--yes` and reports the
   promotion is running in the background (it must NOT poll).
3. Within a few minutes a `🚀 **<title>** — promotion `<slug>` is live` notice
   arrives with the URL + repo. The promotions row is `live` with 7 ok steps
   (`SELECT status, steps FROM promotions WHERE slug='<slug>'`).
4. Open `https://<slug>.<NSAF_DOMAIN>` in a browser — the study index page
   loads (generated title + chapter guide links + textbook link) and the
   chapter pages render.
5. Check the public repo exists: `https://github.com/seanerama/<slug>`.

## 3. Re-promote is idempotent

1. Touch the content (e.g. edit a line in `textbook.md`), then in chat:
   dry-run again, confirm again.
2. **Expect:** the SAME promotions row updates (still exactly one row for the
   slug), the repo step says "updated" (push, not create), the coolify step
   says "reusing app", the route step says "already exists", and the 🚀 notice
   arrives again. No duplicate Coolify app, tunnel rule, or DNS record.

## 4. Secret-scan abort (safe to run against a scratch dir)

```sh
mkdir -p ~/projects/scan-probe/guides && echo '<p>hi</p>' > ~/projects/scan-probe/guides/chapter-01.html
echo 'SECRET=do-not-publish-me-ever' > ~/projects/scan-probe/.env
nightshift promote ~/projects/scan-probe --yes
```

**Expect:** the record lands `failed` at step `scan` listing `.env`, a 🚀
FAILED notice arrives, and NO `~/projects/scan-probe/.git` was created —
nothing left the box. Clean up: `rm -rf ~/projects/scan-probe` and the row if
desired.

## 5. Worker env still lacks infra creds

Submit an env-dump job and inspect the result (Stage 4 pattern):

```sh
nightshift submit --type generic --title "env dump" \
  --instruction "run env | sort > worker-env.txt and write the sentinel" \
  --workdir ~/projects/scratch
grep -E 'CF_|COOLIFY_|WEBEX_|NIGHTSHIFT_' ~/projects/scratch/worker-env.txt
# expect: NO matches — the promotion creds never reach a worker
```

## Failure triage

- Dry run rejects the dir → it must be inside `~/projects` and look like a
  study (`guides/*.html` or `textbook.md`) or story (`*final.mp4` / `*.pdf`).
- `failed` at `repo` → check `gh auth status` and git identity
  (`git config user.email`) for the daemon user.
- `failed` at `coolify` → verify `COOLIFY_API_URL` reachable from the host and
  the project/server/environment uuids (the old NSAF `.env` has the working
  values).
- `failed` at `health` after route+dns ok → usually propagation; re-promote
  (idempotent) after a minute, or check the tunnel ingress in the Cloudflare
  dashboard.
- Notice never arrives → message the bot once (owner room), check daemon logs.
