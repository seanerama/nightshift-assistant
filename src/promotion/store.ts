/**
 * Promotions table CRUD (migration 0006; contracts/promotion.md). One row per
 * slug — UNIQUE(slug) plus upsert semantics make "exactly ONE live promotion
 * per slug" a storage property: re-promoting updates the existing row (same
 * id) in place, never inserts a duplicate. The internal coolify_uuid column
 * (create-or-REUSE state for the coolify step) never leaves this module as
 * part of the exposed PromotionRecord.
 */

import type Database from 'better-sqlite3';
import type { PromotionRecord, PromotionStatus, PromotionStep } from '../types.js';

interface PromotionRow {
  id: string;
  schema: number;
  slug: string;
  title: string;
  source_path: string;
  status: PromotionStatus;
  repo_url: string | null;
  url: string | null;
  steps: string;
  coolify_uuid: string | null;
  created_at: string;
  ended_at: string | null;
  error: string | null;
}

/** The record plus the module-internal Coolify app handle. */
export interface StoredPromotion extends PromotionRecord {
  coolifyUuid: string | null;
}

export interface PromotionStore {
  getBySlug(slug: string): StoredPromotion | null;
  list(): StoredPromotion[];
  /**
   * Insert-or-update by slug (the one-live-per-slug upsert). An existing
   * row keeps its id and coolify_uuid; every contract field is replaced.
   */
  upsert(record: PromotionRecord): void;
  /** Replace the recorded steps (called after every completed step). */
  updateSteps(slug: string, steps: PromotionStep[]): void;
  /** Remember the Coolify app for slug so a re-promote redeploys, not re-creates. */
  setCoolifyUuid(slug: string, uuid: string): void;
  /** Terminal write: status + endedAt (+ error for 'failed'). */
  finish(slug: string, status: PromotionStatus, endedAt: string, error: string | null): void;
}

function toStored(row: PromotionRow): StoredPromotion {
  return {
    schema: 1,
    id: row.id,
    slug: row.slug,
    title: row.title,
    sourcePath: row.source_path,
    status: row.status,
    repoUrl: row.repo_url,
    url: row.url,
    steps: JSON.parse(row.steps) as PromotionStep[],
    createdAt: row.created_at,
    endedAt: row.ended_at,
    error: row.error,
    coolifyUuid: row.coolify_uuid,
  };
}

export function createPromotionStore(db: Database.Database): PromotionStore {
  return {
    getBySlug(slug: string): StoredPromotion | null {
      const row = db.prepare('SELECT * FROM promotions WHERE slug = ?').get(slug) as
        | PromotionRow
        | undefined;
      return row === undefined ? null : toStored(row);
    },

    list(): StoredPromotion[] {
      const rows = db
        .prepare('SELECT * FROM promotions ORDER BY created_at')
        .all() as PromotionRow[];
      return rows.map(toStored);
    },

    upsert(record: PromotionRecord): void {
      db.prepare(
        `INSERT INTO promotions (id, schema, slug, title, source_path, status, repo_url, url, steps, created_at, ended_at, error)
         VALUES (@id, 1, @slug, @title, @sourcePath, @status, @repoUrl, @url, @steps, @createdAt, @endedAt, @error)
         ON CONFLICT(slug) DO UPDATE SET
           title = excluded.title, source_path = excluded.source_path,
           status = excluded.status, repo_url = excluded.repo_url,
           url = excluded.url, steps = excluded.steps,
           created_at = excluded.created_at, ended_at = excluded.ended_at,
           error = excluded.error`,
      ).run({
        id: record.id,
        slug: record.slug,
        title: record.title,
        sourcePath: record.sourcePath,
        status: record.status,
        repoUrl: record.repoUrl,
        url: record.url,
        steps: JSON.stringify(record.steps),
        createdAt: record.createdAt,
        endedAt: record.endedAt,
        error: record.error,
      });
    },

    updateSteps(slug: string, steps: PromotionStep[]): void {
      db.prepare('UPDATE promotions SET steps = ? WHERE slug = ?').run(JSON.stringify(steps), slug);
    },

    setCoolifyUuid(slug: string, uuid: string): void {
      db.prepare('UPDATE promotions SET coolify_uuid = ? WHERE slug = ?').run(uuid, slug);
    },

    finish(slug: string, status: PromotionStatus, endedAt: string, error: string | null): void {
      db.prepare('UPDATE promotions SET status = ?, ended_at = ?, error = ? WHERE slug = ?').run(
        status,
        endedAt,
        error,
        slug,
      );
    },
  };
}
