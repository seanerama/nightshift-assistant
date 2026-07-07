/**
 * Job-type registry (Stage 6): the declarative table mapping a job TYPE to how
 * its worker runs — the instruction it executes, where it runs, the PERMISSION
 * PROFILE its claude session gets, and which extra env var NAMES (never
 * wholesale) are copied on top of the default-deny workerEnv().
 *
 * Skills (/story:start, /sws:start, /brief:run, /sdd:start) resolve from the
 * HOST's ~/.claude installation at worker runtime — this registry stores
 * invocation strings only; it does NOT vendor or verify the skills (the
 * Stage 6 host smoke does that).
 *
 * Permission profiles are claude CLI args, VERIFIED against the installed CLI
 * v2.1.201 (2026-07-06) — `claude --help` plus a headless probe run under
 * `--permission-mode acceptEdits --allowedTools "Bash(echo *)"` with cwd set
 * to a scratch workdir:
 *   - the allowed-prefix Bash command executed (no denial);
 *   - an in-cwd Write auto-accepted (acceptEdits);
 *   - Read of a file OUTSIDE the workdir was DENIED (permission_denials);
 *   - Bash `cat` of that outside file was DENIED ("may only concatenate files
 *     from the allowed working directory").
 * That is exactly the scoped write-capable posture the pipeline types need:
 * file tools are workdir-scoped by the CLI itself, so the profile deliberately
 * does NOT wholesale-allow Read/Edit/Write/Glob/Grep (a bare `Read` rule would
 * also allow reads OUTSIDE the workdir — e.g. the daemon's .env).
 *
 * ARGV ORDER WARNING (verified empirically the same day): `--allowedTools` is
 * VARIADIC — a bare prompt following it is swallowed as a tool name. The
 * runner therefore appends permissionArgs AFTER `-p <prompt> --session-id
 * <id>`; never reorder.
 */

import { join } from 'node:path';

/** Rejected type/params input (unknown type, bad params). Mapped to 400 upstream. */
export class JobTypeError extends Error {}

/**
 * Per-type worker models (Stage 12, issue #22): chosen deliberately instead of
 * inherited from the host claude config (which silently served Opus 4.7 for
 * everything). Passed as `--model` on the worker spawn (runner.ts) — a
 * single-value flag, placed BEFORE the variadic permission args per the argv
 * order warning above. Models are invisible to the operator surface: the
 * registry preamble deliberately does not mention them.
 */
export const WORKER_MODEL_GENERIC = 'claude-sonnet-5';
export const WORKER_MODEL_HEAVY = 'claude-opus-4-8';

export type JobParams = Record<string, unknown>;

export interface RenderedJob {
  /** Registry type — becomes the jobs row's type column. */
  type: string;
  title: string;
  instruction: string;
  workdir: string;
  permissionArgs: readonly string[];
  extraEnv: readonly string[];
  /** The worker's claude model (Stage 12) — spawned as `--model <id>`. */
  model: string;
}

export interface JobTypeEntry {
  type: string;
  /** Marked experimental entries carry the broadest profiles — flagged in the preamble. */
  experimental: boolean;
  /** One-line usage for the session capability preamble. */
  usage: string;
  /** Throws JobTypeError when required params are missing/malformed. */
  validateParams(params: JobParams): void;
  instructionTemplate(params: JobParams): string;
  workdirStrategy(params: JobParams, home: string): string;
  titleTemplate(params: JobParams): string;
  /** claude CLI args appended to the worker spawn (see header for verification). */
  permissionArgs: readonly string[];
  /** Env var NAMES copied from the daemon env if present — explicit, never wholesale. */
  extraEnv: readonly string[];
  /** The worker's claude model (Stage 12) — spawned as `--model <id>`. */
  model: string;
}

/** ~/projects/<slug>-style slug: lowercase, alnum runs joined by '-', bounded. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug === '' ? 'job' : slug;
}

const truncate = (text: string, max = 60): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Required non-empty string param, or a JobTypeError naming type + field. */
function requireString(type: string, params: JobParams, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new JobTypeError(
      `invalid params for type '${type}': "${key}" must be a non-empty string`,
    );
  }
  return value.trim();
}

/** Optional string param ('' and non-strings rejected the same way when present). */
function optionalString(type: string, params: JobParams, key: string): string | undefined {
  if (params[key] === undefined) return undefined;
  return requireString(type, params, key);
}

/**
 * The scoped write-capable profile shared by the content pipelines
 * (story/study/brief): acceptEdits auto-accepts file edits INSIDE the workdir
 * (out-of-workdir file access stays denied — probe-verified, see header), and
 * the Bash allow-list is prefix-scoped to the tools the skill pipelines
 * actually run (node/python3 helpers, ffmpeg/ffprobe assembly, curl for TTS/
 * image APIs). Deliberately absent: bare `Bash`, bare `Read`/`Edit`/`Write`
 * (each would break the workdir scoping), and `cat` (Read covers in-workdir).
 */
const PIPELINE_ALLOWED_TOOLS = [
  'Skill',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Bash(node *)',
  'Bash(python3 *)',
  'Bash(ffmpeg *)',
  'Bash(ffprobe *)',
  'Bash(bash *)',
  'Bash(sh *)',
  'Bash(mkdir *)',
  'Bash(ls *)',
  'Bash(cp *)',
  'Bash(mv *)',
  'Bash(curl *)',
].join(' ');

const PIPELINE_PERMISSION_ARGS: readonly string[] = [
  '--permission-mode',
  'acceptEdits',
  '--allowedTools',
  PIPELINE_ALLOWED_TOOLS,
];

/**
 * Broadest profile — the old NSAF posture. EXPERIMENTAL: app-build only,
 * clearly flagged; every other type must use a scoped profile.
 */
const APP_BUILD_PERMISSION_ARGS: readonly string[] = ['--permission-mode', 'bypassPermissions'];

const AUTONOMY_NOTE =
  'Work fully autonomously: never ask questions or wait for input; make reasonable choices and continue.';

const registry: readonly JobTypeEntry[] = [
  {
    // The current default: instruction verbatim, caller-provided workdir,
    // near-zero permissions (NO permission args, NO extra env — the Stage 4/5
    // worker, byte-identical; test-pinned in test/jobs.test.ts).
    type: 'generic',
    experimental: false,
    usage:
      'generic — run an instruction verbatim with the near-zero default worker permissions; params {"instruction": "...", "workdir": "...", "title"?: "..."} (the flag form --title/--instruction/--workdir does the same)',
    validateParams(params) {
      requireString('generic', params, 'instruction');
      requireString('generic', params, 'workdir');
    },
    instructionTemplate: (params) => requireString('generic', params, 'instruction'),
    workdirStrategy: (params) => requireString('generic', params, 'workdir'),
    titleTemplate: (params) =>
      optionalString('generic', params, 'title') ??
      truncate(requireString('generic', params, 'instruction')),
    permissionArgs: [],
    extraEnv: [],
    model: WORKER_MODEL_GENERIC,
  },
  {
    type: 'story',
    experimental: false,
    usage:
      'story — illustrated audio story via the /story:* pipeline; params {"idea": "...", "title"?: "..."}',
    validateParams(params) {
      requireString('story', params, 'idea');
      optionalString('story', params, 'title');
    },
    instructionTemplate(params) {
      const idea = requireString('story', params, 'idea');
      const title = optionalString('story', params, 'title');
      return (
        `/story:start ${idea}` +
        (title === undefined ? '' : `\n\nUse the story title: "${title}".`) +
        '\n\nRun the story pipeline stage by stage with /story:next (outline → write → ' +
        'portraits → illustrate → narrate → build) until the final video exists. ' +
        AUTONOMY_NOTE
      );
    },
    workdirStrategy: (params, home) =>
      join(
        home,
        'projects',
        slugify(optionalString('story', params, 'title') ?? requireString('story', params, 'idea')),
      ),
    titleTemplate: (params) =>
      `Story: ${optionalString('story', params, 'title') ?? truncate(requireString('story', params, 'idea'))}`,
    permissionArgs: PIPELINE_PERMISSION_ARGS,
    // The story pipeline's TTS/image keys, by NAME (ElevenLabs narration,
    // Gemini/Nano-Banana illustration, OpenAI TTS fallback).
    extraEnv: [
      'ELEVENLABS_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'NANOBANANA_API_KEY',
    ],
    model: WORKER_MODEL_HEAVY,
  },
  {
    type: 'study',
    experimental: false,
    usage: 'study — StudyWS learning pipeline via /sws:*; params {"topic": "..."}',
    validateParams(params) {
      requireString('study', params, 'topic');
    },
    instructionTemplate(params) {
      const topic = requireString('study', params, 'topic');
      return (
        `/sws:start ${topic}` +
        '\n\nRun the StudyWS pipeline to completion (scope → research → write → ' +
        `diagrams → guide) for this topic. ${AUTONOMY_NOTE}`
      );
    },
    workdirStrategy: (params, home) =>
      join(home, 'projects', slugify(requireString('study', params, 'topic'))),
    titleTemplate: (params) => `Study: ${truncate(requireString('study', params, 'topic'))}`,
    permissionArgs: PIPELINE_PERMISSION_ARGS,
    // sws:research fans out through Perplexity.
    extraEnv: ['PERPLEXITY_API_KEY'],
    model: WORKER_MODEL_HEAVY,
  },
  {
    type: 'brief',
    experimental: false,
    usage: 'brief — Daily-Brief sweep via /brief:run; params {"profile": "..."}',
    validateParams(params) {
      requireString('brief', params, 'profile');
    },
    instructionTemplate(params) {
      const profile = requireString('brief', params, 'profile');
      return `/brief:run ${profile}\n\n${AUTONOMY_NOTE}`;
    },
    workdirStrategy: (params, home) =>
      join(home, 'projects', slugify(`brief-${requireString('brief', params, 'profile')}`)),
    titleTemplate: (params) => `Brief: ${truncate(requireString('brief', params, 'profile'))}`,
    permissionArgs: PIPELINE_PERMISSION_ARGS,
    extraEnv: ['PERPLEXITY_API_KEY'],
    model: WORKER_MODEL_HEAVY,
  },
  {
    // EXPERIMENTAL — the old NSAF posture: an unattended SDD build with the
    // broadest profile. Include per the stage spec, but flagged everywhere.
    type: 'app-build',
    experimental: true,
    usage:
      'app-build (EXPERIMENTAL, broad permissions) — unattended SDD application build; params {"idea": "...", "name"?: "..."}',
    validateParams(params) {
      requireString('app-build', params, 'idea');
      optionalString('app-build', params, 'name');
    },
    instructionTemplate(params) {
      const idea = requireString('app-build', params, 'idea');
      return (
        'Build this application end-to-end with the SDD workflow: begin with ' +
        '/sdd:start and drive the workflow stages (vision → architect → plan → ' +
        'build → test) until the project builds and its tests pass. ' +
        `${AUTONOMY_NOTE}\n\nProject idea: ${idea}`
      );
    },
    workdirStrategy: (params, home) =>
      join(
        home,
        'projects',
        slugify(
          optionalString('app-build', params, 'name') ?? requireString('app-build', params, 'idea'),
        ),
      ),
    titleTemplate: (params) =>
      `App build: ${optionalString('app-build', params, 'name') ?? truncate(requireString('app-build', params, 'idea'))}`,
    permissionArgs: APP_BUILD_PERMISSION_ARGS,
    extraEnv: [],
    model: WORKER_MODEL_HEAVY,
  },
];

export function knownJobTypes(): string[] {
  return registry.map((entry) => entry.type);
}

export function getJobType(type: string): JobTypeEntry | undefined {
  return registry.find((entry) => entry.type === type);
}

/**
 * Validate + render a typed submit into the concrete job fields plus the
 * spawn-time profile. Unknown type → JobTypeError listing the known types.
 */
export function renderJobType(type: string, params: unknown, home: string): RenderedJob {
  const entry = getJobType(type);
  if (entry === undefined) {
    throw new JobTypeError(
      `unknown job type: ${type} (known types: ${knownJobTypes().join(', ')})`,
    );
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new JobTypeError(`invalid params for type '${type}': params must be a JSON object`);
  }
  const p = params as JobParams;
  entry.validateParams(p);
  return {
    type: entry.type,
    title: entry.titleTemplate(p),
    instruction: entry.instructionTemplate(p),
    workdir: entry.workdirStrategy(p, home),
    permissionArgs: entry.permissionArgs,
    extraEnv: entry.extraEnv,
    model: entry.model,
  };
}

/**
 * The dispatchable-type list for the session capability preamble (Stage 6
 * extension of CONTROL_PREAMBLE) — one line of usage per registered type.
 */
export function jobTypesPreamble(): string {
  return [
    "Job types you can dispatch with `nightshift submit --type <type> --params '<json>'` (the daemon renders the instruction, workdir, and worker permission profile from the type):",
    ...registry.map((entry) => `- ${entry.usage}`),
  ].join('\n');
}
