/**
 * On-request reMarkable PUSH (Stage 19, ADDITIVE evolution of
 * contracts/control-api.md v1): upload a document to the owner's reMarkable
 * tablet via the reMarkable CLOUD API. The requested path is realpath-resolved
 * and CONFINED to the SAME allow-listed root set as deliver (~/projects + the
 * app's jobs/ + logs/ dirs) — the conversational session holds the API token,
 * so the blast radius of a prompt injection must stay bounded, never the
 * arbitrary filesystem. Symlinks cannot escape: confinement is checked on the
 * resolved real path (shared with deliver via confineToRoots).
 *
 * The transport is a SEAM: the default impl shells `rmapi put <path> <folder>`,
 * but the exec is injected (`run`) so tests never shell rmapi or hit the cloud,
 * and the transport stays swappable (rmapi-js / native) later. The device
 * token / rmapi config is a daemon-only host secret and never appears here.
 *
 * Dark by default: the pusher REFUSES when `enabled` is false (403), and the
 * route guards the same NIGHTSHIFT_REMARKABLE_ENABLED kill-switch before ever
 * reaching push().
 */

import type { Logger } from '../log.js';
import { confineToRoots } from './deliver.js';

/** Rejected remarkable push: 403 (feature dark) or 502 (rmapi/cloud transport failed). */
export class RemarkableError extends Error {
  readonly status: 403 | 502;
  constructor(message: string, status: 403 | 502) {
    super(message);
    this.status = status;
  }
}

/** Exit of the injected exec seam (a subset of a child-process result). */
export interface RemarkableRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * The reMarkable transport seam: runs the fully-built rmapi argv and reports
 * the exit. Injected so tests never shell rmapi or touch the cloud, and the
 * transport stays swappable behind this one boundary.
 */
export type RemarkableRun = (argv: string[]) => Promise<RemarkableRunResult>;

export interface RemarkablePusher {
  /** Confine + upload; returns the resolved path and the tablet folder it went to. */
  push(path: string): Promise<{ path: string; folder: string }>;
}

export function createRemarkablePusher(deps: {
  /** NIGHTSHIFT_REMARKABLE_ENABLED — dark by default; false → push() refuses (403). */
  enabled: boolean;
  /** Destination folder on the tablet (default /Inbox). */
  folder: string;
  /** Path to the rmapi binary on the host (RMAPI_BIN; default "rmapi"). */
  rmapiBin: string;
  /** Allow-listed roots — the SAME set deliver confines to. */
  allowedRoots: string[];
  /** Exec seam: shells `rmapi put <path> <folder>` in production; a stub in tests. */
  run: RemarkableRun;
  log: Logger;
}): RemarkablePusher {
  return {
    async push(path: string): Promise<{ path: string; folder: string }> {
      // Dark-launch kill-switch, enforced at the transport too (the route also
      // 403s before this): a disabled capability must never shell rmapi.
      if (!deps.enabled) {
        throw new RemarkableError(
          'reMarkable push is disabled (set NIGHTSHIFT_REMARKABLE_ENABLED=true to enable)',
          403,
        );
      }
      // Path confinement (shared with deliver): rejects traversal / symlink
      // escape / anything outside the roots as a DeliverError (400).
      const real = confineToRoots(path, deps.allowedRoots);
      const argv = [deps.rmapiBin, 'put', real, deps.folder];
      const result = await deps.run(argv);
      if (result.code !== 0) {
        const output = (result.stderr || result.stdout).trim().split('\n').slice(-5).join(' / ');
        throw new RemarkableError(`\`${argv.join(' ')}\` exited ${result.code}: ${output}`, 502);
      }
      deps.log.info('document pushed to the reMarkable cloud', {
        path: real,
        folder: deps.folder,
      });
      return { path: real, folder: deps.folder };
    },
  };
}
