/**
 * Proactive-send fan-out (Stage 24, ADR 0010): the same `Sender` interface the
 * four proactive notify call sites already use (rotation notice, job-finish
 * notice ± auto-attach retry, promotion notice — src/app.ts). The Webex leg is
 * BYTE-IDENTICAL: the wrapped sender is called with the exact same arguments
 * in the same order, and chunking / fallback / attachment behavior all live
 * inside it, untouched (src/transport/send.ts is undiffed). With the app
 * transport live, each proactive send ALSO lands one durable `notice` outbox
 * row — written BEFORE the Webex call, in its own try/catch, so an outbox
 * failure never costs the Webex notice and a Webex outage never costs the app
 * client its notice. Dark (app null) → the fan-out IS the Webex sender.
 *
 * Stage 26: notice files are no longer dropped — confined attachment paths
 * are issued servable ids (GET /app/v1/files/<id>) through the app_files
 * registry; anything outside the confined roots is dropped with a log line.
 */

import type { Logger } from '../../log.js';
import type { Sender } from '../send.js';
import type { MessageDestination } from '../webex.js';
import type { AppFiles } from './files.js';
import type { AppOutbox } from './outbox.js';

/** The app-side sink pair the fan-out writes into (both exist iff the transport starts). */
export interface AppSink {
  outbox: AppOutbox;
  files: AppFiles;
}

export function createNotifyFanout(webex: Sender, app: AppSink | null, log: Logger): Sender {
  // Flag off / listener refused: pure passthrough — not a wrapper, the sender
  // itself, so flag-off behavior is identical by construction.
  if (app === null) return webex;

  return {
    async send(dest: MessageDestination, markdown: string, files?: string[]): Promise<void> {
      // Durable notice first (ADR 0010: row before live emit — the SSE emit
      // rides append()). Attachment paths become servable ids when confined;
      // unconfined paths are dropped by the registry, never leaked.
      try {
        app.outbox.append('notice', {
          schema: 1,
          text: markdown,
          files: app.files.issueIds(files ?? []),
        });
      } catch (err) {
        log.error('app notice outbox write failed (Webex leg unaffected)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      // The Webex leg: same args, same ordering, errors propagate as before.
      await webex.send(dest, markdown, files);
    },
  };
}
