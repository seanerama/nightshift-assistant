/**
 * Stage 31 UI validator (contracts/generative-ui.md, ADR 0014): the frozen
 * eight-rule deterministic static analysis over candidate single-file pages.
 * One known-BAD fixture per rule id — each must fail with EXACTLY its rule
 * (any second rule id in the verdict means the fixture no longer pins that
 * rule) — one trivial known-GOOD page, and the drift detector: the
 * hand-authored jobs dashboard (src/transport/app/resources/jobs-v1.html)
 * must PASS, or the validator has drifted from what
 * nightshift-client/contracts/ui-bridge.md actually allows.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UI_RULES, UI_SIZE_CAP_BYTES, validateUiHtml } from '../src/ui/validator.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/ui/${name}`, import.meta.url)), 'utf8');

const JOBS_V1_PATH = fileURLToPath(
  new URL('../src/transport/app/resources/jobs-v1.html', import.meta.url),
);

/** The distinct rule ids a verdict carries, sorted — the fixture pin. */
const ruleIds = (html: string): string[] =>
  [...new Set(validateUiHtml(html).violations.map((v) => v.rule))].sort();

describe('ui validator (Stage 31, contracts/generative-ui.md)', () => {
  it('exposes the frozen rule ids, exactly and in contract order', () => {
    expect([...UI_RULES]).toEqual([
      'single-file',
      'no-network',
      'no-storage',
      'no-navigation',
      'bridge-only',
      'degradable-render',
      'size-cap',
      'well-formed',
    ]);
  });

  describe('one known-BAD fixture per rule — each fails with exactly its rule', () => {
    for (const rule of UI_RULES) {
      it(`bad-${rule}.html → { valid: false, violations: [${rule}] } only`, () => {
        const html = fixture(`bad-${rule}.html`);
        const verdict = validateUiHtml(html);
        expect(verdict.valid).toBe(false);
        // Every violation names THIS rule and no other — the fixture pins
        // one rule id (a second id = the fixture stopped isolating the rule).
        expect(ruleIds(html)).toEqual([rule]);
        // Each violation carries a human detail (the revise loop reads it).
        for (const v of verdict.violations) expect(v.detail).toBeTruthy();
      });
    }

    it('bad-size-cap.html really is over the 256 KB cap', () => {
      expect(Buffer.byteLength(fixture('bad-size-cap.html'), 'utf8')).toBeGreaterThan(
        UI_SIZE_CAP_BYTES,
      );
    });
  });

  it('good.html passes every rule', () => {
    expect(validateUiHtml(fixture('good.html'))).toEqual({ valid: true, violations: [] });
  });

  it('DRIFT DETECTOR: the hand-authored jobs dashboard passes every rule', () => {
    // jobs-v1.html is certified against ui-bridge.md by Stage 28's tests and
    // live smoke. If the validator rejects it, the validator is wrong — it
    // has drifted stricter than the contract it enforces.
    const verdict = validateUiHtml(readFileSync(JOBS_V1_PATH, 'utf8'));
    expect(verdict.violations).toEqual([]);
    expect(verdict.valid).toBe(true);
  });

  it('is deterministic: the same input yields the same verdict object', () => {
    const html = fixture('bad-no-network.html');
    expect(validateUiHtml(html)).toEqual(validateUiHtml(html));
  });
});
