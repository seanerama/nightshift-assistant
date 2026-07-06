#!/usr/bin/env node
/**
 * Stub NIGHTSHIFT_AGENT_BIN for tests: stands in for the `claude` binary in
 * headless JSON mode. Reads the prompt from stdin, records the invocation
 * (argv + input) to AGENT_STUB_LOG (JSON lines), and emits canned claude-style
 * result JSON. This stubs the seam, never the logic.
 *
 * Env knobs:
 *   AGENT_STUB_LOG      — JSONL file capturing { args, input, pid } per call
 *   AGENT_STUB_MODE=die — exit nonzero (session death / summary-turn failure)
 *   AGENT_STUB_REPLY    — canned result text (default `pong: <input>`)
 *   AGENT_STUB_DELAY_MS — sleep before replying (serialization tests)
 */
'use strict';

const fs = require('node:fs');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  input += d;
});
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (process.env.AGENT_STUB_LOG) {
    // apiToken: what the CONVERSATIONAL spawn env carried (Stage 5 gating
    // tests) — null when the daemon did not inject NIGHTSHIFT_API_TOKEN.
    fs.appendFileSync(
      process.env.AGENT_STUB_LOG,
      `${JSON.stringify({
        args,
        input,
        pid: process.pid,
        apiToken: process.env.NIGHTSHIFT_API_TOKEN ?? null,
      })}\n`,
    );
  }

  const respond = () => {
    if (process.env.AGENT_STUB_MODE === 'die') {
      process.stderr.write('stub agent dying mid-turn\n');
      process.exit(1);
    }

    // Session id: echo --resume; honor a pre-assigned --session-id (as the
    // real CLI does for new sessions); otherwise a canned id.
    const resumeIdx = args.indexOf('--resume');
    const sessionIdIdx = args.indexOf('--session-id');
    let sessionId = 'sess-canned-1';
    if (resumeIdx !== -1) sessionId = args[resumeIdx + 1];
    else if (sessionIdIdx !== -1) sessionId = args[sessionIdIdx + 1];

    const result = process.env.AGENT_STUB_REPLY ?? `pong: ${input.trim()}`;
    process.stdout.write(
      `${JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result,
        session_id: sessionId,
      })}\n`,
    );
  };

  const delay = Number.parseInt(process.env.AGENT_STUB_DELAY_MS ?? '0', 10);
  if (delay > 0) setTimeout(respond, delay);
  else respond();
});
