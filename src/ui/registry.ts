/**
 * UI registry (contracts/generative-ui.md, ADR 0015, Stages 31–33): the
 * SQLite home of generated single-file resource pages — tables ui_resources +
 * ui_grants (migration 0009). Owns validation-before-write (there is NO
 * unvalidated insert path), the name rule, version assignment, the
 * active-pointer invariant (exactly one active version per name), and the
 * zero-trust grant machinery (Stage 33): grants attach to the NAME, the
 * effective allowlist per record is granted(name) ∩ requestedTools(version),
 * and grant rows are NEVER deleted — revocation sets revoked_at, keeping the
 * owner-approval history durable. The /api/v1/ui/* doors and the MCP resource
 * mapping are thin faces over this module (control-api discipline — logic
 * here, not in transport).
 */

import type Database from 'better-sqlite3';
import { type UiVerdict, validateUiHtml } from './validator.js';

/** Naming rule (frozen): lowercase slug, 2–40 chars, letter first. */
export const UI_NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** `jobs` is the hand-authored dashboard's name (ADR 0012) — never registrable. */
export const RESERVED_UI_NAMES: readonly string[] = ['jobs'];

/**
 * The MCP tool names requestedTools may reference — mirrors the tool catalog
 * in src/transport/app/mcp.ts (frozen surface, ADR 0012; the list is pinned
 * by test/app-mcp.test.ts): the certified five, plus the two Stage 37
 * ui-state tools (contracts/ui-state.md, ADR 0016 — advertised on the wire
 * only when NIGHTSHIFT_GENERATIVE_UI_ENABLED is on, but always requestable/
 * grantable here: this whole module is reachable only through flag-gated
 * doors). Duplicated rather than imported so this module never depends on
 * the MCP SDK.
 */
export const MCP_TOOL_NAMES: readonly string[] = [
  'status',
  'jobs_list',
  'jobs_submit',
  'jobs_kill',
  'session_rotate',
  'ui_state_get',
  'ui_state_set',
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

/** contracts/generative-ui.md §Schema — the frozen grant record shape. */
export interface UiGrantRecord {
  name: string;
  tool: string;
  approvalText: string;
  grantedAt: string;
  revokedAt: string | null;
}

/**
 * A rejected registry input — maps to an HTTP error on the doors: 422 (the
 * default — rejected input) or 404 (unknown resource name / no active grant,
 * Stage 33). Carries the validator verdict when (and only when) the rejection
 * IS a failed validation.
 */
export class UiRegistryError extends Error {
  readonly status: number;
  readonly verdict: UiVerdict | undefined;
  constructor(message: string, verdict?: UiVerdict, status = 422) {
    super(message);
    this.verdict = verdict;
    this.status = status;
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
  /**
   * Record the owner's approval durably (Stage 33, ADR 0015). Grants attach
   * to the NAME. Idempotent per (name, tool) while an unrevoked grant exists
   * — the existing grant is returned, never duplicated; a re-grant after a
   * revoke is a NEW row (the history stays durable). Throws UiRegistryError:
   * 404 for an unknown resource name, 422 for a tool outside the frozen MCP
   * catalog. Granting a tool the version does not request is legal — it is
   * recorded, and simply absent from the intersection until requested.
   */
  grant(name: string, tool: string, approvalText: string): UiGrantRecord;
  /**
   * Revoke a granted tool: sets revoked_at on the active grant row — rows
   * are NEVER deleted. Immediate across all versions of the name (the
   * intersection is computed per read). Throws UiRegistryError: 404 for an
   * unknown resource name or a tool with no active grant, 422 for a tool
   * outside the frozen MCP catalog.
   */
  revoke(name: string, tool: string): UiGrantRecord;
  /** Tools with an unrevoked grant row for the name (name-level, NOT intersected). */
  grantedTools(name: string): string[];
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

interface UiGrantRow {
  id: number;
  name: string;
  tool: string;
  approval_text: string;
  granted_at: string;
  revoked_at: string | null;
}

function toGrantRecord(row: UiGrantRow): UiGrantRecord {
  return {
    name: row.name,
    tool: row.tool,
    approvalText: row.approval_text,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
  };
}

const GRANT_COLUMNS = 'id, name, tool, approval_text, granted_at, revoked_at';

const ROW_COLUMNS =
  'name, version, active, requested_tools, provenance, created_at, ' +
  'LENGTH(CAST(html AS BLOB)) AS html_bytes';

export function createUiRegistry(db: Database.Database): UiRegistry {
  /** Tools with an unrevoked grant row for the name (ADR 0015: per-NAME). */
  const activeGrantSet = (name: string): Set<string> => {
    const rows = db
      .prepare('SELECT DISTINCT tool FROM ui_grants WHERE name = ? AND revoked_at IS NULL')
      .all(name) as Array<{ tool: string }>;
    return new Set(rows.map((row) => row.tool));
  };

  /**
   * The frozen record shape. grantedTools is the computed intersection
   * granted(name) ∩ requestedTools of THIS record (ADR 0015) — per-record,
   * so it stays version-correct when multiple versions exist: each version
   * carries only the granted tools it actually requests. Evaluated on every
   * read — a revoke is immediate on the next list/read.
   */
  const toRecord = (row: UiResourceRow): UiResourceRecord => {
    const requestedTools = JSON.parse(row.requested_tools) as string[];
    const granted = activeGrantSet(row.name);
    const record: UiResourceRecord = {
      name: row.name,
      version: row.version,
      active: row.active === 1,
      requestedTools,
      grantedTools: requestedTools.filter((tool) => granted.has(tool)),
      provenance: row.provenance,
      createdAt: row.created_at,
      htmlBytes: row.html_bytes,
    };
    if (row.html !== undefined) record.html = row.html;
    return record;
  };

  /** 404-class refusal for a name with no registered resource (any version). */
  const requireKnownName = (name: string, verb: string): void => {
    const row = db.prepare('SELECT 1 FROM ui_resources WHERE name = ? LIMIT 1').get(name);
    if (row === undefined) {
      throw new UiRegistryError(
        `cannot ${verb}: no registered resource named "${name}"`,
        undefined,
        404,
      );
    }
  };

  /** 422-class refusal for a tool outside the frozen MCP catalog. */
  const requireKnownTool = (tool: string): void => {
    if (!MCP_TOOL_NAMES.includes(tool)) {
      throw new UiRegistryError(
        `unknown tool: ${JSON.stringify(tool)} (the MCP catalog is: ${MCP_TOOL_NAMES.join(', ')})`,
      );
    }
  };

  /** The active (unrevoked) grant row for (name, tool), newest first. */
  const activeGrantRow = (name: string, tool: string): UiGrantRow | undefined =>
    db
      .prepare(
        `SELECT ${GRANT_COLUMNS} FROM ui_grants
         WHERE name = ? AND tool = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1`,
      )
      .get(name, tool) as UiGrantRow | undefined;

  // Idempotency needs check-then-insert to be atomic (no duplicate active rows).
  const grantTx = db.transaction((name: string, tool: string, approvalText: string): UiGrantRow => {
    const existing = activeGrantRow(name, tool);
    if (existing !== undefined) return existing; // idempotent while unrevoked
    const grantedAt = new Date().toISOString();
    const inserted = db
      .prepare(
        `INSERT INTO ui_grants (name, tool, approval_text, granted_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run(name, tool, approvalText, grantedAt);
    return {
      id: Number(inserted.lastInsertRowid),
      name,
      tool,
      approval_text: approvalText,
      granted_at: grantedAt,
      revoked_at: null,
    };
  });

  // Revocation is an UPDATE, never a DELETE — the approval history is durable.
  const revokeTx = db.transaction((name: string, tool: string): UiGrantRow => {
    const existing = activeGrantRow(name, tool);
    if (existing === undefined) {
      throw new UiRegistryError(
        `cannot revoke: "${tool}" has no active grant for "${name}"`,
        undefined,
        404,
      );
    }
    const revokedAt = new Date().toISOString();
    db.prepare('UPDATE ui_grants SET revoked_at = ? WHERE id = ?').run(revokedAt, existing.id);
    return { ...existing, revoked_at: revokedAt };
  });

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

    grant(name: string, tool: string, approvalText: string): UiGrantRecord {
      requireKnownName(name, 'grant'); // 404 before the tool check — the resource is the address
      requireKnownTool(tool); // 422
      return toGrantRecord(grantTx(name, tool, approvalText));
    },

    revoke(name: string, tool: string): UiGrantRecord {
      requireKnownName(name, 'revoke'); // 404
      requireKnownTool(tool); // 422
      return toGrantRecord(revokeTx(name, tool)); // 404 when never/no-longer granted
    },

    grantedTools(name: string): string[] {
      return [...activeGrantSet(name)];
    },
  };
}
