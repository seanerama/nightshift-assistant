/**
 * UI registry (contracts/generative-ui.md, ADR 0015, Stages 31–32): the SQLite
 * home of generated single-file resource pages — tables ui_resources +
 * ui_grants (migration 0009). Owns validation-before-write (there is NO
 * unvalidated insert path), the name rule, version assignment, and the
 * active-pointer invariant (exactly one active version per name). The
 * /api/v1/ui/* doors and the MCP resource mapping are thin faces over this
 * module (control-api discipline — logic here, not in transport).
 */

import type Database from 'better-sqlite3';
import { type UiVerdict, validateUiHtml } from './validator.js';

/** Naming rule (frozen): lowercase slug, 2–40 chars, letter first. */
export const UI_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** `jobs` is the hand-authored dashboard's name (ADR 0012) — never registrable. */
export const RESERVED_UI_NAMES: readonly string[] = ['jobs'];

/**
 * The five frozen MCP tool names requestedTools may reference — mirrors the
 * TOOLS catalog in src/transport/app/mcp.ts (frozen surface, ADR 0012; the
 * list is pinned by test/app-mcp.test.ts). Duplicated here rather than
 * imported so this module never depends on the MCP SDK.
 */
export const MCP_TOOL_NAMES: readonly string[] = [
  'status',
  'jobs_list',
  'jobs_submit',
  'jobs_kill',
  'session_rotate',
];

/** contracts/generative-ui.md §Schema — the frozen record shape. */
export interface UiResourceRecord {
  name: string;
  version: number;
  active: boolean;
  requestedTools: string[];
  /** granted(name) ∩ requestedTools — what _meta["ui/tools"] will carry. */
  grantedTools: string[];
  provenance: string;
  createdAt: string;
  htmlBytes: number;
  /** Present only where the contract says so (MCP read / single-version GET). */
  html?: string;
}

/**
 * A rejected registry input — maps to HTTP 422 on the doors. Carries the
 * validator verdict when (and only when) the rejection IS a failed validation.
 */
export class UiRegistryError extends Error {
  readonly status = 422;
  readonly verdict: UiVerdict | undefined;
  constructor(message: string, verdict?: UiVerdict) {
    super(message);
    this.verdict = verdict;
  }
}

export interface UiInstallInput {
  name: string;
  html: string;
  requestedTools?: string[];
  provenance?: string;
}

export interface UiRegistry {
  /** Dry-run validation (POST /api/v1/ui/validate) — never writes. */
  validate(html: string): UiVerdict;
  /**
   * Validate → insert as MAX(version)+1 (1 for a new name), active, and
   * demote the previously active row — one transaction, so exactly one
   * active row per name at every commit point (Stage 32, ADR 0015). Throws
   * UiRegistryError (422) on a bad name, unknown requested tool, or failed
   * validation — and then NOTHING is written: a failed install against an
   * existing name leaves the active pointer and version count untouched.
   */
  install(input: UiInstallInput): UiResourceRecord;
  /** The queryable registry: active version per name, html omitted. */
  list(): UiResourceRecord[];
  /** ALL versions of one name (ascending), html omitted; [] for an unknown name. */
  versions(name: string): UiResourceRecord[];
  /** One exact version WITH html; null when the name/version is unregistered. */
  get(name: string, version: number): UiResourceRecord | null;
  /**
   * Flip the active pointer to an already-registered version (rollback =
   * re-activation, never deletion — versions are immutable). Atomic:
   * demote-then-promote in one transaction. Returns the newly active record
   * (html omitted) or null when the name/version is unregistered (→ 404).
   */
  activate(name: string, version: number): UiResourceRecord | null;
  /** Resolve an exact ui://nightshift/<name>@v<N> uri (active or not), WITH html. */
  getByUri(uri: string): UiResourceRecord | null;
}

/** The frozen uri shape: ui://nightshift/<name>@v<N>. */
export function uiResourceUri(name: string, version: number): string {
  return `ui://nightshift/${name}@v${version}`;
}

const URI_RE = /^ui:\/\/nightshift\/([a-z][a-z0-9-]{1,39})@v([1-9][0-9]*)$/;

interface UiResourceRow {
  name: string;
  version: number;
  active: number;
  requested_tools: string;
  provenance: string;
  created_at: string;
  html_bytes: number;
  html?: string;
}

/**
 * grantedTools is the computed intersection granted(name) ∩ requestedTools
 * (ADR 0015). No grant door exists until Stage 33, so no ui_grants row can
 * exist and the intersection is [] by construction — zero-trust, hard-coded
 * rather than half-implementing the grant machinery early.
 */
const GRANTED_TOOLS_STAGE_31: string[] = [];

function toRecord(row: UiResourceRow): UiResourceRecord {
  const record: UiResourceRecord = {
    name: row.name,
    version: row.version,
    active: row.active === 1,
    requestedTools: JSON.parse(row.requested_tools) as string[],
    grantedTools: [...GRANTED_TOOLS_STAGE_31],
    provenance: row.provenance,
    createdAt: row.created_at,
    htmlBytes: row.html_bytes,
  };
  if (row.html !== undefined) record.html = row.html;
  return record;
}

const ROW_COLUMNS =
  'name, version, active, requested_tools, provenance, created_at, ' +
  'LENGTH(CAST(html AS BLOB)) AS html_bytes';

export function createUiRegistry(db: Database.Database): UiRegistry {
  const install = db.transaction(
    (name: string, html: string, requestedTools: string[], provenance: string): UiResourceRow => {
      // Stage 32 (ADR 0015): installing under an existing name assigns the
      // next version and makes it active — MAX(version)+1 → insert → demote
      // every other row of the name, all inside THIS transaction, so exactly
      // one active row per name is true at every commit point. Versions are
      // never deleted or edited: a change is the next version.
      const head = db
        .prepare('SELECT MAX(version) AS v FROM ui_resources WHERE name = ?')
        .get(name) as { v: number | null };
      const version = (head.v ?? 0) + 1;
      const createdAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO ui_resources (name, version, html, requested_tools, provenance, created_at, active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      ).run(name, version, html, JSON.stringify(requestedTools), provenance, createdAt);
      db.prepare('UPDATE ui_resources SET active = 0 WHERE name = ? AND version <> ?').run(
        name,
        version,
      );
      return {
        name,
        version,
        active: 1,
        requested_tools: JSON.stringify(requestedTools),
        provenance,
        created_at: createdAt,
        html_bytes: Buffer.byteLength(html, 'utf8'),
      };
    },
  );

  const activate = db.transaction((name: string, version: number): UiResourceRow | null => {
    const target = db
      .prepare(`SELECT ${ROW_COLUMNS} FROM ui_resources WHERE name = ? AND version = ?`)
      .get(name, version) as UiResourceRow | undefined;
    if (target === undefined) return null; // unknown name/version → 404 at the door
    db.prepare('UPDATE ui_resources SET active = 0 WHERE name = ? AND version <> ?').run(
      name,
      version,
    );
    db.prepare('UPDATE ui_resources SET active = 1 WHERE name = ? AND version = ?').run(
      name,
      version,
    );
    return { ...target, active: 1 };
  });

  return {
    validate(html: string): UiVerdict {
      return validateUiHtml(html);
    },

    install(input: UiInstallInput): UiResourceRecord {
      const { name, html } = input;
      const requestedTools = input.requestedTools ?? [];
      const provenance = input.provenance ?? '';
      if (!UI_NAME_RE.test(name)) {
        throw new UiRegistryError(
          `invalid resource name: ${JSON.stringify(name)} (must match ${UI_NAME_RE.source})`,
        );
      }
      if (RESERVED_UI_NAMES.includes(name)) {
        throw new UiRegistryError(
          `resource name "${name}" is reserved (the hand-authored ${uiResourceUri(name, 1)})`,
        );
      }
      const unknown = requestedTools.filter((tool) => !MCP_TOOL_NAMES.includes(tool));
      if (unknown.length > 0) {
        throw new UiRegistryError(
          `unknown requested tool(s): ${unknown.join(', ')} ` +
            `(the MCP catalog is: ${MCP_TOOL_NAMES.join(', ')})`,
        );
      }
      // Validation precedes EVERY registry write (contract invariant).
      const verdict = validateUiHtml(html);
      if (!verdict.valid) {
        const summary = verdict.violations.map((v) => `${v.rule}: ${v.detail}`).join('; ');
        throw new UiRegistryError(`ui validation failed — ${summary}`, verdict);
      }
      return toRecord(install(name, html, requestedTools, provenance));
    },

    list(): UiResourceRecord[] {
      const rows = db
        .prepare(`SELECT ${ROW_COLUMNS} FROM ui_resources WHERE active = 1 ORDER BY name`)
        .all() as UiResourceRow[];
      return rows.map(toRecord);
    },

    versions(name: string): UiResourceRecord[] {
      const rows = db
        .prepare(`SELECT ${ROW_COLUMNS} FROM ui_resources WHERE name = ? ORDER BY version`)
        .all(name) as UiResourceRow[];
      return rows.map(toRecord);
    },

    get(name: string, version: number): UiResourceRecord | null {
      const row = db
        .prepare(`SELECT ${ROW_COLUMNS}, html FROM ui_resources WHERE name = ? AND version = ?`)
        .get(name, version) as UiResourceRow | undefined;
      return row === undefined ? null : toRecord(row);
    },

    activate(name: string, version: number): UiResourceRecord | null {
      const row = activate(name, version);
      return row === null ? null : toRecord(row);
    },

    getByUri(uri: string): UiResourceRecord | null {
      const match = URI_RE.exec(uri);
      if (match === null) return null;
      const row = db
        .prepare(`SELECT ${ROW_COLUMNS}, html FROM ui_resources WHERE name = ? AND version = ?`)
        .get(match[1], Number.parseInt(match[2] as string, 10)) as UiResourceRow | undefined;
      return row === undefined ? null : toRecord(row);
    },
  };
}
