/**
 * On-request delivery (Stage 10, ADDITIVE evolution of contracts/control-api.md
 * v1): send a file to the owner's Webex room as an attachment. The requested
 * path is realpath-resolved and CONFINED to an allow-listed root set — the
 * conversational session holds the API token, so the blast radius of a prompt
 * injection must stay bounded to ~/projects and the app's jobs/ + logs/ dirs,
 * never the arbitrary filesystem. Symlinks cannot escape: confinement is
 * checked on the resolved real path.
 */

import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, sep } from 'node:path';
import type { Logger } from '../log.js';
import type { Sender } from './send.js';

/** Rejected deliver input: 400 (bad/escaping path) or 409 (no owner room yet). */
export class DeliverError extends Error {
  readonly status: 400 | 409;
  constructor(message: string, status: 400 | 409) {
    super(message);
    this.status = status;
  }
}

export interface Deliverer {
  /** Resolve + confine + send; returns the resolved path and the room it went to. */
  deliver(path: string, note?: string): Promise<{ path: string; roomId: string }>;
}

/**
 * Resolve `requested` to its real path and reject (400) anything that is not
 * an existing regular file inside one of the allowed roots. Roots are
 * realpath-resolved too, so a symlinked root still confines correctly.
 */
export function confineToRoots(requested: string, roots: string[]): string {
  if (!isAbsolute(requested)) {
    throw new DeliverError(`deliver path must be absolute: ${requested}`, 400);
  }
  let real: string;
  try {
    real = realpathSync(requested);
  } catch {
    throw new DeliverError(`file not found: ${requested}`, 400);
  }
  if (!statSync(real).isFile()) {
    throw new DeliverError(`not a regular file: ${requested}`, 400);
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue; // a root that does not exist yet cannot contain anything
    }
    if (real === realRoot || real.startsWith(realRoot + sep)) return real;
  }
  throw new DeliverError(
    `path is outside the deliverable roots (allowed: ${roots.join(', ')}): ${requested}`,
    400,
  );
}

export function createDeliverer(deps: {
  sender: Sender;
  /** Allow-listed roots ($HOME/projects, <appDir>/jobs, <appDir>/logs). */
  roots: string[];
  /** The owner's last-seen roomId (persisted by the app), or null when unknown. */
  ownerRoom: () => string | null;
  log: Logger;
}): Deliverer {
  return {
    async deliver(path: string, note?: string): Promise<{ path: string; roomId: string }> {
      const real = confineToRoots(path, deps.roots);
      const roomId = deps.ownerRoom();
      if (roomId === null) {
        throw new DeliverError(
          'no owner room is known yet — send the bot a Webex message first, then retry the delivery',
          409,
        );
      }
      const label = `📎 ${basename(real)}`;
      const markdown = note === undefined || note === '' ? label : `${label} — ${note}`;
      await deps.sender.send({ roomId }, markdown, [real]);
      deps.log.info('file delivered to the owner room', { path: real, roomId });
      return { path: real, roomId };
    },
  };
}
