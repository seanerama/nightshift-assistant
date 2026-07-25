/**
 * Job-type registry (Stage 6, spec "Registry rendering"): each type renders
 * the expected instruction/workdir/title/permission args, unknown types throw
 * listing the known set, params are validated per type, and the extraEnv
 * extension is name-explicit on top of workerEnv() with the WEBEX_ and
 * NIGHTSHIFT_ prefixes blocked no matter what an entry lists.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workerEnvWith } from '../src/jobs/env.js';
import {
  getJobType,
  JobTypeError,
  jobTypesPreamble,
  knownJobTypes,
  renderJobType,
  slugify,
} from '../src/jobs/types.js';

const HOME = '/home/tester';

describe('job-type registry', () => {
  it('registers exactly the Stage 6 catalog (+ guide, Stage 16; + note-ingest, Stage 20)', () => {
    expect(knownJobTypes()).toEqual([
      'generic',
      'story',
      'study',
      'brief',
      'guide',
      'note-ingest',
      'app-build',
    ]);
  });

  it('assigns the Stage 12 per-type worker models (deliberate, never host-inherited)', () => {
    expect(getJobType('generic')?.model).toBe('claude-sonnet-5');
    for (const t of ['story', 'study', 'brief', 'guide', 'note-ingest', 'app-build']) {
      expect(getJobType(t)?.model, `${t} runs on Opus`).toBe('claude-opus-4-8');
    }
  });

  it('gives note-ingest a tight per-type timeout; other types inherit the config default (Stage 21)', () => {
    // The interactive INBOX type is the one observed to stall — bound at 15m.
    expect(getJobType('note-ingest')?.timeoutMs).toBe(900_000);
    // Everyone else omits timeoutMs → inherits NIGHTSHIFT_JOB_TIMEOUT_MS.
    for (const t of ['generic', 'story', 'study', 'brief', 'guide', 'app-build']) {
      expect(getJobType(t)?.timeoutMs, `${t} inherits the default`).toBeUndefined();
    }
  });

  describe('rendering per type', () => {
    it('story → /story:start with the idea, ~/projects/<slug> workdir, scoped write profile', () => {
      const r = renderJobType('story', { idea: 'a turtle who is afraid of water' }, HOME);
      expect(r.type).toBe('story');
      expect(r.instruction).toContain('/story:start a turtle who is afraid of water');
      expect(r.instruction).toContain('/story:next');
      expect(r.workdir).toBe(join(HOME, 'projects', 'a-turtle-who-is-afraid-of-water'));
      expect(r.title).toBe('Story: a turtle who is afraid of water');
      expect(r.permissionArgs).toContain('--permission-mode');
      expect(r.permissionArgs).toContain('acceptEdits');
      expect(r.permissionArgs).toContain('--allowedTools');
      // Stage 18: the research seam — the ONE server-level MCP rule, and only
      // that server (a bare mcp__* must never appear in any profile).
      const allowed = r.permissionArgs[r.permissionArgs.indexOf('--allowedTools') + 1] ?? '';
      expect(allowed).toContain('mcp__perplexity');
      expect(allowed).not.toMatch(/mcp__\*|mcp__ /);
      expect(r.extraEnv).toContain('ELEVENLABS_API_KEY');
      expect(r.extraEnv).toContain('GEMINI_API_KEY');
      expect(r.model).toBe('claude-opus-4-8'); // Stage 12: pipeline workers run Opus
    });

    it('story title param drives the slug, the job title, and the instruction', () => {
      const r = renderJobType(
        'story',
        { idea: 'bigfoot makes a friend', title: 'Freddie Bigfoot' },
        HOME,
      );
      expect(r.workdir).toBe(join(HOME, 'projects', 'freddie-bigfoot'));
      expect(r.title).toBe('Story: Freddie Bigfoot');
      expect(r.instruction).toContain('Use the story title: "Freddie Bigfoot"');
    });

    it('study → /sws:start with the topic and the Perplexity key declared', () => {
      const r = renderJobType('study', { topic: 'BGP fundamentals' }, HOME);
      expect(r.instruction).toContain('/sws:start BGP fundamentals');
      expect(r.workdir).toBe(join(HOME, 'projects', 'bgp-fundamentals'));
      expect(r.title).toBe('Study: BGP fundamentals');
      expect(r.permissionArgs).toEqual(getJobType('story')?.permissionArgs);
      expect(r.extraEnv).toEqual(['PERPLEXITY_API_KEY']);
    });

    it('brief → /brief:run with the profile', () => {
      const r = renderJobType('brief', { profile: 'network-engineer' }, HOME);
      expect(r.instruction).toContain('/brief:run network-engineer');
      expect(r.workdir).toBe(join(HOME, 'projects', 'brief-network-engineer'));
      expect(r.title).toBe('Brief: network-engineer');
      expect(r.permissionArgs).toEqual(getJobType('story')?.permissionArgs);
    });

    it('guide → /tg:start with the topic, ~/projects/<slug> workdir, Perplexity key (Stage 16)', () => {
      const r = renderJobType('guide', { topic: 'eBPF observability' }, HOME);
      expect(r.type).toBe('guide');
      expect(r.instruction).toContain('/tg:start eBPF observability');
      expect(r.instruction).toContain('scope → research → write → diagrams → build');
      expect(r.workdir).toBe(join(HOME, 'projects', 'ebpf-observability'));
      expect(r.title).toBe('Guide: eBPF observability');
      expect(r.permissionArgs).toEqual(getJobType('story')?.permissionArgs);
      expect(r.extraEnv).toEqual(['PERPLEXITY_API_KEY']);
      expect(r.model).toBe('claude-opus-4-8'); // Stage 12: pipeline workers run Opus
      expect(getJobType('guide')?.experimental).toBe(false);
    });

    it.each([
      'deep',
      'comparison',
      'explainer',
    ])('guide variant "%s" renders a variant-directing line', (variant) => {
      const r = renderJobType('guide', { topic: 'react vs vue', variant }, HOME);
      expect(r.instruction).toContain(`Use the techguide variant: "${variant}".`);
    });

    it('guide title suffixes comparison/explainer but NOT deep (the skill default)', () => {
      const title = (variant: string): string =>
        renderJobType('guide', { topic: 'react vs vue', variant }, HOME).title;
      expect(title('comparison')).toBe('Guide: react vs vue (comparison)');
      expect(title('explainer')).toBe('Guide: react vs vue (explainer)');
      expect(title('deep')).toBe('Guide: react vs vue');
    });

    it('guide with variant omitted → no variant line, no title suffix (skill owns the default)', () => {
      const r = renderJobType('guide', { topic: 'zsh internals' }, HOME);
      expect(r.instruction).not.toContain('variant');
      expect(r.title).toBe('Guide: zsh internals');
    });

    it('app-build → SDD instruction with the BROADEST profile, flagged experimental', () => {
      const r = renderJobType('app-build', { idea: 'a habit tracker', name: 'habits' }, HOME);
      expect(r.instruction).toContain('/sdd:start');
      expect(r.instruction).toContain('a habit tracker');
      expect(r.workdir).toBe(join(HOME, 'projects', 'habits'));
      expect(r.permissionArgs).toEqual(['--permission-mode', 'bypassPermissions']);
      expect(r.extraEnv).toEqual([]);
      expect(r.model).toBe('claude-opus-4-8'); // Stage 12
      expect(getJobType('app-build')?.experimental).toBe(true);
    });

    it('generic → instruction verbatim, caller workdir, NO permission args, NO extra env', () => {
      const r = renderJobType(
        'generic',
        { instruction: 'echo hi > out.txt', workdir: '/tmp/anywhere', title: 'echo job' },
        HOME,
      );
      expect(r.instruction).toBe('echo hi > out.txt');
      expect(r.workdir).toBe('/tmp/anywhere'); // caller-provided, no ~/projects derivation
      expect(r.title).toBe('echo job');
      expect(r.permissionArgs).toEqual([]);
      expect(r.extraEnv).toEqual([]);
      expect(r.model).toBe('claude-sonnet-5'); // Stage 12: generic stays on Sonnet
      expect(getJobType('generic')?.experimental).toBe(false);
    });
  });

  describe('note-ingest (Stage 20 — reMarkable note interpretation)', () => {
    const validParams = {
      note_id: 'abc-123',
      doc_name: 'Grocery ideas',
      source_folder: '/Outbound',
      text: 'Remind me to buy milk and draft a shopping list.',
      images_dir: '',
    };

    it('validateParams accepts a full note-submission params object', () => {
      expect(() => getJobType('note-ingest')?.validateParams(validParams)).not.toThrow();
      // text/images_dir may be '' (frozen shape always sends them).
      expect(() =>
        getJobType('note-ingest')?.validateParams({
          note_id: 'n',
          doc_name: 'd',
          source_folder: '/Outbound',
          text: '',
          images_dir: '',
        }),
      ).not.toThrow();
    });

    it.each([
      ['note_id', { doc_name: 'd', source_folder: '/Outbound' }],
      ['doc_name', { note_id: 'n', source_folder: '/Outbound' }],
      ['source_folder', { note_id: 'n', doc_name: 'd' }],
    ])('validateParams rejects missing %s', (field, params) => {
      expect(() => renderJobType('note-ingest', params, HOME)).toThrow(
        new RegExp(`invalid params for type 'note-ingest'.*"${field}"`),
      );
    });

    it('instructionTemplate includes the typed text, source folder, and both delivery options', () => {
      const r = renderJobType('note-ingest', validParams, HOME);
      expect(r.instruction).toContain('/Outbound');
      expect(r.instruction).toContain('Remind me to buy milk and draft a shopping list.');
      // Both delivery CLIs are named.
      expect(r.instruction).toContain('nightshift deliver');
      expect(r.instruction).toContain('remarkable-bridge push --md');
      // No images_dir → no image-reading instruction.
      expect(r.instruction).not.toContain('page-NN.png');
    });

    it('instructionTemplate adds the page-NN.png image-reading instruction when images_dir is set', () => {
      const dir = mkdtempSync(join(tmpdir(), 'note-imgs-'));
      const r = renderJobType('note-ingest', { ...validParams, images_dir: dir }, HOME);
      expect(r.instruction).toContain('page-NN.png');
      expect(r.instruction).toContain('READ');
      // Both delivery options still present alongside the image instruction.
      expect(r.instruction).toContain('nightshift deliver');
      expect(r.instruction).toContain('remarkable-bridge push --md');
    });

    it('workdirStrategy returns images_dir when it is an existing absolute path', () => {
      const dir = mkdtempSync(join(tmpdir(), 'note-imgs-'));
      const r = renderJobType('note-ingest', { ...validParams, images_dir: dir }, HOME);
      expect(r.workdir).toBe(dir);
    });

    it('workdirStrategy falls back to a ~/projects scratch dir when images_dir is empty or absent', () => {
      const r = renderJobType('note-ingest', validParams, HOME);
      expect(r.workdir).toBe(join(HOME, 'projects', 'note-abc-123'));
      // A non-existent images_dir path is ignored too (scratch fallback).
      const r2 = renderJobType(
        'note-ingest',
        { ...validParams, images_dir: '/no/such/dir/xyz' },
        HOME,
      );
      expect(r2.workdir).toBe(join(HOME, 'projects', 'note-abc-123'));
    });

    it('titleTemplate is `note: <doc_name>`', () => {
      const r = renderJobType('note-ingest', validParams, HOME);
      expect(r.title).toBe('note: Grocery ideas');
    });

    it('model is the heavy reasoning model, not experimental', () => {
      expect(getJobType('note-ingest')?.model).toBe('claude-opus-4-8');
      expect(getJobType('note-ingest')?.experimental).toBe(false);
    });

    it('permissionArgs is EXACTLY the least-privilege set — file tools + the two delivery CLIs, NO arbitrary Bash', () => {
      const args = getJobType('note-ingest')?.permissionArgs ?? [];
      expect(args).toEqual([
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Read Grep Glob Write Bash(nightshift deliver *) Bash(remarkable-bridge push *)',
      ]);
      const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
      // Only the two scoped Bash prefixes — never bare `Bash` or `Bash(*)`.
      expect(allowed).toContain('Bash(nightshift deliver *)');
      expect(allowed).toContain('Bash(remarkable-bridge push *)');
      expect(/(^| )Bash( |$)/.test(allowed), 'no bare Bash').toBe(false);
      expect(allowed).not.toContain('Bash(*)');
      expect(allowed).not.toContain('bypassPermissions');
    });

    it('extraEnv names only RMAPI_BIN (no blocked-prefix var) and forwards it name-explicitly', () => {
      expect(getJobType('note-ingest')?.extraEnv).toEqual(['RMAPI_BIN']);
      const env = workerEnvWith(getJobType('note-ingest')?.extraEnv ?? [], {
        PATH: '/usr/bin',
        HOME: '/home/u',
        RMAPI_BIN: '/opt/rmapi/rmapi',
        WEBEX_BOT_TOKEN: 'secret',
        NIGHTSHIFT_API_TOKEN: 'secret',
      });
      expect(env.RMAPI_BIN).toBe('/opt/rmapi/rmapi');
      expect(env.WEBEX_BOT_TOKEN).toBeUndefined();
      expect(env.NIGHTSHIFT_API_TOKEN).toBeUndefined();
    });
  });

  describe('the scoped pipeline profile (probe-verified posture)', () => {
    it('never wholesale-allows Bash or the file tools (workdir scoping would break)', () => {
      const args = getJobType('story')?.permissionArgs ?? [];
      const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
      // A bare tool name is one NOT followed by a "(rule)" specifier.
      for (const forbidden of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']) {
        expect(
          new RegExp(`(^| )${forbidden}( |$)`).test(allowed),
          `bare '${forbidden}' must not be allowed wholesale`,
        ).toBe(false);
      }
      // Prefix-scoped Bash for the pipeline helpers IS present.
      expect(allowed).toContain('Bash(node *)');
      expect(allowed).toContain('Bash(ffmpeg *)');
    });
  });

  describe('unknown types and params validation', () => {
    it('unknown type throws a JobTypeError listing every known type', () => {
      try {
        renderJobType('research', {}, HOME);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(JobTypeError);
        const msg = (err as Error).message;
        expect(msg).toContain('unknown job type: research');
        for (const t of knownJobTypes()) expect(msg).toContain(t);
      }
    });

    it.each([
      ['story', {}, 'idea'],
      ['story', { idea: '   ' }, 'idea'],
      ['story', { idea: 'x', title: 7 }, 'title'],
      ['study', {}, 'topic'],
      ['brief', {}, 'profile'],
      ['guide', {}, 'topic'],
      ['guide', { topic: 'x', variant: 7 }, 'variant'],
      ['app-build', {}, 'idea'],
      ['generic', { workdir: '/tmp' }, 'instruction'],
      ['generic', { instruction: 'x' }, 'workdir'],
    ])('%s with params %o rejects naming "%s"', (type, params, field) => {
      expect(() => renderJobType(type, params, HOME)).toThrow(
        new RegExp(`invalid params for type '${type}'.*"${field}"`),
      );
    });

    it('guide rejects a variant outside the closed set with a JobTypeError', () => {
      expect(() => renderJobType('guide', { topic: 'x', variant: 'quick' }, HOME)).toThrow(
        JobTypeError,
      );
      expect(() => renderJobType('guide', { topic: 'x', variant: 'quick' }, HOME)).toThrow(
        /invalid params for type 'guide': "variant" must be one of 'deep' \| 'comparison' \| 'explainer'/,
      );
    });

    it('non-object params reject clearly', () => {
      expect(() => renderJobType('story', 'just a string', HOME)).toThrow(/JSON object/);
      expect(() => renderJobType('story', ['idea'], HOME)).toThrow(/JSON object/);
      expect(() => renderJobType('story', null, HOME)).toThrow(/JSON object/);
    });
  });

  describe('slugify', () => {
    it.each([
      ['A  Story: About Dragons!!', 'a-story-about-dragons'],
      ['freddie bigfoot', 'freddie-bigfoot'],
      ['///', 'job'],
      ['x'.repeat(80), 'x'.repeat(40)],
    ])('%s → %s', (input, expected) => {
      expect(slugify(input)).toBe(expected);
    });
  });

  describe('workerEnvWith (name-explicit extension of the default-deny base)', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/home/u',
      ELEVENLABS_API_KEY: 'tts-key',
      PERPLEXITY_API_KEY: 'pplx-key',
      WEBEX_BOT_TOKEN: 'bot-secret',
      NIGHTSHIFT_API_TOKEN: 'api-secret',
      CF_DNS_TOKEN: 'cf-secret',
      COOLIFY_API_TOKEN: 'coolify-secret',
    };

    it('copies the named extras that exist and nothing else', () => {
      const env = workerEnvWith(['ELEVENLABS_API_KEY', 'GEMINI_API_KEY'], base);
      expect(env).toEqual({
        PATH: '/usr/bin',
        HOME: '/home/u',
        ELEVENLABS_API_KEY: 'tts-key',
        // GEMINI_API_KEY absent in base → not forwarded; PERPLEXITY undeclared → absent.
      });
    });

    it('NEVER forwards WEBEX_*/NIGHTSHIFT_*/CF_*/COOLIFY_* even when a registry entry names them', () => {
      const env = workerEnvWith(
        ['WEBEX_BOT_TOKEN', 'NIGHTSHIFT_API_TOKEN', 'CF_DNS_TOKEN', 'COOLIFY_API_TOKEN'],
        base,
      );
      expect(env.WEBEX_BOT_TOKEN).toBeUndefined();
      expect(env.NIGHTSHIFT_API_TOKEN).toBeUndefined();
      // Stage 11 (ADR 0008): the promotion infra prefixes are hard-blocked too.
      expect(env.CF_DNS_TOKEN).toBeUndefined();
      expect(env.COOLIFY_API_TOKEN).toBeUndefined();
    });
  });

  describe('session preamble', () => {
    it('lists every type with one-line usage and flags app-build experimental', () => {
      const preamble = jobTypesPreamble();
      expect(preamble).toContain("nightshift submit --type <type> --params '<json>'");
      for (const t of knownJobTypes()) expect(preamble).toContain(`- ${t}`);
      expect(preamble).toContain('EXPERIMENTAL');
      // Stage 16: the guide usage line reaches new sessions automatically.
      expect(preamble).toContain(
        '- guide — interactive tech guide via the /tg:* Techguide pipeline; params {"topic": "...", "variant"?: "deep" | "comparison" | "explainer"}',
      );
    });
  });
});
