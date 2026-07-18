# UI smoke — Stage 17 (techguide promotion)

Verifies the techguide promote route end-to-end on the live daemon: the EXISTING
git-bisect-basics guide (produced by the stage 16 smoke — no new worker run
needed) promotes through the SAME dry-run → confirm → 🚀 pipeline as study
content and lands content-asserted at `/guides/git-bisect-basics`. Run on the
prod host with `NIGHTSHIFT_PROMOTE_ENABLED=true`.

## Steps

1. Host prerequisites (the stage 16 artifact — one-time check):

   ```sh
   ls ~/projects/git-bisect-basics/output/git-bisect-basics/techguide-config.json \
      ~/projects/git-bisect-basics/output/git-bisect-basics/guide/index.html   # both exist
   ```

2. In Webex, ask the bot to promote the guide. **Expect:** it runs the DRY RUN
   first and relays the plan — slug `git-bisect-basics`, url
   `https://www.<domain>/guides/git-bisect-basics` (never `/study-guides/`),
   the six steps validate/scan/stage/build/push/health, stage naming
   `public/guides/git-bisect-basics` + `src/content/guides/git-bisect-basics.yaml`
   — and asks for confirmation before executing. (CLI equivalent:
   `nightshift promote ~/projects/git-bisect-basics/output/git-bisect-basics`.)

3. Confirm in the conversation. **Expect:** the bot executes with `--yes`, the
   reply reports `running`, and it does NOT poll — the result arrives on its
   own.

4. **Expect on finish (minutes):** the 🚀 notice arrives carrying
   `https://www.<domain>/guides/git-bisect-basics`, and the promotion is live:

   ```sh
   nightshift promote --json ... # or: curl the daemon's /api/v1/promotions/git-bisect-basics
   ```

   `status=live`; the `health` step detail says `carrying the staged <title>`
   — the content assertion, not a bare 200.

5. Content-asserted live check (the point of this stage's health design):

   ```sh
   curl -sL https://www.<domain>/guides/git-bisect-basics | grep -c "<the guide's <title> text>"   # ≥ 1
   curl -sL https://www.<domain>/guides/no-such-guide | head -c 200   # the soft-404 fallback page — proves a bare 200 means nothing
   ```

6. Website repo check: the clone at `NSAF_WEBSITE_REPO` gained one commit
   `Add <Title> technical guide`, `src/content/guides/git-bisect-basics.yaml`
   holds title/slug/description/htmlFile/order, and `remarkable-paper-pro.yaml`
   still carries `order: 7` untouched.

7. Idempotency spot-check (optional): re-promote the same path (dry-run →
   confirm again). **Expect:** same slug re-lands live, the YAML keeps its
   `order`, and no duplicate promotion row appears.

## Failure triage

- `unrecognized content` naming both shapes → the guide dir is wrong (point at
  `output/git-bisect-basics/`, the dir holding `techguide-config.json`), or the
  deployed build predates stage 17.
- Plan shows `/study-guides/` → detection precedence regression: the techguide
  marker must beat residual sws artifacts — pull the daemon build/commit.
- Fails at `health` with `soft-404` in the detail while the page LOOKS live →
  the staged `<title>` text differs from what the CDN serves; check for an edge
  cache holding an old deploy (bounded 20 × 15s should outlast normal
  propagation).
- Fails at `stage` with `uncommitted changes` → an operator edit is sitting in
  the website clone; commit/stash it there and re-confirm.
- `NIGHTSHIFT_PROMOTE_ENABLED` off → the promote line is absent from the bot's
  preamble and the CLI rejects; this stage adds NO new flag (shared kill-switch
  is a frozen property of the site-promotion contract).
