/**
 * App MCP endpoint (contracts/app-ingress.md v1, ADR 0012): POST /app/v1/mcp
 * via the official TypeScript MCP SDK (streamable HTTP), mounted inside the
 * app transport dispatch — so it inherits the bearer gate (401 precedes 404),
 * the APP_TRANSPORT_ENABLED flag, and the containment posture.
 *
 * The certified FIVE tools, each a thin door over the SAME internals the
 * control API's handlers call (src/transport/api.ts → App.jobs /
 * App.sessions): status, jobs_list, jobs_submit, jobs_kill, session_rotate.
 * The tool layer validates arguments and translates shapes — no business
 * logic, and the results carry the frozen JobRecord/RotationRecord/status
 * shapes unmodified. Behavior parity with the control API (and therefore the
 * nightshift CLI) is by construction: a divergence is a bug by definition
 * (ADR 0012). Stage 37 (contracts/ui-state.md, ADR 0016) makes the catalog
 * flag-conditional: with NIGHTSHIFT_GENERATIVE_UI_ENABLED on, ui_state_get /
 * ui_state_set are APPENDED (thin doors over src/ui/state.ts — the same
 * truth as GET/POST /api/v1/ui/state/<name>); with it off, the advertised
 * catalog is the certified five, byte-identical.
 *
 * Transport posture: STATELESS streamable HTTP (a fresh SDK server + transport
 * per POST, `sessionIdGenerator: undefined`, JSON responses) — every certified
 * client call is a self-contained request/response, which is exactly how the
 * pinned conformance harness drives the endpoint. Two accommodations for that
 * harness (both transport-level, neither business logic):
 *   - Accept normalization: the SDK insists the Accept header lists BOTH
 *     application/json and text/event-stream; the pinned harness (and plain
 *     JSON-RPC clients) send application/json only. Responses here are always
 *     JSON, so the header is normalized before dispatch.
 *   - initialize normalization: the SDK requires params.clientInfo on
 *     initialize; the pinned contract treats it as optional (its harness never
 *     sends it). Missing fields are filled with neutral defaults — provided
 *     values are NEVER overridden.
 *
 * Stage 28 adds the resources half (mcp-apps-ui): ONE UI resource,
 * ui://nightshift/jobs@v1 — a single self-contained HTML jobs dashboard
 * (src/transport/app/resources/jobs-v1.html) served verbatim as text/html.
 * Its resource descriptor carries _meta["ui/tools"] = ["jobs_list",
 * "jobs_kill", "jobs_submit"] — the allowlist the client shell derives per
 * nightshift-client/contracts/ui-bridge.md (the convention lives in the
 * CLIENT repo; the HTML file header records that provenance). @v1 in the uri
 * is the version seam: a breaking dashboard change is a NEW @v2 resource,
 * never an edit (ADR 0012).
 *
 * Stage 31 (contracts/generative-ui.md, ADR 0015): when
 * NIGHTSHIFT_GENERATIVE_UI_ENABLED is on, the registry contributes MORE
 * resources — one entry per registry name (the ACTIVE version, as
 * ui://nightshift/<name>@v<N>, text/html) beside the hand-authored jobs
 * entry, and resources/read serves any exact registered @vN uri (active or
 * not — a listed client can always read what it saw listed). Their
 * _meta["ui/tools"] carries granted(name) ∩ requestedTools — [] this stage by
 * construction (no grant door exists until Stage 33; zero-trust). Flag off:
 * byte-identical to Stage 28 — the jobs entry only.
 *
 * Stage 34 (ADR 0015): the notification half. The per-POST server declares
 * `resources: { listChanged: true }`, and this module exports the
 * UiNotifyHub — the broadcaster behind GET /app/v1/mcp (the streamable-HTTP
 * spec's optional SSE stream for server-initiated messages, mounted in
 * server.ts under the same bearer/flag gate). Registry mutations (register /
 * activate / grant / revoke, all via the CONTROL API) call
 * notifyResourcesChanged() after commit; the hub writes one hand-authored
 * SSE frame carrying the JSON-RPC notification
 * {"jsonrpc":"2.0","method":"notifications/resources/list_changed"} to every
 * open stream — wire-identical to the SDK's own emitter, chosen over a
 * long-lived server+transport pair so the certified per-POST stateless
 * posture (ADR 0012) stays untouched. Best-effort by spec: zero listeners is
 * normal, writes never throw out of the hub, vanished clients are pruned.
 */

import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../../config.js';
import { JobError, type JobRunner } from '../../jobs/runner.js';
import type { Logger } from '../../log.js';
import type { SessionManager } from '../../session/manager.js';
import type { JobStatus, JobSubmit } from '../../types.js';
import { type UiRegistry, UiRegistryError, uiResourceUri } from '../../ui/registry.js';
import type { UiState } from '../../ui/state.js';
import { readRawBody } from '../server.js';

/** Mirrors src/transport/api.ts — the job-lifecycle contract's states. */
const JOB_STATUSES: readonly string[] = ['queued', 'running', 'succeeded', 'failed', 'killed'];

/** initialize fallback when the client names no protocolVersion (harness never does). */
const FALLBACK_PROTOCOL_VERSION = '2025-06-18';

export interface AppMcpDeps {
  config: Config;
  log: Logger;
  /** The SAME doors the control API uses (contracts/control-api.md). */
  jobs: JobRunner;
  sessions: SessionManager;
  /** Stage 31: the registry the resource surface reflects when the flag is on. */
  ui: UiRegistry;
  /** Stage 37 (contracts/ui-state.md): behind ui_state_get/ui_state_set. */
  uiState: UiState;
  version: string;
}

export interface AppMcp {
  /** Serve one POST /app/v1/mcp request (auth already passed in the dispatch). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

/**
 * The list_changed broadcaster (Stage 34, ADR 0015): tracks the open
 * GET /app/v1/mcp SSE streams and writes the resources/list_changed
 * notification to each. ONE hub is shared across both front doors (wired in
 * src/app.ts): mutations arrive via the loopback control API while the
 * streams live on the app transport.
 */
export interface UiNotifyHub {
  /** Bind one open GET stream; returns the detach for the close handler. */
  attach(res: ServerResponse): () => void;
  /**
   * Broadcast notifications/resources/list_changed to every open stream.
   * Best-effort by spec: NEVER throws — zero listeners is a no-op, a dead
   * stream is pruned (write-after-end guarded), a write failure is logged
   * and must never fail the mutation that triggered it.
   */
  notifyResourcesChanged(): void;
  /** Open-stream count (tests/observability). */
  size(): number;
}

/**
 * The one frame the hub emits — the JSON-RPC notification inside a standard
 * SSE `message` event, byte-identical to what the SDK's
 * sendResourceListChanged() would put on the wire.
 */
const LIST_CHANGED_FRAME =
  'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/resources/list_changed"}\n\n';

export function createUiNotifyHub(log: Logger): UiNotifyHub {
  const streams = new Set<ServerResponse>();
  return {
    attach(res: ServerResponse): () => void {
      streams.add(res);
      return (): void => {
        streams.delete(res);
      };
    },
    notifyResourcesChanged(): void {
      for (const res of streams) {
        // Write-after-end guard: a client that vanished without firing the
        // close handler yet is pruned here instead of written to.
        if (res.destroyed || res.writableEnded) {
          streams.delete(res);
          continue;
        }
        try {
          res.write(LIST_CHANGED_FRAME);
        } catch (err) {
          // Emission is fire-and-forget: log, prune, never propagate.
          streams.delete(res);
          log.warn('list_changed emit failed; stream pruned', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    },
    size(): number {
      return streams.size;
    },
  };
}

/** A rejected tool argument — maps to an isError tool result, like a 400 on the control API. */
class ToolArgumentError extends Error {}

/**
 * The five certified tools, in a fixed order with `status` FIRST: the
 * conformance harness calls the first advertised tool with empty arguments,
 * and status is the read-only no-argument door. These names are frozen
 * surface — Stage 28's UI resource allowlist references them; renaming is a
 * breaking change. With NIGHTSHIFT_GENERATIVE_UI_ENABLED off this const IS
 * the advertised catalog, byte-identical to the certified surface (do not
 * touch entries or order); with it on, STATE_TOOLS below is APPENDED.
 */
const TOOLS = [
  {
    name: 'status',
    description:
      'Daemon status: version, uptime, current session, job counts by status, rotation and ' +
      'jobs flags — the same fields as GET /api/v1/status (contracts/control-api.md).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'jobs_list',
    description:
      'List background jobs as frozen JobRecords (contracts/job-lifecycle.md), optionally ' +
      'filtered by status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: [...JOB_STATUSES],
          description: 'Only jobs in this state.',
        },
      },
    },
  },
  {
    name: 'jobs_submit',
    description:
      'Submit a background job — the same submit shapes as POST /api/v1/jobs: either the raw ' +
      'job-lifecycle shape { schema: 1, type, title, instruction, workdir, env: "minimal" } or ' +
      'a typed submit { type, params } rendered through the job-type registry. Returns the ' +
      'frozen JobRecord.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        schema: { type: 'integer', enum: [1], description: 'Raw shape: always 1.' },
        type: { type: 'string', description: 'Job type (both shapes).' },
        title: { type: 'string', description: 'Raw shape: human title.' },
        instruction: { type: 'string', description: "Raw shape: the worker session's task." },
        workdir: { type: 'string', description: 'Raw shape: directory the worker runs in.' },
        env: { type: 'string', enum: ['minimal'], description: 'Raw shape: always "minimal".' },
        params: {
          type: 'object',
          description: 'Typed shape: registry params; presence selects the typed submit.',
        },
      },
    },
  },
  {
    name: 'jobs_kill',
    description:
      'Kill a queued or running job (SIGTERM, then SIGKILL after the grace period). Returns ' +
      'the frozen JobRecord in its killed state.',
    inputSchema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Job id.' } },
      required: ['id'],
    },
  },
  {
    name: 'session_rotate',
    description:
      'Rotate the conversational session (summary → memory promotion → fresh seeded session). ' +
      'Returns the frozen RotationRecord (contracts/assistant-session.md).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: { type: 'string', enum: ['manual'], description: 'Only "manual" is accepted.' },
      },
    },
  },
];

/**
 * Stage 37 (contracts/ui-state.md v1, ADR 0016): the two ui-state tools,
 * appended AFTER the certified five only when NIGHTSHIFT_GENERATIVE_UI_ENABLED
 * is on — flag off, the advertised catalog stays byte-identical to TOOLS.
 * Thin doors over src/ui/state.ts (same truth as the /api/v1/ui/state/<name>
 * control doors). Grantable to generated pages via the ADR 0015 flow —
 * NOTE the contract's stated v1 caveat: tools/call carries no caller
 * identity, so a granted page can address ANY resource's state.
 */
const STATE_TOOLS = [
  {
    name: 'ui_state_get',
    description:
      "A UI resource's persisted state document (contracts/ui-state.md): the per-name JSON " +
      'value plus updatedAt — both null before the first set. State attaches to the resource ' +
      'NAME and survives restarts, version iteration, and rollback.',
    inputSchema: {
      type: 'object' as const,
      properties: { name: { type: 'string', description: 'Registered UI resource name.' } },
      required: ['name'],
    },
  },
  {
    name: 'ui_state_set',
    description:
      "Replace a UI resource's persisted state document (contracts/ui-state.md): value is any " +
      'JSON (object/array/scalar), serialized <= 65536 bytes UTF-8. Full-document replace, ' +
      'last-write-wins — no merge or keyed access in v1.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Registered UI resource name.' },
        value: { description: 'The whole new state document — any JSON value.' },
      },
      required: ['name', 'value'],
    },
  },
];

/** The one UI resource (Stage 28, ADR 0012). Naming: ui://<agent>/<name>@v<N>. */
const UI_RESOURCE_URI = 'ui://nightshift/jobs@v1';

/**
 * The dashboard's callable-tool declaration, carried as `_meta["ui/tools"]`
 * on the resource DESCRIPTOR (resources/list) — the location the client
 * shell's allowlist derivation reads (nightshift-client/contracts/ui-bridge.md
 * §Consumes; `_meta` is the MCP spec's extension point on descriptors) — and
 * repeated on the resources/read contents so the declaration survives a read.
 * Exactly these three names, referencing TOOLS entries above by exact name: a
 * rename there breaks this allowlist, which is why those names are frozen.
 */
const uiResourceMeta = (): Record<string, unknown> => ({
  'ui/tools': ['jobs_list', 'jobs_kill', 'jobs_submit'],
});

/**
 * The dashboard HTML, read once and served verbatim. The file ships beside
 * the compiled module (the build copies src/transport/app/resources/ into
 * dist/), so import.meta.url resolves it in both src (vitest) and dist runs.
 */
let uiResourceHtml: string | null = null;
function loadUiResourceHtml(): string {
  if (uiResourceHtml === null) {
    uiResourceHtml = readFileSync(new URL('./resources/jobs-v1.html', import.meta.url), 'utf8');
  }
  return uiResourceHtml;
}

/** First value of a possibly-repeated header. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Fill the initialize params the SDK requires but the pinned contract treats
 * as optional. Provided values pass through untouched; only ABSENT fields get
 * neutral defaults. Non-initialize messages come back unchanged.
 */
function normalizeInitialize(message: unknown): unknown {
  if (Array.isArray(message)) return message.map((m) => normalizeInitialize(m));
  if (typeof message !== 'object' || message === null) return message;
  const msg = message as Record<string, unknown>;
  if (msg.method !== 'initialize') return message;
  const params = (
    typeof msg.params === 'object' && msg.params !== null && !Array.isArray(msg.params)
      ? msg.params
      : {}
  ) as Record<string, unknown>;
  return {
    ...msg,
    params: {
      ...params,
      protocolVersion:
        typeof params.protocolVersion === 'string'
          ? params.protocolVersion
          : FALLBACK_PROTOCOL_VERSION,
      capabilities:
        typeof params.capabilities === 'object' && params.capabilities !== null
          ? params.capabilities
          : {},
      clientInfo:
        typeof params.clientInfo === 'object' && params.clientInfo !== null
          ? params.clientInfo
          : { name: 'unknown-client', version: '0.0.0' },
    },
  };
}

export function createAppMcp(deps: AppMcpDeps): AppMcp {
  const { config, jobs, sessions, ui, uiState, version } = deps;
  const startedAt = Date.now();

  /**
   * Dispatch one tool call to the shared internals — each arm mirrors the
   * corresponding /api/v1 handler in src/transport/api.ts, and the returned
   * body is the SAME body that handler responds with (parity by construction).
   */
  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (name) {
      case 'status': {
        // Mirrors GET /api/v1/status — the contract's fixed status shape.
        const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, killed: 0 };
        for (const job of jobs.list()) counts[job.status] += 1;
        return {
          ok: true,
          version,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          session: sessions.info(),
          jobs: counts,
          rotation: { enabled: config.rotationEnabled },
          jobsEnabled: config.jobsEnabled,
        };
      }
      case 'jobs_list': {
        // Mirrors GET /api/v1/jobs?status=<s>.
        const status = args.status;
        if (
          status !== undefined &&
          (typeof status !== 'string' || !JOB_STATUSES.includes(status))
        ) {
          throw new ToolArgumentError(
            `invalid status filter: ${String(status)} (expected one of ${JOB_STATUSES.join(', ')})`,
          );
        }
        const list =
          status === undefined ? jobs.list() : jobs.list({ status: status as JobStatus });
        return { ok: true, jobs: list };
      }
      case 'jobs_submit': {
        // Mirrors POST /api/v1/jobs: `params` present discriminates the typed
        // submit; submit()/submitType() own validation (JobError → isError).
        if ('params' in args) {
          if (typeof args.type !== 'string' || args.type === '') {
            throw new ToolArgumentError(
              'typed submit requires "type" (non-empty string) alongside "params"',
            );
          }
          return { ok: true, job: jobs.submitType(args.type, args.params) };
        }
        return { ok: true, job: jobs.submit(args as unknown as JobSubmit) };
      }
      case 'jobs_kill': {
        // Mirrors POST /api/v1/jobs/<id>/kill (unknown id → the 404 message).
        const id = args.id;
        if (typeof id !== 'string' || id === '') {
          throw new ToolArgumentError('jobs_kill requires "id" (non-empty string)');
        }
        if (jobs.get(id) === null) throw new ToolArgumentError(`no such job: ${id}`);
        return { ok: true, job: jobs.kill(id) };
      }
      case 'session_rotate': {
        // Mirrors POST /api/v1/session/rotate — only 'manual' from this door.
        const reason = args.reason;
        if (reason !== undefined && reason !== 'manual') {
          throw new ToolArgumentError(`invalid rotation reason: ${String(reason)}`);
        }
        return { ok: true, rotation: await sessions.rotate('manual') };
      }
      case 'ui_state_get': {
        // Stage 37 — mirrors GET /api/v1/ui/state/<name>. Flag off: the tool
        // is not advertised, so the name is as unknown as it was before.
        if (!config.generativeUiEnabled) break;
        const stateName = args.name;
        if (typeof stateName !== 'string' || stateName === '') {
          throw new ToolArgumentError('ui_state_get requires "name" (non-empty string)');
        }
        // Unknown resource name → UiRegistryError → isError (never protocol-level).
        return { ok: true, ...uiState.get(stateName) };
      }
      case 'ui_state_set': {
        // Stage 37 — mirrors POST /api/v1/ui/state/<name> body { value }.
        if (!config.generativeUiEnabled) break;
        const stateName = args.name;
        if (typeof stateName !== 'string' || stateName === '') {
          throw new ToolArgumentError('ui_state_set requires "name" (non-empty string)');
        }
        if (!('value' in args)) {
          throw new ToolArgumentError('ui_state_set requires "value" (any JSON document)');
        }
        // Unknown name / oversize / non-JSON → UiRegistryError → isError.
        const set = uiState.set(stateName, args.value);
        return { ok: true, name: set.name, updatedAt: set.updatedAt };
      }
      default:
        break;
    }
    // Unknown tool — including a ui-state tool while the flag is off
    // (unadvertised = nonexistent): protocol-level InvalidParams, exactly the
    // pre-Stage-37 behavior.
    throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${name}`);
  }

  /** A fresh SDK server per request (stateless mode requires it). */
  function buildServer(): Server {
    const server = new Server(
      { name: 'nightshift-assistant', version },
      // listChanged (Stage 34, ADR 0015): initialize now advertises that
      // resources/list_changed notifications are emitted — over the GET
      // stream this same endpoint serves, not over any POST response.
      { capabilities: { tools: {}, resources: { listChanged: true } } },
    );
    // Stage 37: the catalog is a function of the flag — the certified five
    // byte-identical when off (same entries, same order), five + the two
    // ui-state tools appended when on (status stays FIRST either way).
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: config.generativeUiEnabled ? [...TOOLS, ...STATE_TOOLS] : TOOLS,
    }));
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: UI_RESOURCE_URI,
          name: 'jobs',
          description:
            'Jobs dashboard (single-file HTML): list, status filter, kill, submit — driven ' +
            'entirely through the declared ui/tools via the ui-bridge postMessage protocol.',
          mimeType: 'text/html',
          _meta: uiResourceMeta(),
        },
        // Stage 31: registry rows (the ACTIVE version per name) join the
        // hand-authored entry only when the flag is on — off is byte-identical
        // to Stage 28. _meta["ui/tools"] is the grant intersection: [] this
        // stage by construction (zero-trust; grants land in Stage 33).
        ...(config.generativeUiEnabled
          ? ui.list().map((resource) => ({
              uri: uiResourceUri(resource.name, resource.version),
              name: resource.name,
              description:
                `Generated single-file UI resource ${resource.name}@v${resource.version} ` +
                '(generative-ui registry, contracts/generative-ui.md).',
              mimeType: 'text/html',
              _meta: { 'ui/tools': resource.grantedTools },
            }))
          : []),
      ],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (request.params.uri === UI_RESOURCE_URI) {
        return {
          contents: [
            {
              uri: UI_RESOURCE_URI,
              mimeType: 'text/html',
              text: loadUiResourceHtml(),
              _meta: uiResourceMeta(),
            },
          ],
        };
      }
      // Stage 31: any exact registered @vN uri (active or not — a listed
      // client can always read what it saw listed), same _meta rule evaluated
      // at read time. Flag off: registered uris are as unknown as they were
      // in Stage 28.
      if (config.generativeUiEnabled) {
        const resource = ui.getByUri(request.params.uri);
        if (resource !== null) {
          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType: 'text/html',
                text: resource.html ?? '',
                _meta: { 'ui/tools': resource.grantedTools },
              },
            ],
          };
        }
      }
      throw new McpError(ErrorCode.InvalidParams, `unknown resource: ${request.params.uri}`);
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      try {
        const body = await callTool(request.params.name, args);
        return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      } catch (err) {
        // Rejected input / JobError / UiRegistryError (Stage 37: unknown
        // state name, oversize, non-JSON) → a tool-level error result carrying
        // the control API's error body — the same message a 400/404/422 would
        // carry there. NEVER a protocol-level error for rejected input.
        if (
          err instanceof ToolArgumentError ||
          err instanceof JobError ||
          err instanceof UiRegistryError
        ) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ ok: false, error: err.message }) },
            ],
            isError: true,
          };
        }
        throw err; // protocol-level failure — the SDK answers with a JSON-RPC error
      }
    });
    return server;
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      // Bounded read — the same 1MB discipline as every other app route.
      const raw = await readRawBody(req);
      // Parse here so initialize can be normalized; unparseable JSON falls
      // through to the SDK, which answers the proper -32700.
      let parsedBody: unknown;
      try {
        parsedBody = normalizeInitialize(JSON.parse(raw.toString('utf8')));
      } catch {
        parsedBody = undefined;
      }

      const server = buildServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        // No sessionIdGenerator → STATELESS mode: no session ids issued or required.
        enableJsonResponse: true, // every POST answers plain JSON, never SSE
      });
      try {
        await server.connect(transport);
        const headers = new Headers({
          // Accept normalization (see module header): responses are always JSON.
          accept: 'application/json, text/event-stream',
        });
        const contentType = single(req.headers['content-type']);
        if (contentType !== undefined) headers.set('content-type', contentType);
        const protocolVersion = single(req.headers['mcp-protocol-version']);
        if (protocolVersion !== undefined) headers.set('mcp-protocol-version', protocolVersion);
        const sessionId = single(req.headers['mcp-session-id']);
        if (sessionId !== undefined) headers.set('mcp-session-id', sessionId);

        const webResponse = await transport.handleRequest(
          new Request(`http://127.0.0.1${req.url ?? '/app/v1/mcp'}`, {
            method: 'POST',
            headers,
            body: raw,
          }),
          parsedBody === undefined ? undefined : { parsedBody },
        );
        // JSON mode: the response is always a complete (never streaming) body.
        const body = Buffer.from(await webResponse.arrayBuffer());
        res.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()));
        res.end(body);
      } finally {
        await transport.close();
        await server.close();
      }
    },
  };
}
