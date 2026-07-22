/**
 * Promotion router (Stage 13): the ONE promote entry point behind
 * POST /api/v1/promote and `nightshift promote`. Content shape decides the
 * pipeline:
 *
 *   - TECHGUIDE-shaped (guide/index.html — the tg artifact contract; marker
 *     optional since v1.2, issue #43) → the
 *     WEBSITE pipeline's techguide path (site.ts, contracts/site-promotion.md
 *     v1.1) — lands at https://www.<domain>/guides/<slug>. Checked FIRST:
 *     the tg skill is an sws fork and residual sws artifacts (chapters/,
 *     guides/) appear in tg workdirs mid-run, so study detection must never
 *     capture a techguide (Stage 17).
 *   - STUDY-shaped (guides/*.html or textbook.md) → the WEBSITE pipeline
 *     (site.ts, contracts/site-promotion.md) — study content deploys INTO the
 *     Astro site at https://www.<domain>/study-guides/<slug>, never to a
 *     per-study subdomain (the Stage 11 mis-spec this stage fixes).
 *   - STORY-shaped (final video/PDF) → EXPLICIT rejection ("story promotion
 *     not yet designed") — deliberate, not accidental fall-through.
 *   - Anything else → rejected as unrecognized.
 *
 * The Stage 11 subdomain pipeline (pipeline.ts, contracts/promotion.md) is
 * retained for future APP promotion but is UNREACHABLE from here: no shape
 * routes to it, so study content can never plan GitHub/Coolify/subdomain
 * steps again (regression-tested).
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PromoteRequest, PromotionRecord } from '../types.js';
import {
  confineToProjects,
  isTechguideOutput,
  listGuides,
  listStoryArtifacts,
  PromotionError,
} from './index.js';
import type { Promoter } from './pipeline.js';

export interface PromotionRouterDeps {
  /** The website pipeline (site.ts) — the study route. */
  site: Promoter;
  /**
   * The subdomain pipeline (pipeline.ts) — reserved for apps. Wired so the
   * dependency is explicit, but no content shape currently routes to it.
   */
  subdomain: Promoter;
  /** Confinement root parent (test seam) — content must live in <home>/projects. */
  home?: string;
}

export function createPromotionRouter(deps: PromotionRouterDeps): Promoter {
  const { site, home = homedir() } = deps;

  return {
    async promote(req: PromoteRequest): Promise<PromotionRecord> {
      const sourcePath = confineToProjects(home, req.path);

      // Techguide BEFORE study (Stage 17 precedence hazard): a tg workdir may
      // still hold residual sws dirs (chapters/, guides/) — the authoritative
      // techguide marker wins so those never misroute to the study path.
      if (isTechguideOutput(sourcePath)) return site.promote(req);

      const isStudy =
        listGuides(sourcePath).length > 0 || existsSync(join(sourcePath, 'textbook.md'));
      if (isStudy) return site.promote(req);

      if (listStoryArtifacts(sourcePath).length > 0) {
        throw new PromotionError(
          `story promotion not yet designed — ${sourcePath} holds story artifacts and there is no story pipeline yet`,
        );
      }

      throw new PromotionError(
        `unrecognized content at ${sourcePath}: expected study output (guides/chapter-NN.html or textbook.md) or techguide output (guide/index.html)`,
      );
    },

    // Both pipelines persist to the same promotions store; either face of
    // get() reads the storage truth for a slug.
    get(slug: string): PromotionRecord | null {
      return site.get(slug);
    },
  };
}
