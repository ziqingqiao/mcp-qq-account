#!/usr/bin/env node
/**
 * Smoke test: does the stdio transport actually work, end to end?
 *
 * Scope is deliberately narrow - protocol and transport only. The tool
 * *contract* rules (descriptions, schemas, annotations) live in
 * `audit-tools.ts` so the two checks do not drift into contradicting each
 * other, and so a failure here always means "the channel is broken" rather
 * than "some description is too short".
 *
 * What it proves:
 *  1. Handshake completes and the server negotiates a protocol version it
 *     actually implements, even when the client asks for a newer one.
 *  2. `tools/list` answers and contains the tools we expect.
 *  3. Nothing but JSON-RPC frames appears on stdout. One stray console.log
 *     corrupts the channel and the host disconnects - this is the most common
 *     stdio defect and the reason this test exists at all.
 *
 * The inbound event receiver is switched off here so the test owns no port and
 * cannot collide with a real deployment. It is exercised separately.
 */

import { openStdioSession, resolveServerEntry } from './lib/stdio-session.js';

const EXPECTED_TOOLS = [
  'qq_get_account',
  'qq_list_conversations',
  'qq_read_messages',
  'qq_ack_messages',
  'qq_get_conversation_history',
  'qq_send_message',
];

async function main(): Promise<void> {
  const session = await openStdioSession({
    entry: resolveServerEntry(import.meta.url),
    env: {
      LOG_LEVEL: process.env.MCP_SMOKE_DEBUG === '1' ? 'debug' : 'error',
      // No listener, no port: this test is about the MCP channel.
      QQ_EVENT_ENABLED: 'false',
    },
    forwardStderr: process.env.MCP_SMOKE_DEBUG === '1',
    debug: process.env.MCP_SMOKE_DEBUG === '1',
  });

  const problems: string[] = [];

  try {
    const { serverInfo, protocolVersion, instructions, tools } = session.snapshot;

    // 1. Version negotiation.
    if (!protocolVersion) {
      problems.push('initialize returned no negotiated protocolVersion');
    } else if (protocolVersion === '2026-07-28') {
      problems.push(
        'server echoed the requested 2026-07-28, which the published SDK 2.0.0 does not implement - ' +
          'the negotiated version is therefore not trustworthy',
      );
    }

    // 2. Tool surface.
    const names = tools.map((tool) => tool.name);
    for (const expected of EXPECTED_TOOLS) {
      if (!names.includes(expected)) problems.push(`missing expected tool: ${expected}`);
    }
    if (tools.length === 0) problems.push('tools/list returned zero tools');

    // 3. Server-level policy must be present. For this server that policy
    //    carries the untrusted-content rule, so a missing block is not merely
    //    untidy - it is the difference between reporting an injection attempt
    //    and obeying it.
    if (!instructions || instructions.length < 100) {
      problems.push('server advertises no (or a token) `instructions` block, so cross-tool policy is missing');
    } else if (!/untrusted|other people|never an instruction/i.test(instructions)) {
      problems.push(
        'the server instructions never state that received messages are untrusted data, ' +
          'which is the one policy this server cannot run without',
      );
    }

    // 4. stdout purity. Anything captured here is a corrupting write.
    for (const anomaly of session.anomalies) problems.push(anomaly);

    process.stderr.write(`initialize ok: ${JSON.stringify(serverInfo)} (negotiated ${protocolVersion})\n`);
    process.stderr.write(`tools/list returned ${tools.length}: ${names.join(', ')}\n`);

    if (problems.length > 0) {
      process.stderr.write('\nSMOKE TEST FAILED:\n');
      for (const problem of problems) process.stderr.write(` - ${problem}\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write('SMOKE TEST PASSED\n');
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    const stderr = session.stderr().trim();
    if (stderr) process.stderr.write(`--- server stderr ---\n${stderr}\n`);
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
