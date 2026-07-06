/**
 * send() — the ONLY way any module sends to Webex (contracts/webex-ingress.md).
 * Chunks markdown at the Webex cap without splitting code fences; on send
 * failure delivers a short fallback message and surfaces the error — never silent.
 */

import type { Logger } from '../log.js';
import { chunkMarkdown } from './chunker.js';
import type { MessageDestination, WebexClient } from './webex.js';

const FALLBACK_TEXT =
  'Reply delivery failed — the full response could not be sent. Check the daemon logs.';

export interface Sender {
  send(dest: MessageDestination, markdown: string): Promise<void>;
}

export function createSender(webex: WebexClient, log: Logger): Sender {
  return {
    async send(dest: MessageDestination, markdown: string): Promise<void> {
      const chunks = chunkMarkdown(markdown);
      try {
        for (const chunk of chunks) {
          await webex.createMessage(dest, chunk);
        }
      } catch (err) {
        log.error('send failed; delivering fallback', {
          error: err instanceof Error ? err.message : String(err),
          chunks: chunks.length,
        });
        try {
          await webex.createMessage(dest, FALLBACK_TEXT);
        } catch (fallbackErr) {
          log.error('fallback send also failed', {
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
        }
        throw err;
      }
    },
  };
}
