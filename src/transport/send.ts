/**
 * send() — the ONLY way any module sends to Webex (contracts/webex-ingress.md).
 * Chunks markdown at the Webex cap without splitting code fences; on send
 * failure delivers a short fallback message and surfaces the error — never silent.
 *
 * Attachments (Stage 10, implementing the contract's reserved "accepts optional
 * file attachments"): the Webex API takes ONE file per message, so the first
 * chunk carries the first file and every further file rides its own follow-up
 * message. Files over NIGHTSHIFT_ATTACH_MAX_MB are rejected with a clear
 * AttachmentError BEFORE anything is sent (a half-delivered set helps nobody).
 * With no files, behavior is byte-identical to the pre-Stage-10 send().
 */

import { statSync } from 'node:fs';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import { chunkMarkdown } from './chunker.js';
import type { MessageDestination, WebexClient } from './webex.js';

const FALLBACK_TEXT =
  'Reply delivery failed — the full response could not be sent. Check the daemon logs.';

const BYTES_PER_MB = 1024 * 1024;

/** A file failed the pre-send attachment checks (missing, not a file, over the cap). */
export class AttachmentError extends Error {}

export interface Sender {
  send(dest: MessageDestination, markdown: string, files?: string[]): Promise<void>;
}

export function createSender(webex: WebexClient, log: Logger, config: Config): Sender {
  /** Reject a missing/oversize attachment with a clear error before any send. */
  const checkAttachment = (file: string): void => {
    let size: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) throw new Error('not a regular file');
      size = st.size;
    } catch {
      throw new AttachmentError(`attachment is not a readable regular file: ${file}`);
    }
    if (size > config.attachMaxMb * BYTES_PER_MB) {
      throw new AttachmentError(
        `attachment too large: ${file} is ${(size / BYTES_PER_MB).toFixed(1)}MB, over the ` +
          `${config.attachMaxMb}MB cap (NIGHTSHIFT_ATTACH_MAX_MB)`,
      );
    }
  };

  return {
    async send(dest: MessageDestination, markdown: string, files: string[] = []): Promise<void> {
      for (const file of files) checkAttachment(file);

      const chunks = chunkMarkdown(markdown);
      // A file-only send (empty markdown) still needs one message to carry the file.
      if (chunks.length === 0 && files.length > 0) chunks.push('');
      try {
        for (const [i, chunk] of chunks.entries()) {
          // One file per Webex message: the first chunk carries the first file.
          await webex.createMessage(dest, chunk, i === 0 ? files[0] : undefined);
        }
        for (const file of files.slice(1)) {
          await webex.createMessage(dest, '', file);
        }
      } catch (err) {
        log.error('send failed; delivering fallback', {
          error: err instanceof Error ? err.message : String(err),
          chunks: chunks.length,
          files: files.length,
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
