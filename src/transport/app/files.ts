/**
 * App file registry (Stage 26, contracts/app-ingress.md `files` capability):
 * the durable id→path mapping behind POST /app/v1/uploads and
 * GET /app/v1/files/<id>. Never an arbitrary-path read: only ids in the
 * app_files table resolve, and every resolution is confined with the SAME
 * discipline as delivery (confineToRoots — realpath + allow-listed root
 * prefix, symlink-safe) at SERVE time, not only at issue time. Uploads land
 * in the EXISTING `uploads/<ts>-<name>` layout (contracts/webex-ingress.md,
 * src/types.ts) so InboundMessage.attachments keeps its one meaning for the
 * session — it cannot tell which door a file came through.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Logger } from '../../log.js';
import { confineToRoots, DeliverError } from '../deliver.js';

export interface AppFiles {
  /**
   * Land one multipart upload: sanitized name, uploads/<ts>-<name>, durable
   * id row. The caller enforces the size cap BEFORE handing bytes over.
   */
  saveUpload(
    filename: string,
    bytes: Buffer,
  ): { uploadId: string; absPath: string; relPath: string };
  /**
   * Issue servable ids for reply/notice file paths. Paths outside the
   * confined roots (or missing) are DROPPED with a log line — never served,
   * never an error that costs the reply itself.
   */
  issueIds(paths: string[]): string[];
  /** id → confined absolute path, or null (unknown, vanished, or escaped). */
  resolve(id: string): string | null;
}

/**
 * Filename sanitizer: directory components stripped (both separators), every
 * character outside [A-Za-z0-9_.-] replaced, leading dots removed so `..`
 * and dotfiles cannot survive. The result is a bare filename — traversal out
 * of uploads/ is structurally impossible (no separators remain).
 */
export function sanitizeFilename(raw: string): string {
  const base = basename(raw.replace(/\\/g, '/'));
  const safe = base.replace(/[^\w.-]/g, '_').replace(/^\.+/, '');
  return safe === '' ? 'file' : safe;
}

export function createAppFiles(
  db: Database.Database,
  log: Logger,
  opts: {
    /** <appDir>/uploads — the layout the session already understands. */
    uploadsDir: string;
    /** The deliverer's confined roots + uploadsDir (src/app.ts). */
    roots: string[];
  },
): AppFiles {
  const insert = db.prepare('INSERT INTO app_files (id, path, created_at) VALUES (?, ?, ?)');
  const select = db.prepare('SELECT path FROM app_files WHERE id = ?');

  /** confineToRoots throws DeliverError on anything unservable — map to null. */
  const confined = (path: string): string | null => {
    try {
      return confineToRoots(path, opts.roots);
    } catch (err) {
      if (err instanceof DeliverError) return null;
      throw err;
    }
  };

  return {
    saveUpload(
      filename: string,
      bytes: Buffer,
    ): { uploadId: string; absPath: string; relPath: string } {
      const name = sanitizeFilename(filename);
      mkdirSync(opts.uploadsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '');
      let absPath = join(opts.uploadsDir, `${ts}-${name}`);
      try {
        // wx: fail rather than silently overwrite a same-millisecond collision.
        writeFileSync(absPath, bytes, { flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        absPath = join(opts.uploadsDir, `${ts}-${randomUUID().slice(0, 8)}-${name}`);
        writeFileSync(absPath, bytes, { flag: 'wx' });
      }
      const uploadId = `up_${randomUUID()}`;
      insert.run(uploadId, absPath, new Date().toISOString());
      log.info('app upload stored', { uploadId, path: absPath, bytes: bytes.length });
      return { uploadId, absPath, relPath: `uploads/${basename(absPath)}` };
    },

    issueIds(paths: string[]): string[] {
      const ids: string[] = [];
      for (const path of paths) {
        const real = confined(path);
        if (real === null) {
          // Outside the allow-listed roots (or gone): dropped, never served.
          log.warn('reply file outside the confined roots dropped from the app wire', { path });
          continue;
        }
        const id = `f_${randomUUID()}`;
        insert.run(id, real, new Date().toISOString());
        ids.push(id);
      }
      return ids;
    },

    resolve(id: string): string | null {
      const row = select.get(id) as { path: string } | undefined;
      if (row === undefined) return null;
      const real = confined(row.path);
      if (real === null) {
        log.warn('app file id resolves outside the confined roots (or is gone) — refused', {
          id,
          path: row.path,
        });
      }
      return real;
    },
  };
}
