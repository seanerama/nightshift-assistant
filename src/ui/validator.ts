/**
 * UI validator (contracts/generative-ui.md, ADR 0014): deterministic static
 * analysis enforcing nightshift-client/contracts/ui-bridge.md on a candidate
 * single-file resource page. Hand-rolled scanning over the HTML text — no
 * browser, no parser dependency (the alternatives are rejected in the ADR).
 *
 * CONSERVATIVE BY DESIGN: a banned identifier anywhere in script/handler text
 * is a violation even if unreachable ("reject on suspicion" — false rejects
 * cost one revise round-trip; false accepts cost registry pollution). There
 * is no override path.
 *
 * The rule ids are FROZEN contract surface; the set is additive only. The
 * validator is a quality/honesty gate, NOT the security boundary — the client
 * shell sandbox is (ADR 0014); drift between this file and ui-bridge.md shows
 * up as a red fixture in test/ui-validator.test.ts (jobs-v1.html must pass).
 */

/** Frozen rule ids (contracts/generative-ui.md §Schema — additive only). */
export const UI_RULES = [
  'single-file',
  'no-network',
  'no-storage',
  'no-navigation',
  'bridge-only',
  'degradable-render',
  'size-cap',
  'well-formed',
] as const;

export type UiRule = (typeof UI_RULES)[number];

export interface UiViolation {
  rule: UiRule;
  detail: string;
}

/** The frozen verdict shape (machine-readable — the revise loop is mechanical). */
export interface UiVerdict {
  valid: boolean;
  violations: UiViolation[];
}

/** size-cap: 256 KB of UTF-8 (contracts/generative-ui.md). */
export const UI_SIZE_CAP_BYTES = 256 * 1024;

/** Tags whose src/href-style attributes would fetch an external resource. */
const FETCHING_TAGS = new Set([
  'audio',
  'embed',
  'frame',
  'iframe',
  'img',
  'input',
  'link',
  'object',
  'script',
  'source',
  'track',
  'use',
  'video',
]);

/** Attribute names that name a resource to load (single-file rule). */
const FETCHING_ATTRS = new Set(['src', 'srcset', 'href', 'data', 'xlink:href', 'poster']);

/** Banned identifiers in script/handler text, per rule (ADR 0014's lists). */
const NETWORK_TOKENS: ReadonlyArray<[RegExp, string]> = [
  [/\bfetch\b/, 'fetch'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bsendBeacon\b/, 'sendBeacon'],
  [/\bimport\s*\(/, 'import('],
];

const STORAGE_TOKENS: ReadonlyArray<[RegExp, string]> = [
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\bindexedDB\b/, 'indexedDB'],
  [/\bdocument\s*\.\s*cookie\b/, 'document.cookie'],
  [/\bcaches\b/, 'caches'],
];

const NAVIGATION_TOKENS: ReadonlyArray<[RegExp, string]> = [
  [/\bwindow\s*\.\s*open\b/, 'window.open'],
  // Conservative: ANY use of the location object (window.location,
  // document.location, bare location.href = …) is treated as navigation.
  [/\blocation\b/, 'location'],
];

/** Frame-escape identifiers — postMessage anywhere but the bridge (bridge-only). */
const BRIDGE_ESCAPE_TOKENS: ReadonlyArray<[RegExp, string]> = [
  [/\bwindow\s*\.\s*parent\b/, 'window.parent'],
  [/\bwindow\s*\.\s*top\b/, 'window.top'],
  [/\bopener\b/, 'opener'],
];

interface Tag {
  name: string;
  attrs: Array<{ name: string; value: string }>;
}

/** Strip HTML comments so commented-out markup never trips a tag scan. */
function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/** Every tag with its parsed attributes (crude, deterministic — no parser dep). */
function scanTags(html: string): Tag[] {
  const tags: Tag[] = [];
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const m of html.matchAll(tagRe)) {
    const attrs: Array<{ name: string; value: string }> = [];
    for (const a of (m[2] ?? '').matchAll(attrRe)) {
      attrs.push({
        name: (a[1] ?? '').toLowerCase(),
        value: (a[2] ?? a[3] ?? a[4] ?? '').trim(),
      });
    }
    tags.push({ name: (m[1] ?? '').toLowerCase(), attrs });
  }
  return tags;
}

/** Inline <script> bodies + every on*="…" handler attribute — the scanned text. */
function scriptText(html: string, tags: Tag[]): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    parts.push(m[1] ?? '');
  }
  for (const tag of tags) {
    for (const attr of tag.attrs) {
      if (attr.name.startsWith('on')) parts.push(attr.value);
    }
  }
  return parts.join('\n');
}

/** The <style> bodies + style="…" attributes (single-file CSS checks). */
function styleText(html: string, tags: Tag[]): string {
  const parts: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    parts.push(m[1] ?? '');
  }
  for (const tag of tags) {
    for (const attr of tag.attrs) {
      if (attr.name === 'style') parts.push(attr.value);
    }
  }
  return parts.join('\n');
}

/**
 * Validate one candidate page. Deterministic: same input, same verdict —
 * every rule runs (no short-circuit), so the revise loop sees the full list.
 */
export function validateUiHtml(html: string): UiVerdict {
  const violations: UiViolation[] = [];
  const add = (rule: UiRule, detail: string): void => {
    violations.push({ rule, detail });
  };

  // ── size-cap ──────────────────────────────────────────────────────────────
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > UI_SIZE_CAP_BYTES) {
    add('size-cap', `page is ${bytes} bytes (cap: ${UI_SIZE_CAP_BYTES})`);
  }

  // ── well-formed ───────────────────────────────────────────────────────────
  const stripped = stripComments(html);
  const lower = stripped.toLowerCase();
  if (!/<!doctype\s+html/i.test(stripped)) add('well-formed', 'missing <!doctype html>');
  for (const [open, close] of [
    ['<html', '</html>'],
    ['<body', '</body>'],
  ] as const) {
    if (!lower.includes(open)) add('well-formed', `missing ${open}> element`);
    else if (!lower.includes(close)) add('well-formed', `unclosed ${open}> (no ${close})`);
  }
  const scriptOpens = (lower.match(/<script\b/g) ?? []).length;
  const scriptCloses = (lower.match(/<\/script\s*>/g) ?? []).length;
  if (scriptOpens !== scriptCloses) {
    add('well-formed', `unbalanced <script> tags (${scriptOpens} open, ${scriptCloses} close)`);
  }

  const tags = scanTags(stripped);
  const scripts = scriptText(stripped, tags);
  const styles = styleText(stripped, tags);

  // ── single-file ───────────────────────────────────────────────────────────
  // No reference that would fetch: src/href-style attributes on loading tags
  // (data: URIs allowed), CSS @import, CSS url(...) to anything but data:.
  for (const tag of tags) {
    if (!FETCHING_TAGS.has(tag.name)) continue;
    for (const attr of tag.attrs) {
      if (!FETCHING_ATTRS.has(attr.name)) continue;
      if (attr.value === '' || attr.value.toLowerCase().startsWith('data:')) continue;
      add(
        'single-file',
        `<${tag.name} ${attr.name}="${attr.value}"> references an external resource`,
      );
    }
  }
  if (/@import\b/i.test(styles)) add('single-file', 'CSS @import is an external reference');
  for (const m of styles.matchAll(/\burl\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi)) {
    const target = (m[2] ?? '').trim();
    if (!target.toLowerCase().startsWith('data:')) {
      add('single-file', `CSS url(${target}) references an external resource`);
    }
  }

  // ── no-network / no-storage / no-navigation (script + handler text) ───────
  for (const [re, token] of NETWORK_TOKENS) {
    if (re.test(scripts)) add('no-network', `banned network identifier in script text: ${token}`);
  }
  for (const [re, token] of STORAGE_TOKENS) {
    if (re.test(scripts)) add('no-storage', `banned storage identifier in script text: ${token}`);
  }
  for (const [re, token] of NAVIGATION_TOKENS) {
    if (re.test(scripts)) {
      add('no-navigation', `banned navigation identifier in script text: ${token}`);
    }
  }
  // Navigation via markup: meta refresh, <form action>, <a href> to anywhere
  // (a sandboxed resource page has no legitimate link target — conservative).
  for (const tag of tags) {
    if (
      tag.name === 'meta' &&
      tag.attrs.some((a) => a.name === 'http-equiv' && /refresh/i.test(a.value))
    ) {
      add('no-navigation', 'meta refresh is navigation');
    }
    if (tag.name === 'form' && tag.attrs.some((a) => a.name === 'action')) {
      add('no-navigation', '<form action> submits away from the page');
    }
    if (tag.name === 'a') {
      const href = tag.attrs.find((a) => a.name === 'href');
      if (href !== undefined && href.value !== '' && !href.value.startsWith('#')) {
        add('no-navigation', `<a href="${href.value}"> navigates away from the page`);
      }
    }
  }

  // ── bridge-only ───────────────────────────────────────────────────────────
  // The ONLY channel is the ui-bridge postMessage JSON-RPC, and the page must
  // signal ui/ready (ui-bridge.md: the shell hides its loading state on it).
  if (scripts.trim() === '') {
    add('bridge-only', 'no script: the page cannot signal ui/ready over the ui-bridge');
  } else {
    if (!scripts.includes('ReactNativeWebView') || !scripts.includes('postMessage')) {
      add('bridge-only', 'script never posts via window.ReactNativeWebView.postMessage');
    }
    if (!scripts.includes('ui/ready')) {
      add('bridge-only', 'script never signals ui/ready');
    }
    for (const [re, token] of BRIDGE_ESCAPE_TOKENS) {
      if (re.test(scripts)) {
        add('bridge-only', `frame-escape identifier in script text: ${token}`);
      }
    }
  }

  // ── degradable-render ─────────────────────────────────────────────────────
  // A non-empty STATIC <body> must exist without any tool result: markup
  // present, not a script-built-only body. Skipped when <body> is missing —
  // that is already a well-formed violation, not a second finding.
  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(stripped);
  if (bodyMatch !== null) {
    const staticBody = (bodyMatch[1] ?? '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
      .replace(/<[^>]*>/g, '')
      .trim();
    if (staticBody === '') {
      add('degradable-render', 'no static markup in <body> — the page renders blank without tools');
    }
  }

  return { valid: violations.length === 0, violations };
}
