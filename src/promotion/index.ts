/**
 * index.html generation (contracts/promotion.md validate step): promoted
 * content without an index.html gets one, so https://<slug>.<domain> lands
 * somewhere sensible. Study content links every guides/*.html (label from the
 * guide's own <title> when present) plus the textbook; story content links
 * the final video/PDF. Deterministic string building — no templates, no deps.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ContentKind = 'study' | 'story';

export interface IndexResult {
  generated: boolean;
  detail: string;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** First <title> from an HTML file, or null. Reads the head of the file only. */
function extractHtmlTitle(path: string): string | null {
  try {
    const head = readFileSync(path, 'utf8').slice(0, 4096);
    const match = /<title[^>]*>([^<]+)<\/title>/i.exec(head);
    const title = match?.[1]?.trim();
    return title === undefined || title === '' ? null : title;
  } catch {
    return null;
  }
}

/** "chapter-01.html" → "Chapter 01". */
function prettifyName(fileName: string): string {
  const base = fileName.replace(/\.[a-z0-9]+$/i, '').replaceAll(/[-_]+/g, ' ');
  return base.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** Sorted guides/*.html names for study content ([] when guides/ is absent). */
export function listGuides(dir: string): string[] {
  const guidesDir = join(dir, 'guides');
  if (!existsSync(guidesDir)) return [];
  return readdirSync(guidesDir)
    .filter((name) => name.endsWith('.html'))
    .sort();
}

/** Story artifacts at the content root: the final video and any PDFs. */
export function listStoryArtifacts(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => /final\.mp4$/i.test(name) || /\.pdf$/i.test(name))
    .sort();
}

function buildLinks(dir: string, kind: ContentKind): string[] {
  const items: string[] = [];
  if (kind === 'study') {
    for (const name of listGuides(dir)) {
      const label = extractHtmlTitle(join(dir, 'guides', name)) ?? prettifyName(name);
      items.push(`      <li><a href="guides/${name}">${escapeHtml(label)}</a></li>`);
    }
    if (existsSync(join(dir, 'textbook.md'))) {
      items.push('      <li><a href="textbook.md">Textbook (markdown)</a></li>');
    }
  } else {
    for (const name of listStoryArtifacts(dir)) {
      items.push(`      <li><a href="${name}">${escapeHtml(prettifyName(name))}</a></li>`);
    }
  }
  return items;
}

/**
 * Write <dir>/index.html when absent (title + links). An existing index.html
 * is NEVER touched — the content's own landing page wins.
 */
export function ensureIndexHtml(dir: string, title: string, kind: ContentKind): IndexResult {
  const indexPath = join(dir, 'index.html');
  if (existsSync(indexPath)) {
    return { generated: false, detail: 'index.html already present' };
  }
  const safeTitle = escapeHtml(title);
  const links = buildLinks(dir, kind);
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <title>${safeTitle}</title>`,
    '    <style>',
    '      body { font-family: system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.6; }',
    '      a { color: #2563eb; }',
    '    </style>',
    '  </head>',
    '  <body>',
    `    <h1>${safeTitle}</h1>`,
    '    <ul>',
    ...links,
    '    </ul>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
  writeFileSync(indexPath, html);
  return { generated: true, detail: `generated index.html (${links.length} link(s))` };
}
