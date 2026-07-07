/**
 * Job-type registry (Stage 6, spec "Registry rendering"): each type renders
 * the expected instruction/workdir/title/permission args, unknown types throw
 * listing the known set, params are validated per type, and the extraEnv
 * extension is name-explicit on top of workerEnv() with the WEBEX_ and
 * NIGHTSHIFT_ prefixes blocked no matter what an entry lists.
 */

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
  it('registers exactly the Stage 6 catalog', () => {
    expect(knownJobTypes()).toEqual(['generic', 'story', 'study', 'brief', 'app-build']);
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
      expect(r.extraEnv).toContain('ELEVENLABS_API_KEY');
      expect(r.extraEnv).toContain('GEMINI_API_KEY');
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

    it('app-build → SDD instruction with the BROADEST profile, flagged experimental', () => {
      const r = renderJobType('app-build', { idea: 'a habit tracker', name: 'habits' }, HOME);
      expect(r.instruction).toContain('/sdd:start');
      expect(r.instruction).toContain('a habit tracker');
      expect(r.workdir).toBe(join(HOME, 'projects', 'habits'));
      expect(r.permissionArgs).toEqual(['--permission-mode', 'bypassPermissions']);
      expect(r.extraEnv).toEqual([]);
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
      expect(getJobType('generic')?.experimental).toBe(false);
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
      ['app-build', {}, 'idea'],
      ['generic', { workdir: '/tmp' }, 'instruction'],
      ['generic', { instruction: 'x' }, 'workdir'],
    ])('%s with params %o rejects naming "%s"', (type, params, field) => {
      expect(() => renderJobType(type, params, HOME)).toThrow(
        new RegExp(`invalid params for type '${type}'.*"${field}"`),
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
    });
  });
});
