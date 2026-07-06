/** Chunker: over-cap markdown containing code fences chunks without splitting any fence. */

import { describe, expect, it } from 'vitest';
import { chunkMarkdown, WEBEX_MESSAGE_CAP_BYTES } from '../src/transport/chunker.js';

const FENCE = /^ {0,3}```/;

function fenceCount(chunk: string): number {
  return chunk.split('\n').filter((l) => FENCE.test(l)).length;
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

describe('chunkMarkdown', () => {
  it('returns a single chunk when under the cap', () => {
    const md = 'hello **world**\n```js\nconsole.log(1);\n```\ndone';
    expect(chunkMarkdown(md)).toEqual([md]);
  });

  it('chunks over-cap markdown with code fences without splitting any fence', () => {
    const paragraph = `Some prose explaining the situation. ${'x'.repeat(120)}`;
    const codeBlock = `\`\`\`ts\n${`const line = 'value'; // padding padding padding\n`.repeat(40)}\`\`\``;
    const parts: string[] = [];
    for (let i = 0; i < 12; i++) {
      parts.push(`## Section ${i}`, paragraph, codeBlock, paragraph);
    }
    const md = parts.join('\n');
    expect(byteLen(md)).toBeGreaterThan(WEBEX_MESSAGE_CAP_BYTES);

    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(byteLen(chunk)).toBeLessThanOrEqual(WEBEX_MESSAGE_CAP_BYTES);
      // Balanced fences: no chunk starts or ends inside a code block.
      expect(fenceCount(chunk) % 2).toBe(0);
    }
    // No content lost: every non-fence line survives, in order.
    const original = md.split('\n').filter((l) => !FENCE.test(l));
    const rejoined = chunks
      .join('\n')
      .split('\n')
      .filter((l) => !FENCE.test(l));
    expect(rejoined).toEqual(original);
  });

  it('splits a single over-cap fenced block by closing and reopening the fence', () => {
    const giant = `\`\`\`python\n${`print("a really quite long line of output ${'y'.repeat(80)}")\n`.repeat(120)}\`\`\``;
    expect(byteLen(giant)).toBeGreaterThan(WEBEX_MESSAGE_CAP_BYTES);

    const chunks = chunkMarkdown(giant);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(byteLen(chunk)).toBeLessThanOrEqual(WEBEX_MESSAGE_CAP_BYTES);
      expect(fenceCount(chunk) % 2).toBe(0);
      // Each piece reopens with the original info string.
      expect(chunk.startsWith('```python\n')).toBe(true);
      expect(chunk.endsWith('```')).toBe(true);
    }
  });

  it('returns no chunks for an empty message', () => {
    expect(chunkMarkdown('')).toEqual([]);
  });
});
