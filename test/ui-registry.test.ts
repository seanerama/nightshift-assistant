/**
 * Stages 31–32 UI registry module (contracts/generative-ui.md, ADR 0015)
 * against a migrated in-memory DB: install assigns v1 active for a new name
 * and the NEXT version (active, prior retained) for a taken one; activate()
 * flips the pointer to any retained version (rollback = re-activation);
 * versions()/get() expose the history; reserved/malformed names and unknown
 * requested tools refuse; and NOTHING is written on failed validation (there
 * is no unvalidated insert path) — including against an existing name, whose
 * active pointer and version count stay untouched. The invariants
 * UNIQUE(name, version) and one-active-row-per-name are proven at the SQL
 * level. The doors over this module are covered in test/ui-api.test.ts; the
 * MCP mapping in test/ui-mcp.test.ts; the full v1→v2→rollback round trip
 * over MCP in test/ui-versions.test.ts.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/migrate.js';
import {
  createUiRegistry,
  MCP_TOOL_NAMES,
  type UiRegistry,
  UiRegistryError,
  uiResourceUri,
} from '../src/ui/registry.js';
import { MIGRATIONS_DIR } from './helpers.js';

const GOOD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/good.html', import.meta.url)),
  'utf8',
);
const BAD_HTML = readFileSync(
  fileURLToPath(new URL('./fixtures/ui/bad-no-network.html', import.meta.url)),
  'utf8',
);

describe('ui registry (Stage 31, contracts/generative-ui.md)', () => {
  let db: Database.Database;
  let registry: UiRegistry;

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db, MIGRATIONS_DIR);
    registry = createUiRegistry(db);
  });

  afterEach(() => {
    db.close();
  });

  const rowCount = (): number =>
    (db.prepare('SELECT COUNT(*) AS n FROM ui_resources').get() as { n: number }).n;

  /** SQL-level invariant (contract): never two active rows for one name. */
  const assertOneActivePerName = (): void => {
    const offenders = db
      .prepare(
        'SELECT name, COUNT(*) AS n FROM ui_resources WHERE active = 1 GROUP BY name HAVING n > 1',
      )
      .all();
    expect(offenders).toEqual([]);
  };

  it('installs a valid page as version 1, active, with the frozen record shape', () => {
    const record = registry.install({
      name: 'good-page',
      html: GOOD_HTML,
      requestedTools: ['jobs_list', 'status'],
      provenance: 'test install',
    });
    // The frozen UiResourceRecord keys — html only on the read paths.
    expect(Object.keys(record).sort()).toEqual([
      'active',
      'createdAt',
      'grantedTools',
      'htmlBytes',
      'name',
      'provenance',
      'requestedTools',
      'version',
    ]);
    expect(record.name).toBe('good-page');
    expect(record.version).toBe(1);
    expect(record.active).toBe(true);
    expect(record.requestedTools).toEqual(['jobs_list', 'status']);
    // Zero-trust: no grant machinery exists until Stage 33 — ALWAYS [].
    expect(record.grantedTools).toEqual([]);
    expect(record.htmlBytes).toBe(Buffer.byteLength(GOOD_HTML, 'utf8'));
    expect(record.provenance).toBe('test install');
  });

  it('list() returns the active row without html; getByUri returns the exact html', () => {
    registry.install({ name: 'good-page', html: GOOD_HTML });
    const listed = registry.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.html).toBeUndefined();
    expect(listed[0]?.htmlBytes).toBe(Buffer.byteLength(GOOD_HTML, 'utf8'));

    const read = registry.getByUri(uiResourceUri('good-page', 1));
    expect(read?.html).toBe(GOOD_HTML);
    expect(registry.getByUri('ui://nightshift/good-page@v2')).toBeNull();
    expect(registry.getByUri('ui://nightshift/jobs@v1')).toBeNull(); // hand-authored, not registry
    expect(registry.getByUri('not-a-uri')).toBeNull();
  });

  it('install on a taken name assigns the next version, active — v1 retained (Stage 32)', () => {
    registry.install({ name: 'good-page', html: GOOD_HTML });
    const v2 = registry.install({ name: 'good-page', html: GOOD_HTML, provenance: 'iteration' });
    expect(v2.version).toBe(2);
    expect(v2.active).toBe(true);
    // Exactly two rows; the active pointer moved to v2 and ONLY v2.
    expect(rowCount()).toBe(2);
    assertOneActivePerName();
    expect(registry.list().map((r) => [r.name, r.version, r.active])).toEqual([
      ['good-page', 2, true],
    ]);
    // v1 is retained and still readable by exact uri (rollback needs the bytes).
    expect(registry.getByUri(uiResourceUri('good-page', 1))?.html).toBe(GOOD_HTML);
    expect(registry.versions('good-page').map((r) => [r.version, r.active])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('activate() flips the pointer back — rollback is re-activation, never deletion', () => {
    registry.install({ name: 'good-page', html: GOOD_HTML });
    registry.install({ name: 'good-page', html: GOOD_HTML });
    const rolledBack = registry.activate('good-page', 1);
    expect(rolledBack?.version).toBe(1);
    expect(rolledBack?.active).toBe(true);
    assertOneActivePerName();
    expect(registry.list().map((r) => [r.name, r.version])).toEqual([['good-page', 1]]);
    // Both versions still present and readable — nothing was deleted.
    expect(rowCount()).toBe(2);
    expect(registry.getByUri(uiResourceUri('good-page', 2))?.html).toBe(GOOD_HTML);
    // Activating the already-active version is a harmless no-op flip.
    expect(registry.activate('good-page', 1)?.active).toBe(true);
    assertOneActivePerName();
  });

  it('activate() returns null for an unknown name or version — pointer untouched', () => {
    registry.install({ name: 'good-page', html: GOOD_HTML });
    expect(registry.activate('good-page', 2)).toBeNull();
    expect(registry.activate('no-such-page', 1)).toBeNull();
    expect(registry.list().map((r) => [r.name, r.version, r.active])).toEqual([
      ['good-page', 1, true],
    ]);
    assertOneActivePerName();
  });

  it('versions()/get(): full ascending history without html; one version with html', () => {
    expect(registry.versions('no-such-page')).toEqual([]);
    expect(registry.get('no-such-page', 1)).toBeNull();
    registry.install({ name: 'good-page', html: GOOD_HTML });
    registry.install({ name: 'good-page', html: GOOD_HTML });
    const versions = registry.versions('good-page');
    expect(versions.map((r) => r.version)).toEqual([1, 2]);
    for (const record of versions) expect(record.html).toBeUndefined();
    expect(registry.get('good-page', 1)?.html).toBe(GOOD_HTML);
    expect(registry.get('good-page', 3)).toBeNull();
  });

  it('failed install against an EXISTING name leaves pointer and version count untouched', () => {
    registry.install({ name: 'good-page', html: GOOD_HTML });
    registry.install({ name: 'good-page', html: GOOD_HTML });
    expect(() => registry.install({ name: 'good-page', html: BAD_HTML })).toThrowError(
      /validation failed/,
    );
    // Transactionality: still exactly two rows, v2 still the one active row.
    expect(rowCount()).toBe(2);
    assertOneActivePerName();
    expect(registry.versions('good-page').map((r) => [r.version, r.active])).toEqual([
      [1, false],
      [2, true],
    ]);
  });

  it('UNIQUE(name, version) is schema-enforced, not just module-enforced', () => {
    registry.install({ name: 'good-page', html: GOOD_HTML });
    expect(() =>
      db
        .prepare(
          `INSERT INTO ui_resources (name, version, html, requested_tools, provenance, created_at, active)
           VALUES ('good-page', 1, 'x', '[]', '', 'now', 0)`,
        )
        .run(),
    ).toThrowError(/UNIQUE/);
  });

  it('rejects reserved and malformed names with 422-shaped errors, nothing written', () => {
    for (const name of ['jobs', 'Bad', 'x', '9abc', '-abc', 'has space', `a${'b'.repeat(40)}`]) {
      let caught: unknown;
      try {
        registry.install({ name, html: GOOD_HTML });
      } catch (err) {
        caught = err;
      }
      expect(caught, name).toBeInstanceOf(UiRegistryError);
      expect((caught as UiRegistryError).status, name).toBe(422);
      // Name rejections are not validation failures — no verdict attached.
      expect((caught as UiRegistryError).verdict, name).toBeUndefined();
    }
    expect(rowCount()).toBe(0);
  });

  it('rejects requestedTools outside the frozen MCP catalog', () => {
    expect(MCP_TOOL_NAMES).toEqual([
      'status',
      'jobs_list',
      'jobs_submit',
      'jobs_kill',
      'session_rotate',
    ]);
    expect(() =>
      registry.install({ name: 'good-page', html: GOOD_HTML, requestedTools: ['jobs_promote'] }),
    ).toThrowError(/unknown requested tool/);
    expect(rowCount()).toBe(0);
  });

  it('failed validation throws WITH the verdict and writes nothing', () => {
    let caught: unknown;
    try {
      registry.install({ name: 'bad-page', html: BAD_HTML });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UiRegistryError);
    const verdict = (caught as UiRegistryError).verdict;
    expect(verdict?.valid).toBe(false);
    expect(verdict?.violations.map((v) => v.rule)).toContain('no-network');
    expect(rowCount()).toBe(0);
  });

  it('validate() is a pure dry-run — verdicts either way, never a row', () => {
    expect(registry.validate(GOOD_HTML).valid).toBe(true);
    expect(registry.validate(BAD_HTML).valid).toBe(false);
    expect(rowCount()).toBe(0);
  });
});
