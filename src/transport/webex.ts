/**
 * Minimal Webex REST client. The base URL comes from config (WEBEX_API_BASE) —
 * that is the test seam for stubbing the Webex cloud with a local fixture server.
 */

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
  /** POST /messages — deliver one (already-chunked) markdown message. */
  createMessage(dest: MessageDestination, markdown: string): Promise<void>;
}

export type MessageDestination = { roomId: string } | { toPersonId: string };

export function createWebexClient(config: Config): WebexClient {
  const headers = {
    Authorization: `Bearer ${config.webexBotToken}`,
    'Content-Type': 'application/json',
  };

  return {
    async fetchMessage(messageId: string): Promise<WebexMessage> {
      const res = await fetch(`${config.webexApiBase}/messages/${encodeURIComponent(messageId)}`, {
        headers,
      });
      if (!res.ok) {
        throw new Error(`webex fetchMessage ${messageId} failed: HTTP ${res.status}`);
      }
      return (await res.json()) as WebexMessage;
    },

    async createMessage(dest: MessageDestination, markdown: string): Promise<void> {
      const res = await fetch(`${config.webexApiBase}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...dest, markdown }),
      });
      if (!res.ok) {
        throw new Error(`webex createMessage failed: HTTP ${res.status}`);
      }
    },
  };
}
