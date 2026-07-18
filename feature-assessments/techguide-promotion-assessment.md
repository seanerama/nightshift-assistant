# Assessment: Techguide promotion (stage 17)

- **Request origin:** live gap, 2026-07-18 — the owner asked the bot to promote the
  reMarkable techguide; `nightshift promote` rejected it ("unrecognized content"),
  exactly as stage 16 deferred. The promotion was performed manually from the
  workstation the same day (website commit `2ba563e`, verified live at
  `/guides/remarkable-paper-pro/`), which doubles as the reference implementation.
- **Decision:** ACCEPT as Stage 17 (single stage: one new route + staging path in
  the existing promotion module, contract amended additively).

## Claim / reality table (verified 2026-07-18)

| Claim | Reality |
|---|---|
| `nightshift promote` rejects techguide output | Confirmed — `route.ts` recognizes only study shape (`guides/*.html` at content root or `textbook.md`); everything else → PromotionError "unrecognized" |
| Completed tg output cannot be misrouted as study today | Confirmed for the finished reMarkable output (no `guides/` dir at completion) — BUT `chapters/`+`guides/` dirs were observed in the same workdir MID-RUN (sws-fork scaffolding), so precedence hazard is real; spec mandates techguide-detection-first keyed on `techguide-config.json` |
| The bot's proposed fix (push-capable `guide-promote` job type) | REJECTED — ADR 0008: promotion credentials are daemon-only; workers never push. The bot itself declined to extend `bypassPermissions`; the daemon promotion pipeline is the designed seam |
| Contract impact | `site-promotion.md` frozen v1 with "additive only" versioning; techguide is the same seam + a new shape → additive v1.1 amendment written in this plan (no consumer breaks; study behavior byte-unchanged) |
| Website repo supports the target layout | Confirmed live — `src/content/guides/` collection + `public/guides/` + `guides.astro` listing; the manual promotion required zero page code |
| Health-check trap | Confirmed live — host serves a 200 fallback for unknown paths (fooled today's first verification) and 308-redirects `.html`/`index.html` to clean URLs; new check must follow redirects and assert the staged `<title>`. Study's own soft-404 bug stays in open issue #33 |
| Daemon env ready | `NSAF_WEBSITE_REPO`/`BUN_PATH`/`NSAF_DOMAIN` already consumed by the live study route (stage 13) — no new secrets or env |

## Alternatives considered

- **Push-capable job type** (bot's offer): violates ADR 0008 credential boundary;
  rejected.
- **Keep it manual** (recipe on the workstation): works but defeats the
  chat-dispatched loop the owner is exercising (guide job → 🚀 promote from Webex);
  rejected as steady state, retained as the documented fallback.
- **New contract instead of amendment:** unnecessary — no breaking change; the
  contract's own versioning rule says additive edits stay in place.

## Notes for the builder

- Idempotency edge: `remarkable-paper-pro.yaml` (order 7) already exists from the
  manual run — re-promote of that slug must keep order 7 and overwrite files in
  place.
- UI-smoke reuses the already-produced git-bisect-basics guide on the prod host —
  no new worker run needed to exercise a live promote.
