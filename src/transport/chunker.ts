/**
 * Markdown chunker for send() (contracts/webex-ingress.md): splits a reply at
 * Webex's message-size cap WITHOUT ever splitting a code fence — every emitted
 * chunk has balanced fences. An over-cap fenced block is closed and reopened
 * (same info string) across chunks so no chunk carries an unterminated fence.
 */

/** Webex message cap in bytes (~7439 for markdown). */
export const WEBEX_MESSAGE_CAP_BYTES = 7439;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Split one over-cap string at line boundaries (or hard byte splits for giant lines). */
function splitPlain(text: string, cap: number): string[] {
  const out: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    let piece = line;
    while (byteLen(piece) > cap) {
      // A single line over the cap: hard-split at a character boundary.
      let cut = piece.length;
      while (cut > 1 && byteLen(piece.slice(0, cut)) > cap) cut--;
      if (current !== '') {
        out.push(current);
        current = '';
      }
      out.push(piece.slice(0, cut));
      piece = piece.slice(cut);
    }
    const candidate = current === '' ? piece : `${current}\n${piece}`;
    if (byteLen(candidate) > cap) {
      if (current !== '') out.push(current);
      current = piece;
    } else {
      current = candidate;
    }
  }
  if (current !== '') out.push(current);
  return out;
}

interface Block {
  text: string;
  fenced: boolean;
  /** Opening fence line (for reopening when a fenced block must be split). */
  fenceOpen?: string;
  /** Closing fence marker. */
  fenceClose?: string;
}

/** Group lines into atomic blocks: whole fenced code blocks, or single plain lines. */
function toBlocks(markdown: string): Block[] {
  const lines = markdown.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const open = FENCE_LINE.exec(line);
    if (open?.[1] !== undefined) {
      const marker = open[1];
      const fenceChar = marker[0] as string;
      const closeRe = new RegExp(`^ {0,3}${fenceChar === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j] as string)) j++;
      const end = j < lines.length ? j : lines.length - 1;
      blocks.push({
        text: lines.slice(i, end + 1).join('\n'),
        fenced: true,
        fenceOpen: line,
        fenceClose: j < lines.length ? (lines[j] as string) : marker,
      });
      i = end + 1;
    } else {
      blocks.push({ text: line, fenced: false });
      i++;
    }
  }
  return blocks;
}

/** Split one over-cap fenced block into balanced sub-blocks (close + reopen the fence). */
function splitFenced(block: Block, cap: number): string[] {
  const open = block.fenceOpen ?? '```';
  const close = block.fenceClose ?? '```';
  const overhead = byteLen(open) + byteLen(close) + 2; // two joining newlines
  const bodyLines = block.text.split('\n').slice(1, -1);
  const pieces = splitPlain(bodyLines.join('\n'), Math.max(cap - overhead, 1));
  return pieces.map((p) => `${open}\n${p}\n${close}`);
}

/**
 * Chunk markdown so every chunk is ≤ cap bytes and no code fence is split
 * across chunks (each chunk's fences are balanced).
 */
export function chunkMarkdown(markdown: string, cap: number = WEBEX_MESSAGE_CAP_BYTES): string[] {
  if (markdown === '') return [];
  if (byteLen(markdown) <= cap) return [markdown];

  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current !== '') {
      chunks.push(current);
      current = '';
    }
  };

  const append = (text: string): void => {
    const candidate = current === '' ? text : `${current}\n${text}`;
    if (byteLen(candidate) <= cap) {
      current = candidate;
      return;
    }
    flush();
    if (byteLen(text) <= cap) {
      current = text;
      return;
    }
    // Plain over-cap run: split at line/byte boundaries.
    const pieces = splitPlain(text, cap);
    for (const piece of pieces.slice(0, -1)) chunks.push(piece);
    current = pieces[pieces.length - 1] ?? '';
  };

  for (const block of toBlocks(markdown)) {
    if (block.fenced && byteLen(block.text) > cap) {
      // Whole fenced block can never fit: emit balanced close/reopen pieces.
      flush();
      const pieces = splitFenced(block, cap);
      for (const piece of pieces.slice(0, -1)) chunks.push(piece);
      current = pieces[pieces.length - 1] ?? '';
    } else if (block.fenced) {
      const candidate = current === '' ? block.text : `${current}\n${block.text}`;
      if (byteLen(candidate) <= cap) {
        current = candidate;
      } else {
        // Never split the fence: start a fresh chunk for the whole block.
        flush();
        current = block.text;
      }
    } else {
      append(block.text);
    }
  }
  flush();
  return chunks;
}
