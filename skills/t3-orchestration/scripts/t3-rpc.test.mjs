// Offline CLI regression tests: node --test scripts/t3-rpc.test.mjs (Node 22.18+).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const entry = fileURLToPath(new URL('./t3-rpc.ts', import.meta.url));
function run(scenario, args = ['rpc', 'test.method']) {
  const preload = `
    const scenario = ${JSON.stringify(scenario)};
    globalThis.fetch = async () => ({ ok: true, json: async () =>
      scenario === 'missing-ticket' ? {} : { ticket: 'SECRET_TICKET' } });
    globalThis.WebSocket = class extends EventTarget {
      constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
      close() { this.dispatchEvent(new Event('close')); }
      send(raw) {
        const message = data => this.dispatchEvent(new MessageEvent('message', { data }));
        if (scenario === 'providers') {
          const request = JSON.parse(raw);
          const value = request.tag === 'server.refreshProviders' ? {} : { providers: [
            { instanceId: 'codex', driver: 'codex', enabled: true, status: 'ready',
              usageLimits: { checkedAt: '2026-09-30T00:00:00Z', windows: [
                { id: 'weekly', usedPercent: 42, resetsAt: '2026-10-01T00:00:00Z' }
              ] } },
            { instanceId: 'disabled', driver: 'codex', enabled: false }
          ] };
          return message(JSON.stringify({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value } }));
        }
        if (scenario === 'close') return this.close();
        if (scenario === 'error') {
          const event = new Event('error');
          event.message = 'SECRET_TICKET';
          return this.dispatchEvent(event);
        }
        if (scenario === 'invalid-json') return message('SECRET_TICKET invalid json');
        if (scenario === 'null') return message('null');
        if (scenario === 'array') return message('[]');
        if (scenario === 'missing-tag') return message('{}');
        message(JSON.stringify({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: { ok: true } } }));
        message('null'); // Events after settlement must not change the result.
      }
    };
  `;
  const result = spawnSync(process.execPath, ['--no-warnings', '--import',
    `data:text/javascript,${encodeURIComponent(preload)}`, entry, ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, T3_BEARER_TOKEN: 'OFFLINE_TEST_ONLY' },
  });
  assert.ifError(result.error);
  return result;
}

test('successful RPC settles once, even with late malformed messages', () => {
  const result = run('success');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
});

test('providers reports usage and filters disabled instances', () => {
  const result = run('providers', ['providers', '--refresh', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usageLimits.windows[0].usedPercent, 42);
});

test('providers can select a disabled instance explicitly', () => {
  const result = run('providers', ['providers', '--instance', 'disabled', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].instanceId, 'disabled');
});

test('providers rejects unknown instances', () => {
  const result = run('providers', ['providers', '--instance', 'missing']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown provider instance/);
});

for (const [scenario, expected] of [
  ['close', /closed before test.method completed/],
  ['error', /WebSocket error for test.method/],
  ['invalid-json', /Invalid WebSocket JSON/],
  ['null', /Invalid WebSocket response/],
  ['array', /Invalid WebSocket response/],
  ['missing-tag', /Invalid WebSocket response/],
  ['missing-ticket', /did not contain a ticket/],
]) {
  test(`${scenario} fails promptly without leaking response data`, () => {
    const result = run(scenario);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /SECRET_TICKET|OFFLINE_TEST_ONLY/);
  });
}

for (const value of ['false', 'true', 'invalid']) {
  test(`remove-worktree parses --force=${value} safely`, () => {
    const result = run('unused', ['remove-worktree', '--project-cwd', '/test',
      '--worktree-path', '/test-worktree', '--dry-run', `--force=${value}`]);
    if (value === 'invalid') {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /expects true or false/);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).force, value === 'true' ? true : undefined);
    }
  });
}
