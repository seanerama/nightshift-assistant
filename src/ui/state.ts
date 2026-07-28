/**
 * UI-state store (contracts/ui-state.md frozen v1, ADR 0016, Stage 37): one
 * durable JSON document per registered resource NAME — table ui_state
 * (migration 0010). State attaches to the name, like grants (ADR 0015), so
 * install-next-version, activate, and rollback never touch it. The registry
 * is the namespace authority: every read/write starts with the same
 * name-exists check the grant machinery uses (unknown name → 404-class
 * UiRegistryError), so rows exist only for registered names. set is a
 * FULL-document replace (last-write-wins), value must be JSON-serializable
 * and <= UI_STATE_MAX_BYTES serialized UTF-8 (422-class otherwise). The MCP
 * tools (ui_state_get/ui_state_set), the /api/v1/ui/state/<name> doors, and
 * `nightshift ui state` are all thin faces over THIS module (control-api
 * discipline — logic here, not in transport). Kept a sibling of registry.ts
 * rather than folded in: the registry's surface is the frozen
 * generative-ui.md contract; this module is the frozen ui-state.md one.
 */

import type Database from 'better-sqlite3';
import { UiRegistryError } from './registry.js';

/** contracts/ui-state.md: serialized value cap, bytes of UTF-8. */
export const UI_STATE_MAX_BYTES = 65536;

/** get() result — value/updatedAt are BOTH null when never set. */
export interface UiStateGetResult {
  name: string;
  value: unknown;
  updatedAt: string | null;
}

/** set() result — the replace is committed as of updatedAt. */
export interface UiStateSetResult {
  name: string;
  updatedAt: string;
}

export interface UiState {
  /**
   * The current document for a registered name: parsed JSON value +
   * updatedAt, or { value: null, updatedAt: null } before the first set.
   * Unknown resource name → UiRegistryError 404.
   */
  get(name: string): UiStateGetResult;
  /**
   * Replace the WHOLE document (no merge, no keyed access in v1 —
   * last-write-wins). value is any JSON (object/array/scalar);
   * non-JSON-serializable or serialized > UI_STATE_MAX_BYTES → UiRegistryError
   * 422. Unknown resource name → UiRegistryError 404.
   */
  set(name: string, value: unknown): UiStateSetResult;
}

interface UiStateRow {
  value: string;
  updated_at: string;
}

export function createUiState(db: Database.Database): UiState {
  /** 404-class refusal — the registry is the namespace authority (any version counts). */
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

  return {
    get(name: string): UiStateGetResult {
      requireKnownName(name, 'read state');
      const row = db.prepare('SELECT value, updated_at FROM ui_state WHERE name = ?').get(name) as
        | UiStateRow
        | undefined;
      if (row === undefined) return { name, value: null, updatedAt: null }; // never set
      return { name, value: JSON.parse(row.value), updatedAt: row.updated_at };
    },

    set(name: string, value: unknown): UiStateSetResult {
      requireKnownName(name, 'set state');
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(value);
      } catch (err) {
        // Circular structures, BigInt, throwing toJSON — not a JSON document.
        throw new UiRegistryError(
          `state value is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // undefined/function/symbol serialize to nothing at all — same refusal.
      if (serialized === undefined) {
        throw new UiRegistryError(
          'state value is not JSON-serializable (undefined, function, or symbol)',
        );
      }
      const bytes = Buffer.byteLength(serialized, 'utf8');
      if (bytes > UI_STATE_MAX_BYTES) {
        throw new UiRegistryError(
          `state value too large: ${bytes} bytes serialized (cap ${UI_STATE_MAX_BYTES})`,
        );
      }
      const updatedAt = new Date().toISOString();
      // Full-document replace, last-write-wins (contracts/ui-state.md §Schema).
      db.prepare(
        `INSERT INTO ui_state (name, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(name, serialized, updatedAt);
      return { name, updatedAt };
    },
  };
}
