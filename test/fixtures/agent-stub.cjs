#!/usr/bin/env node
/**
 * Stub NIGHTSHIFT_AGENT_BIN for tests: stands in for the `claude` binary in
 * headless JSON mode. Reads the prompt from stdin, records the invocation to
 * AGENT_STUB_LOG (JSON lines), and emits canned claude-style result JSON.
 * This stubs the seam, never the logic.
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
    fs.appendFileSync(
      process.env.AGENT_STUB_LOG,
      `${JSON.stringify({ args, input, pid: process.pid })}\n`,
    );
  }

  if (process.env.AGENT_STUB_MODE === 'die') {
    process.stderr.write('stub agent dying mid-turn\n');
    process.exit(1);
  }

  const resumeIdx = args.indexOf('--resume');
  const sessionId = resumeIdx !== -1 ? args[resumeIdx + 1] : 'sess-canned-1';
  process.stdout.write(
    `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: `pong: ${input.trim()}`,
      session_id: sessionId,
    })}\n`,
  );
});
