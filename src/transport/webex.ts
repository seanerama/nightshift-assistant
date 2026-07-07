/**
 * Minimal Webex REST client. The base URL comes from config (WEBEX_API_BASE) —
 * that is the test seam for stubbing the Webex cloud with a local fixture server.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Config } from '../config.js';

export interface WebexMessage {
  id: string;
  roomId: string;
  personId: string;
  personEmail?: string;
  text?: string;
  markdown?: string;
}

export interface WebexClient {
  /** GET /messages/{id} — fetch the full message named by a webhook delivery. */
  fetchMessage(messageId: string): Promise<WebexMessage>;
  /**
   * POST /messages — deliver one (already-chunked) markdown message. With a
   * filePath the POST is multipart/form-data carrying ONE `files` part (the
   * Webex API constraint: one file per message); markdown may be empty for a
   * file-only follow-up message.
   */
  createMessage(dest: MessageDestination, markdown: string, filePath?: string): Promise<void>;
}

export type MessageDestination = { roomId: string } | { toPersonId: string };

export function createWebexClient(config: Config): WebexClient {
  const authHeader = { Authorization: `Bearer ${config.webexBotToken}` };
  const jsonHeaders = { ...authHeader, 'Content-Type': 'application/json' };

  return {
    async fetchMessage(messageId: string): Promise<WebexMessage> {
      const res = await fetch(`${config.webexApiBase}/messages/${encodeURIComponent(messageId)}`, {
        headers: jsonHeaders,
      });
      if (!res.ok) {
        throw new Error(`webex fetchMessage ${messageId} failed: HTTP ${res.status}`);
      }
      return (await res.json()) as WebexMessage;
    },

    async createMessage(
      dest: MessageDestination,
      markdown: string,
      filePath?: string,
    ): Promise<void> {
      let res: Response;
      if (filePath === undefined) {
        res = await fetch(`${config.webexApiBase}/messages`, {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ ...dest, markdown }),
        });
      } else {
        // Multipart upload: fetch sets the boundary Content-Type itself —
        // never set the header manually here.
        const form = new FormData();
        for (const [key, value] of Object.entries(dest)) form.append(key, value);
        if (markdown !== '') form.append('markdown', markdown);
        const bytes = readFileSync(filePath);
        form.append(
          'files',
          new Blob([bytes], { type: 'application/octet-stream' }),
          basename(filePath),
        );
        res = await fetch(`${config.webexApiBase}/messages`, {
          method: 'POST',
          headers: authHeader,
          body: form,
        });
      }
      if (!res.ok) {
        throw new Error(`webex createMessage failed: HTTP ${res.status}`);
      }
    },
  };
}
