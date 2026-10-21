import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolDefinitions } from '../src/index.js';
import { CAPABILITIES, SCOPES } from '../src/connection.js';
import client from '../src/onboarding-client.cjs';
import { execution } from './fake-dsh.js';

const PHONE = '18000000000';
const CODE = '1234';
const KEY = 'ak_live_' + 'synthetic_key_'.repeat(4);
const CHALLENGE = 'a'.repeat(32);
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function fixture(t, handler) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'accurlex-dsh-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const environment = {};
  const calls = [];
  const tools = createToolDefinitions({}, { home, environment, fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return handler(calls.at(-1));
  } });
  return { home, environment, calls, tool: name => tools.find(t => t.name === name),
    connect: args => tools.find(t => t.name === 'accurlex_connect').execute(args, execution()) };
}
const start = (capability = 'qa_deep') => ({ action: 'start', capability, phone: PHONE, consent: true });
const complete = (capability = 'qa_deep') => ({ action: 'complete', capability, code: CODE, connection_id: CHALLENGE });
function authResponse(call, scope) {
  assert.match(call.url, /^https:\/\/accurlex\.com\/index\.php\/SkillHub\/(start|complete)$/);
  assert.equal(call.init.redirect, 'error');
  assert.equal(call.init.headers.Authorization, undefined);
  if (call.url.endsWith('/start')) return response({ status: 'sms_sent', scope, challenge_id: CHALLENGE, expires_at: Math.floor(Date.now() / 1000) + 300 });
  return response({ status: 'ready', scope, api_key: KEY });
}

test('missing credentials give actionable scope-specific guidance without network or storage writes', async t => {
  const f = fixture(t, () => { throw Error('must not fetch'); });
  const result = await f.tool('accurlex_legal_qa').execute({ question: '完整问题', mode: 'expert' }, execution());
  assert.equal(result.error.code, 'api_key_required');
  assert.equal(result.capability, 'qa_expert');
  const status = await f.connect({ action: 'status', capability: 'qa_expert' });
  assert.equal(status.status, 'needs_onboarding');
  assert.match(status.content, /user_agreement\.html/);
  assert.match(status.content, /privacy_policy\.html/);
  assert.match(status.content, /用户手机/);
  assert.deepEqual(fs.readdirSync(f.home), []);
  assert.equal(f.calls.length, 0);
});

test('requires consent and rejects unsupported capabilities and mismatched action fields before sending SMS', async t => {
  const f = fixture(t, () => { throw Error('must not fetch'); });
  assert.equal((await f.connect({ ...start(), consent: false })).error.code, 'consent_required');
  for (const args of [{ ...start(), consent: 'true' }, { ...start(), capability: 'admin' }, { ...start(), capability: 'constructor' },
    { ...start(), phone: 'not-phone' }, { ...start(), scope: 'all' }, { ...complete(), connection_id: undefined },
    { action: 'status', capability: 'qa_deep', phone: PHONE }]) {
    assert.equal((await f.connect(args)).error.code, 'invalid_arguments');
  }
  assert.equal(f.calls.length, 0);
});

for (const scope of SCOPES) test(`${scope}: SMS → private credential → original business call without copying a key`, async t => {
  const f = fixture(t, call => {
    if (call.url.includes('/SkillHub/')) return authResponse(call, scope);
    assert.equal(call.init.headers.Authorization, 'Bearer ' + KEY);
    assert.equal(call.init.redirect, 'error');
    assert.ok(call.body.prompt?.includes('完整材料') || call.body.question?.includes('完整材料') || call.body.contract_text?.includes('完整材料'));
    return response({ data: '完整业务结果', original_content: '完整检索依据' });
  });
  const sent = await f.connect(start(scope));
  assert.equal(sent.status, 'sms_sent');
  assert.equal(sent.connection_id, CHALLENGE);
  assert.equal(f.calls[0].body.skill, CAPABILITIES[scope].skill);
  assert.equal(f.calls[0].body.mode, CAPABILITIES[scope].fixedMode ?? '');
  assert.equal(f.calls[0].body.consent_version, client.CONSENT);
  const ready = await f.connect(complete(scope));
  assert.equal(ready.status, 'ready');
  assert.doesNotMatch(JSON.stringify([sent, ready]), new RegExp(`${PHONE}|${CODE}|${KEY}|client_secret`));
  const where = client.locations(scope, f.home);
  assert.equal(fs.readFileSync(where.key, 'utf8'), `ACCURLEX_API_KEY=${KEY}\n`);
  assert.equal(fs.existsSync(where.state), false);
  assert.equal(fs.existsSync(where.lock), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(where.key).mode & 0o777, 0o600);
  const task = scope.startsWith('qa_') ? ['accurlex_legal_qa', { question: '完整材料与事实', mode: scope.slice(3) }]
    : scope === 'law_search' ? ['accurlex_law_search', { prompt: '完整材料与检索目标', mode: 'expert' }]
      : scope === 'document_draft' ? ['accurlex_document_draft', { prompt: '完整材料与写作要求' }]
        : ['accurlex_contract_review', { contract_text: '完整材料与合同条款', standpoint: '乙方' }];
  assert.equal((await f.tool(task[0]).execute(task[1], execution())).ok, true);
  assert.equal(f.calls.length, 3);
  assert.equal((await f.connect({ action: 'status', capability: scope })).status, 'ready');
  assert.equal((await f.connect(start(scope))).error.code, 'credential_exists');
  assert.equal(f.calls.length, 3);
});

test('challenge binding and wrong codes preserve a recoverable flow without leaking provider responses', async t => {
  let badCode = true;
  const f = fixture(t, call => call.url.endsWith('/complete') && badCode
    ? response({ error: 'code_invalid', message: `${PHONE} ${CODE} ${KEY}` }, 400)
    : authResponse(call, 'qa_deep'));
  await f.connect(start());
  assert.equal((await f.connect({ ...complete(), connection_id: 'b'.repeat(32) })).error.code, 'flow_conflict');
  assert.equal((await f.connect(complete('qa_expert'))).error.code, 'flow_expired');
  assert.equal(f.calls.length, 1);
  const bad = await f.connect(complete());
  assert.equal(bad.error.code, 'code_invalid');
  assert.doesNotMatch(JSON.stringify(bad), new RegExp(`${PHONE}|${CODE}|${KEY}`));
  assert.equal(fs.existsSync(client.locations('qa_deep', f.home).state), true);
  badCode = false;
  assert.equal((await f.connect(complete())).status, 'ready');
});

test('lost start and complete responses recover with the same secret/challenge; no automatic resend', async t => {
  let failStart = true, failComplete = true;
  const f = fixture(t, call => {
    if (call.url.endsWith('/start') && failStart) { failStart = false; throw Error('synthetic network failure'); }
    if (call.url.endsWith('/complete') && failComplete) { failComplete = false; throw Error('synthetic response loss'); }
    return authResponse(call, 'qa_deep');
  });
  assert.equal((await f.connect(start())).error.code, 'request_failed');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.connect(start())).status, 'sms_sent');
  assert.equal(f.calls[0].body.client_secret, f.calls[1].body.client_secret);
  assert.equal((await f.connect(complete())).error.code, 'request_failed');
  assert.equal(f.calls.length, 3);
  assert.equal((await f.connect(complete())).status, 'ready');
  assert.deepEqual(f.calls[2].body, f.calls[3].body);
});

test('explicit credentials take precedence and are never silently replaced or bypassed', async t => {
  const f = fixture(t, call => authResponse(call, 'qa_deep'));
  await f.connect(start()); await f.connect(complete());
  f.environment.ACCURLEX_API_KEY = 'invalid-explicit-key';
  assert.equal((await f.connect({ action: 'status', capability: 'qa_deep' })).error.code, 'credential_invalid');
  assert.equal((await f.connect({ ...start(), replace: true })).error.code, 'credential_exists');
  assert.equal((await f.tool('accurlex_legal_qa').execute({ question: '材料' }, execution())).error.code, 'credential_invalid');
  assert.equal(f.calls.length, 2);
  delete f.environment.ACCURLEX_API_KEY;
  f.environment.ACCURLEX_API_BASE_URL = 'https://untrusted.example';
  assert.equal((await f.tool('accurlex_legal_qa').execute({ question: '材料' }, execution())).error.code, 'configuration_error');
  assert.equal(f.calls.length, 2);
});

test('restart, account changes, locks and expiry cannot silently overwrite a flow', async t => {
  const f = fixture(t, call => authResponse(call, 'qa_deep'));
  await f.connect(start());
  assert.equal((await f.connect({ ...start(), restart: true })).error.code, 'rate_limited');
  assert.equal((await f.connect({ ...start(), phone: '18000000001' })).error.code, 'flow_conflict');
  const where = client.locations('qa_deep', f.home);
  fs.writeFileSync(where.lock, '{}');
  assert.equal((await f.connect(complete())).error.code, 'request_in_progress');
  fs.unlinkSync(where.lock);
  const state = JSON.parse(fs.readFileSync(where.state, 'utf8'));
  fs.writeFileSync(where.state, JSON.stringify({ ...state, createdAt: Date.now() - 601_000 }));
  assert.equal((await f.connect(complete())).error.code, 'flow_expired');
  assert.equal(f.calls.length, 1);
});

test('provider response must match requested scope and contain a valid key', async t => {
  const f = fixture(t, call => call.url.endsWith('/start') ? authResponse(call, 'qa_deep')
    : response({ status: 'ready', scope: 'qa_expert', api_key: KEY }));
  await f.connect(start());
  assert.equal((await f.connect(complete())).error.code, 'response_invalid');
  assert.equal(fs.existsSync(client.locations('qa_deep', f.home).key), false);
});

test('native cancellation reaches SMS fetch and keeps the flow recoverable', async t => {
  const f = fixture(t, async call => {
    await new Promise(resolve => call.init.signal.addEventListener('abort', resolve, { once: true }));
    throw new DOMException('Aborted', 'AbortError');
  });
  const controller = new AbortController();
  const pending = f.tool('accurlex_connect').execute(start(), execution(controller.signal));
  controller.abort();
  assert.equal((await pending).error.code, 'request_failed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.signal.aborted, true);
  assert.equal(fs.existsSync(client.locations('qa_deep', f.home).state), true);
});
