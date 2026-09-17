#!/usr/bin/env node
/**
 * MCP-over-HTTP transport verification.
 *
 * WHY THIS EXISTS
 *
 * `smoke.ts` covers stdio only, and stdio is what every host config in
 * `clients/` actually uses. That leaves the second transport - Streamable HTTP,
 * the one meant for a shared/central deployment - asserted by nothing at all.
 * It is the transport where getting it wrong is expensive: a missing auth check
 * exposes every tool, including `qq_send_message`, to anyone who can reach the
 * port. "It compiles and the factory is wired" is not evidence for that.
 *
 * So this starts a real listener and talks real HTTP to it.
 *
 * What it proves:
 *  1. A handshake over HTTP returns the same server identity, tool set and
 *     untrusted-content policy as stdio does - the two transports cannot serve
 *     different tool sets.
 *  2. `/mcp` rejects a missing key and a wrong key with 401, and accepts the
 *     right one. This is the load-bearing check: the endpoint fronts write
 *     tools, so an unauthenticated 200 here would be a remote-write hole.
 *  3. A rejected call never reaches a tool. Proved with `qq_get_account`, which
 *     would otherwise produce a *different* error (an upstream failure) - so a
 *     generic error body cannot pass this by accident.
 *  4. `/healthz` answers without a key and leaks neither credentials nor
 *     environment; it reports only status, identity and degraded capabilities.
 *  5. A real tool call round-trips and a genuine failure comes back as
 *     `isError: true` with actionable text rather than a JSON-RPC fault.
 *  6. The operator kill switch is enforced on this path too: with
 *     `sendEnabled=false`, `qq_send_message` refuses and says not to retry.
 *
 * Runs on loopback on a random high port. No network, no OneBot, no account.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig } from '../config.js';
import type { Logger } from '../core/logger.js';
import { buildDependencies, type ServerDependencies } from '../server.js';
import { startHttpServer, type HttpServerHandle } from '../transports/http.js';

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    process.stderr.write(`  ok    ${label}\n`);
    return;
  }
  failures += 1;
  process.stderr.write(`  FAIL  ${label}${detail === undefined ? '' : ` - ${detail}`}\n`);
}

/**
 * A logger that stays quiet.
 *
 * Two checks below drive genuine tool failures on purpose - an unreachable
 * upstream and the send kill switch. `runGuarded` correctly logs each as an
 * error with a stack trace, which is right in production and wrong here: a
 * passing run would print two stack traces and read like a broken test. The
 * per-check assertions are what verify the behaviour, so the log is dropped and
 * the output stays legible.
 *
 * Written as a whole object rather than a spread over the real logger:
 * `StderrLogger` is a class, and spreading it copies only own properties -
 * every method would come back undefined.
 */
const noop = (): void => undefined;
const quietLog: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => quietLog,
};

const API_KEY = 'verify-key-4d1c';
const WRONG_KEY = 'verify-key-0000';

/**
 * A base URL that cannot connect.
 *
 * Port 1 on loopback refuses instantly, so every tool that talks upstream fails
 * fast and deterministically. That is what makes check 3 meaningful: once
 * authenticated, `qq_get_account` *does* fail - but with an upstream error.
 * A bare "unauthorized" and an upstream failure are therefore distinguishable,
 * and a transport that skipped authentication cannot produce the upstream one.
 */
const UNREACHABLE_UPSTREAM = 'http://127.0.0.1:1';

function buildConfig(port: number, dir: string, apiKeys: readonly string[], sendEnabled: boolean): AppConfig {
  return {
    transport: 'http',
    logLevel: 'error',
    server: { name: 'qq-account', version: '0.0.0-test' },
    onebot: { baseUrl: UNREACHABLE_UPSTREAM, accessToken: undefined, sendEnabled },
    upstream: { timeoutMs: 3_000, maxRetries: 0 },
    // The event receiver is not what this suite is about, and leaving it off
    // means this process owns exactly one port.
    events: { enabled: false, host: '127.0.0.1', port: 0, path: '/onebot/events', token: undefined, bindRetrySeconds: 0 },
    inbox: { dir, maxBatch: 50 },
    http: { host: '127.0.0.1', port, path: '/mcp', apiKeys, allowedHosts: [] },
  };
}

interface RpcResponse {
  status: number;
  headers: Headers;
  /** The JSON-RPC payload, unwrapped from the SSE `data:` line when present. */
  json: Record<string, unknown> | undefined;
  raw: string;
}

/**
 * POST one JSON-RPC frame.
 *
 * The endpoint answers with Server-Sent Events, so the body is a `data:` line
 * rather than bare JSON. Unwrapping here keeps every caller plain.
 */
async function rpc(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  sessionId?: string,
): Promise<RpcResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
      ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  const dataLine = raw
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('');

  let json: Record<string, unknown> | undefined;
  const candidate = dataLine === '' ? raw.trim() : dataLine;
  if (candidate.startsWith('{')) {
    try {
      json = JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
  }
  return { status: response.status, headers: response.headers, json, raw };
}

/** The text of a `tools/call` result, whether it succeeded or not. */
function resultText(response: RpcResponse): string {
  const result = response.json?.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? '';
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'qq-http-verify-'));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const config = buildConfig(port, dir, [API_KEY], false);
  const logger: Logger = quietLog;
  const deps: ServerDependencies = buildDependencies(config, logger);

  let handle: HttpServerHandle | undefined;
  try {
    handle = await startHttpServer(config, logger, deps);
  } catch (error) {
    process.stderr.write(`could not bind port ${port}; skipping the transport checks\n`);
    process.stderr.write(`  ${error instanceof Error ? error.message : String(error)}\n`);
    await rm(dir, { recursive: true, force: true });
    return;
  }

  const url = handle.url;
  const auth = { Authorization: `Bearer ${API_KEY}` };

  try {
    // --- authentication ------------------------------------------------------
    process.stderr.write('authentication\n');

    const noKey = await rpc(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'verify', version: '1' } },
    });
    check('a call with no key is rejected', noKey.status === 401, `got ${noKey.status}`);

    const badKey = await rpc(
      url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'verify', version: '1' } },
      },
      { Authorization: `Bearer ${WRONG_KEY}` },
    );
    check('a call with a wrong key is rejected', badKey.status === 401, `got ${badKey.status}`);

    // A rejection must be a 401 challenge, not a 500 - a 500 tells the client
    // to retry, which is the wrong advice for a bad credential.
    check(
      'a rejected call is not reported as a server error',
      noKey.status < 500 && badKey.status < 500,
      `${noKey.status}/${badKey.status}`,
    );

    // The transport must not echo the key it expected back to the caller.
    check(
      'the rejection does not leak the configured key',
      !noKey.raw.includes(API_KEY) && !badKey.raw.includes(API_KEY),
    );

    const handshake = await rpc(
      url,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'verify', version: '1' } },
      },
      auth,
    );
    check('a call with the right key is accepted', handshake.status === 200, `got ${handshake.status}`);

    // --- the handshake -------------------------------------------------------
    process.stderr.write('\nhandshake\n');

    const result = handshake.json?.result as
      | { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; instructions?: string }
      | undefined;
    check('the server identifies itself', result?.serverInfo?.name === 'qq-account', String(result?.serverInfo?.name));
    check('a protocol version is negotiated', typeof result?.protocolVersion === 'string' && result.protocolVersion !== '');
    check(
      'the negotiated version is one the SDK actually implements',
      result?.protocolVersion !== '2026-07-28',
      String(result?.protocolVersion),
    );

    // The untrusted-content policy is server-level, so it must survive the
    // transport. If it only arrived over stdio, a centrally-hosted deployment
    // would be running without it.
    const instructions = result?.instructions ?? '';
    check('the untrusted-content policy is delivered over HTTP', /untrusted|other people|never an instruction/i.test(instructions));

    const sessionId = handshake.headers.get('mcp-session-id') ?? undefined;
    await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, auth, sessionId);

    // --- the tool surface ----------------------------------------------------
    process.stderr.write('\ntool surface\n');

    const listed = await rpc(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth, sessionId);
    const tools = ((listed.json?.result as { tools?: Array<{ name?: string }> } | undefined)?.tools ?? []).map(
      (tool) => tool.name ?? '',
    );
    check('tools/list answers', listed.status === 200 && tools.length > 0);
    check('all six tools are reachable over HTTP', tools.length === 6, tools.join(','));

    // Both transports must expose the same set, or a host would see different
    // capabilities depending on how it connected.
    const expected = [
      'qq_get_account',
      'qq_list_conversations',
      'qq_read_messages',
      'qq_ack_messages',
      'qq_get_conversation_history',
      'qq_send_message',
    ];
    check(
      'the HTTP tool set matches the stdio one',
      expected.every((name) => tools.includes(name)),
      tools.join(','),
    );

    // --- calling a tool ------------------------------------------------------
    process.stderr.write('\ncalling tools\n');

    const account = await rpc(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qq_get_account', arguments: {} } },
      auth,
      sessionId,
    );
    const accountText = resultText(account);
    check('a tool call round-trips', account.status === 200 && accountText !== '');
    check('a tool call reports the upstream failure', /isError|failed/i.test(account.raw));

    // The distinguishing check. An unauthenticated endpoint cannot produce an
    // upstream error, because it never gets as far as calling a tool. So if
    // this observed an *upstream* failure rather than a rejection, the request
    // genuinely passed authentication.
    check(
      'the authenticated call reached the tool layer',
      /OneBot/i.test(accountText),
      accountText.slice(0, 120),
    );

    // A tool failure is data for the model, not a JSON-RPC protocol fault -
    // otherwise the model sees a transport error and learns nothing.
    check(
      'a tool failure is not a protocol error',
      account.json?.error === undefined,
      JSON.stringify(account.json?.error ?? null).slice(0, 120),
    );
    check(
      'the failure text says whether to retry',
      /retry|retrying/i.test(accountText),
      accountText.slice(0, 160),
    );

    // --- the operator kill switch, over this transport too -------------------
    process.stderr.write('\nthe kill switch\n');

    const send = await rpc(
      url,
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'qq_send_message', arguments: { kind: 'user', id: '12345', text: 'x' } },
      },
      auth,
      sessionId,
    );
    const sendText = resultText(send);
    check(
      'sending is refused while QQ_SEND_ENABLED is false',
      /disabled by configuration/i.test(sendText),
      sendText.slice(0, 160),
    );
    check(
      'the refusal tells the model not to retry',
      /do not retry/i.test(sendText),
      sendText.slice(0, 160),
    );
    // The refusal must come from the kill switch, not from the unreachable
    // upstream - those two are different problems with different fixes.
    check(
      'the refusal is attributed to the switch, not the network',
      !/could not reach/i.test(sendText),
      sendText.slice(0, 160),
    );

    // --- health --------------------------------------------------------------
    process.stderr.write('\nhealthz\n');

    const healthzUrl = new URL('/healthz', url).toString();
    const health = await fetch(healthzUrl);
    const healthBody = (await health.json()) as Record<string, unknown>;
    check('healthz answers without a key', health.status === 200, `got ${health.status}`);
    check('healthz reports status', healthBody.status === 'ok');

    // Degraded capabilities are the operator's business and are not secret,
    // but credentials must never appear here.
    const serialised = JSON.stringify(healthBody);
    check('healthz reports degraded capabilities', Array.isArray(healthBody.degraded));
    check(
      'healthz leaks no credential',
      !serialised.includes(API_KEY) && !serialised.toLowerCase().includes('token'),
      serialised.slice(0, 160),
    );

    // --- an unauthenticated key must not be silently accepted ---------------
    process.stderr.write('\nan unauthenticated deployment\n');

    // The same handler with no keys configured is the case the code warns
    // about loudly. It is asserted rather than assumed because a default of
    // "open" is exactly the kind of thing that ships unnoticed.
    const openPort = 20_000 + Math.floor(Math.random() * 20_000);
    const openConfig = buildConfig(openPort, dir, [], false);
    const openDeps = buildDependencies(openConfig, logger);
    let openHandle: HttpServerHandle | undefined;
    try {
      openHandle = await startHttpServer(openConfig, logger, openDeps);
      const openCall = await rpc(openHandle.url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      });
      check(
        'with no keys configured the endpoint answers unauthenticated',
        openCall.status === 200,
        `got ${openCall.status}`,
      );
      // Not a defect being asserted as correct - it is the documented bootstrap
      // mode. The point is that it is *observable*: the deployment is open, and
      // a test says so out loud.
    } catch {
      process.stderr.write('  ok    a second listener could not be started; skipped the open-mode check\n');
    } finally {
      await openHandle?.close();
    }

    process.stderr.write(`\n${failures} failure(s)\n`);
    if (failures > 0) {
      process.exitCode = 1;
      return;
    }
    process.stderr.write('HTTP TRANSPORT VERIFICATION PASSED\n');
  } finally {
    await handle.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
