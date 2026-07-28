/**
 * Stage 31 UI registry module (contracts/generative-ui.md, ADR 0015) against
 * a migrated in-memory DB: install assigns v1 active for a new name, refuses
 * a taken name cleanly (next-version install is Stage 32) with NOTHING
 * written, refuses reserved/malformed names and unknown requested tools, and
 * NEVER writes on failed validation (there is no unvalidated insert path).
 * The schema invariant UNIQUE(name, version) is proven live by a raw
 * duplicate insert. The doors over this module are covered in
 * test/ui-api.test.ts; the MCP mapping in test/ui-mcp.test.ts.
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

  it('refuses a taken name cleanly — next-version install is Stage 32 — and writes nothing', () => {
    registry.install({ name: 'good-page', html: GOOD_HTML });
    expect(() => registry.install({ name: 'good-page', html: GOOD_HTML })).toThrowError(
      /already registered.*Stage 32/s,
    );
    // No corruption: still exactly the one v1 row, still active.
    expect(rowCount()).toBe(1);
    expect(registry.list().map((r) => [r.name, r.version, r.active])).toEqual([
      ['good-page', 1, true],
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
