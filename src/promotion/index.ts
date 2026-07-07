/**
 * Shared promotion pieces: content-shape detection, slug/title derivation, the
 * $HOME/projects confinement helper, and index.html generation (the subdomain
 * pipeline's validate step). Both pipelines (contracts/promotion.md subdomain,
 * contracts/site-promotion.md website) and the router build on these.
 * Deterministic string building — no templates, no deps.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';

export type ContentKind = 'study' | 'story';

/** Rejected promote input (bad path, unknown content, in-flight slug) → API 400. */
export class PromotionError extends Error {}

/** Web-slug normalization: [a-z0-9-], bounded, no leading/trailing dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/(^-+|-+$)/g, '')
    .slice(0, 60);
}

/** "subnet-study" → "Subnet Study". */
export function titleFromSlug(slug: string): string {
  return slug.replaceAll('-', ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Confine a promote path to <home>/projects (realpath — symlinks cannot
 * escape) and require a directory. Returns the resolved real path.
 * Failures throw PromotionError (→ API 400).
 */
export function confineToProjects(home: string, reqPath: string): string {
  if (typeof reqPath !== 'string' || reqPath === '') {
    throw new PromotionError('promote requires "path" (non-empty string)');
  }
  if (!isAbsolute(reqPath)) {
    throw new PromotionError(`promote path must be absolute: ${reqPath}`);
  }
  let sourcePath: string;
  try {
    sourcePath = realpathSync(reqPath);
  } catch {
    throw new PromotionError(`content dir not found: ${reqPath}`);
  }
  if (!statSync(sourcePath).isDirectory()) {
    throw new PromotionError(`not a directory: ${reqPath}`);
  }
  const root = realpathSync(join(home, 'projects'));
  if (!sourcePath.startsWith(root + sep)) {
    throw new PromotionError(`content dir must live inside ${root}: ${reqPath}`);
  }
  return sourcePath;
}

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
