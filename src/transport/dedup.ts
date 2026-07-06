/** Recently-processed messageId set (contracts/webex-ingress.md step 4). */

export class MessageDedup {
  private readonly seen = new Set<string>();
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /** Returns true when the id is new (and marks it processed); false for duplicates. */
  markIfNew(messageId: string): boolean {
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    if (this.seen.size > this.maxSize) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }
}
