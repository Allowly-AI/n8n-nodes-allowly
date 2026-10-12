const assert = require('node:assert/strict');
const test = require('node:test');
const { createHmac, createHash } = require('node:crypto');
const { mkdtemp, realpath, readFile, readdir, chmod, symlink } = require('node:fs/promises');
const { join } = require('node:path');
const { EventEmitter } = require('node:events');
const dns = require('node:dns/promises');
const https = require('node:https');
const sdk = require('../dist/nodes/Allowly/execution-sdk.js');
const { Allowly } = require('../dist/nodes/Allowly/Allowly.node.js');

const original = {
  url: 'https://api.github.com/repos/octocat/Hello-World/issues?per_page=1',
  operationId: 'op_n8n_original', authorizationId: 'auth_n8n', enabledExecutableId: 'exe_n8n',
  catalogOperationId: 'github.issues.list', action: 'github.issues.list', method: 'GET',
  headers: { accept: 'application/vnd.github+json' }, evidenceMode: 'receipt',
  policyInput: { resource: 'demo:read', context: { scenario: 'synthetic' } },
};

function wire(kind = 'confirm', status = 'waiting_for_review') {
  const c = sdk.commitCustomerHttpRequest(original.url, original);
  const allowed = status === 'approved' || status === 'succeeded' || status === 'unknown';
  const approval = allowed ? {
    profile: 'allowly.execution.approval.v1', workspace_id: 'ws_n8n', operation_id: original.operationId,
    authorization_id: original.authorizationId, agent_id: 'agent_n8n', action: original.action,
    executable: { enabled_executable_id: original.enabledExecutableId, catalog_operation_id: original.catalogOperationId,
      origin: c.origin, provider_id: 'github', catalog_revision: 'synthetic', definition_fingerprint: 'sha256:' + '5'.repeat(64) },
    request: { ...c, headers: c.headers.map(h => ({ name: h.name, value_sha256: h.valueSha256 })),
      body_sha256: c.bodySha256, body_size: c.bodySize, content_type: c.contentType, provider_idempotency: { kind: 'none' } },
    policy_input_sha256: 'sha256:' + sdk.hashSealValue({ resource: 'demo:read', context: { scenario: 'synthetic' }, estimated_cost_micros: null }),
    policy_input_source: 'customer_runtime_reported', policy_input_request_semantics_verification: 'not_performed',
    evidence_mode: 'receipt', issued_at: '2020-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z',
  } : null;
  if (approval) { delete approval.request.bodySha256; delete approval.request.bodySize; delete approval.request.contentType; }
  return {
    operation_id: original.operationId, destination_id: original.enabledExecutableId, action: original.action,
    status, decision: allowed ? 'allow' : status === 'denied' ? 'deny' : kind, reason: 'synthetic_test',
    request_fingerprint_profile: 'allowly.execution.request.v1', request_fingerprint: 'sha256:' + '1'.repeat(64),
    request_descriptor: { operation_id: original.operationId, authorization_id: original.authorizationId,
      destination_id: original.enabledExecutableId, action: original.action, method: c.method, origin: c.origin,
      path: c.path, query: c.query, headers: c.headers.map(h => ({ name: h.name, value_sha256: h.valueSha256 })),
      body_sha256: c.bodySha256, body_size: c.bodySize, content_type: c.contentType },
    decision_receipt: { status: 'pending', receipt_id: 'rcp_source', ready_at_estimate: null, url: 'https://api.example/v1/receipts/rcp_source' },
    effective_evidence_mode: 'receipt', decision_state: allowed ? 'allowed' : 'not_allowed',
    target_state: status === 'succeeded' ? 'response_observed' : status === 'unknown' ? 'unknown' : 'not_started',
    evidence_state: ['succeeded', 'unknown'].includes(status) ? 'customer_reported' : 'pending',
    approval, approval_sha256: approval ? 'sha256:' + sdk.hashSealValue(approval) : null,
    approval_expires_at: approval?.expires_at ?? null,
    ...(status === 'waiting_for_review' ? { review: { kind, id: kind === 'confirm' ? 'cnf_prompt' : 'esc_prompt',
      source_receipt_id: 'rcp_source', expires_at: '2099-01-01T00:00:00Z' } } : {}),
  };
}

function reviewStatus(kind = 'confirm', changes = {}) {
  return { [kind === 'confirm' ? 'confirmation_id' : 'escalation_id']: kind === 'confirm' ? 'cnf_prompt' : 'esc_prompt',
    authorization_id: original.authorizationId, action: original.action, resource: original.policyInput.resource,
    status: 'rejected', expires_at: '2099-01-01T00:00:00Z', resolved_at: '2026-01-01T00:00:00Z',
    source_receipt_id: 'rcp_source', resolution_receipt_id: 'rcp_resolution', authority_status: 'none',
    ...(kind === 'confirm' ? { child_authorization_id: null, authority_expires_at: null } : { consumed_at: null }), ...changes };
}
const rejectedReview = { code: 409, body: { error: { code: 'execution_review_not_available',
  message: 'Execution review is not approved with available authority' } } };

function context(operation, request = original, credentials = {}, extra = {}) {
  return {
    getInputData: () => [{ json: {}, ...(extra.binary ? { binary: extra.binary } : {}) }],
    getCredentials: async () => ({ apiKey: 'synthetic-runtime-key', executionWorkspaceId: 'ws_n8n', ...credentials }),
    getNodeParameter: name => ({ operation, executionRequest: request, ...extra }[name]),
    getExecutionId: () => 'new-n8n-execution-is-not-the-operation',
    getNode: () => ({ name: 'Allowly Execute' }), continueOnFail: () => false,
    helpers: { getBinaryDataBuffer: async () => extra.bytes },
  };
}
async function invoke(operation, request = original, credentials = {}, extra = {}) {
  return (await new Allowly().execute.call(context(operation, request, credentials, extra)))[0][0].json;
}

async function isolated(t, run) {
  const directory = await realpath(await mkdtemp('/private/tmp/allowly-node-execution-'));
  const old = process.env.ALLOWLY_N8N_STATE_DIRECTORY;
  process.env.ALLOWLY_N8N_STATE_DIRECTORY = directory;
  const fetch = global.fetch, lookup = dns.lookup, request = https.request;
  t.after(() => { global.fetch = fetch; dns.lookup = lookup; https.request = request;
    if (old === undefined) delete process.env.ALLOWLY_N8N_STATE_DIRECTORY; else process.env.ALLOWLY_N8N_STATE_DIRECTORY = old; });
  await run(directory);
}
function transport(responses, requests) {
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    assert.ok(next, 'Unexpected API call');
    return new Response(JSON.stringify(next.body ?? next), { status: next.code ?? 200, headers: { 'content-type': 'application/json' } });
  };
}
function provider(counter) {
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  https.request = (_options, callback) => {
    counter.count++;
    const req = new EventEmitter();
    req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.end = () => queueMicrotask(() => { const res = new EventEmitter(); res.statusCode = 200;
      callback(res); res.emit('data', Buffer.from('[]')); res.emit('end'); });
    return req;
  };
}

for (const kind of ['confirm', 'escalate']) for (const approved of [true, false]) {
  test(`${kind}/${approved ? 'approve' : 'reject'}: real bundled SDK persists Wait, same operation, no duplicate dispatch`, async t => isolated(t, async directory => {
    const calls = [], sends = { count: 0 }, waiting = wire(kind), allow = wire(kind, 'approved');
    const claim = { operation_id: original.operationId, dispatch_state: 'claimed', approval: allow.approval,
      approval_sha256: allow.approval_sha256, approval_expires_at: allow.approval_expires_at, effective_evidence_mode: 'receipt' };
    transport([waiting, waiting, waiting, ...(approved ? [allow, claim, wire(kind, 'succeeded')]
      : [rejectedReview, waiting, reviewStatus(kind), rejectedReview, waiting, reviewStatus(kind)])], calls);
    provider(sends);
    const first = await invoke('executeHttp');
    assert.equal(first.state, 'waiting_for_review'); assert.equal(first.review.kind, kind);
    assert.deepEqual(await invoke('executeHttp'), first); // Recreated node/client, same durable SDK journal.
    assert.equal(calls.length, 1); assert.equal(sends.count, 0);
    assert.equal((await invoke('getExecution')).execution.operationId, original.operationId);
    assert.equal((await invoke('continueHttpExecution')).state, 'waiting_for_review'); // Early/lost callback: status is still pending.
    if (approved) {
      const final = await invoke('continueHttpExecution');
      assert.equal(final.state, 'response_observed');
      assert.equal(final.protectedActionAllowed, false); assert.equal(Object.hasOwn(final, 'providerResponse'), false);
      assert.deepEqual(await invoke('continueHttpExecution'), final);
    } else {
      const denied = await invoke('continueHttpExecution');
      assert.equal(denied.state, 'denied'); assert.equal(denied.decision, 'deny'); assert.equal(denied.reason, 'review_rejected');
      assert.equal(denied.authorization.operationId, original.operationId);
      assert.equal(denied.authorization.status, 'waiting_for_review'); // Do not invent a new API execution state.
      assert.equal(denied.review.sourceReceiptId, 'rcp_source'); assert.equal(denied.resolution.resolutionReceiptId, 'rcp_resolution');
      assert.equal(denied.resolution.status, 'rejected'); assert.equal(denied.protectedActionAllowed, false);
      for (const field of ['response', 'providerResponse', 'evidencePackage', 'outcomePending']) assert.equal(Object.hasOwn(denied, field), false);
      assert.deepEqual(await invoke('continueHttpExecution'), denied);
      assert.equal((await invoke('executeHttp')).state, 'waiting_for_review');
    }
    assert.equal(sends.count, approved ? 1 : 0);
    const prepare = JSON.parse(calls[0].init.body);
    for (const call of calls.filter(c => c.url.endsWith('/continue'))) {
      assert.deepEqual(JSON.parse(call.init.body).execution_request, prepare);
      assert.equal(JSON.parse(call.init.body).source_receipt_id, 'rcp_source');
    }
    const folders = await readdir(directory);
    const journals = await readdir(join(directory, folders.find(f => f.startsWith('journal-'))));
    const text = await readFile(join(directory, folders[0], journals.find(f => f.endsWith('.json'))), 'utf8');
    assert.equal(text.includes('synthetic-runtime-key'), false);
  }));
}

test('changed request and wrong bound status fail closed before dispatch', async t => isolated(t, async () => {
  const calls = [], sends = { count: 0 };
  transport([wire(), { ...wire(), request_descriptor: { ...wire().request_descriptor, authorization_id: 'auth_other' } }], calls);
  provider(sends); await invoke('executeHttp');
  await assert.rejects(invoke('continueHttpExecution', { ...original, url: original.url + '&changed=1' }), /different customer HTTP inputs/);
  await assert.rejects(invoke('getExecution'), /unchanged original request/);
  assert.equal(sends.count, 0);
}));

for (const kind of ['confirm', 'escalate']) {
  for (const changes of [
    { source_receipt_id: 'rcp_other' }, { authorization_id: 'auth_other' }, { action: 'other.action' },
    { resource: 'other:resource' }, { resolved_at: null }, { resolution_receipt_id: null },
  ]) test(`${kind}: rejected status with ${Object.keys(changes)[0]} mismatch is not a denial`, async t => isolated(t, async () => {
    const calls = [], sends = { count: 0 };
    transport([wire(kind), rejectedReview, wire(kind), reviewStatus(kind, changes)], calls); provider(sends);
    await invoke('executeHttp'); await assert.rejects(invoke('continueHttpExecution'), /bound recorded rejection/);
    assert.equal(sends.count, 0);
  }));
  for (const status of ['pending', 'expired', 'unknown', 'revoked']) {
    test(`${kind}: ${status} review is not a human rejection`, async t => isolated(t, async () => {
      const calls = [], sends = { count: 0 };
      const statusWire = reviewStatus(kind, { status: status === 'revoked' ? 'approved' : status,
        authority_status: status === 'revoked' ? 'revoked' : 'none',
        resolved_at: ['pending', 'expired'].includes(status) ? null : '2026-01-01T00:00:00Z',
        resolution_receipt_id: status === 'pending' ? null : 'rcp_resolution' });
      transport([wire(kind), rejectedReview, wire(kind), statusWire], calls); provider(sends);
      await invoke('executeHttp'); await assert.rejects(invoke('continueHttpExecution'), /not approved with available authority/);
      assert.equal(sends.count, 0);
    }));
  }
}

test('generic conflicts, network faults and status failures never become human denial', async t => isolated(t, async () => {
  const calls = [], sends = { count: 0 };
  transport([wire(), { code: 409, body: { error: { code: 'idempotency_conflict', message: 'generic conflict' } } },
    new Error('network timeout'), rejectedReview, wire(), new Error('status unavailable')], calls); provider(sends);
  await invoke('executeHttp');
  await assert.rejects(invoke('continueHttpExecution'), /generic conflict/); assert.equal(calls.length, 2);
  await assert.rejects(invoke('continueHttpExecution'), /Allowly request failed/); assert.equal(calls.length, 3);
  await assert.rejects(invoke('continueHttpExecution'), /Allowly request failed/); assert.equal(calls.length, 6);
  assert.equal(sends.count, 0);
}));

test('changed policy input is rejected by the SDK saved-request guard before rejection lookup', async t => isolated(t, async () => {
  const calls = [], sends = { count: 0 }; transport([wire()], calls); provider(sends);
  await invoke('executeHttp');
  await assert.rejects(invoke('continueHttpExecution', { ...original,
    policyInput: { ...original.policyInput, context: { scenario: 'changed' } } }), /different customer HTTP inputs/);
  assert.equal(calls.length, 1); assert.equal(sends.count, 0);
}));

test('ambiguous claim and outcome recovery use SDK journal and never resend', async t => isolated(t, async () => {
  const calls = [], sends = { count: 0 }, allow = wire('confirm', 'approved');
  transport([wire(), allow, new Error('claim transport unavailable'), wire('confirm', 'unknown'), wire('confirm', 'unknown')], calls);
  provider(sends); await invoke('executeHttp');
  assert.equal((await invoke('continueHttpExecution')).state, 'unknown');
  assert.equal((await invoke('executeHttp')).state, 'unknown');
  assert.equal(sends.count, 0);
}));

test('private storage and identity fail closed; no workflow-controlled paths', async t => isolated(t, async directory => {
  await assert.rejects(invoke('executeHttp', { ...original, journalDirectory: '/private/tmp/invented' }), /unsupported fields/);
  await assert.rejects(invoke('executeHttp', original, { identityMode: 'allowlyNative', nativeAgentCredential: '{}' }), /completed JSON file/);
  await chmod(directory, 0o755);
  await assert.rejects(invoke('executeHttp'), /private owned directory/);
  await chmod(directory, 0o700);
  const alias = directory + '-alias'; await symlink(directory, alias);
  process.env.ALLOWLY_N8N_STATE_DIRECTORY = alias;
  await assert.rejects(invoke('executeHttp'), /private owned directory/);
}));

test('ambiguous outcome upload recovers the durable result with one provider send', async t => isolated(t, async () => {
  const calls = [], sends = { count: 0 }, allow = wire('confirm', 'approved');
  const claim = { operation_id: original.operationId, dispatch_state: 'claimed', approval: allow.approval,
    approval_sha256: allow.approval_sha256, approval_expires_at: allow.approval_expires_at, effective_evidence_mode: 'receipt' };
  transport([wire(), allow, claim, new Error('outcome upload unavailable'), wire('confirm', 'succeeded'), wire('confirm', 'succeeded')], calls);
  provider(sends); await invoke('executeHttp');
  const pending = await invoke('continueHttpExecution');
  assert.equal(pending.state, 'response_observed'); assert.equal(pending.outcomePending, true); assert.equal(sends.count, 1);
  const reconciled = await invoke('reconcileHttpExecution');
  assert.equal(reconciled.state, 'response_observed'); assert.equal(reconciled.outcomePending, false); assert.equal(sends.count, 1);
  const outcomes = calls.filter(c => c.url.endsWith('/outcome'));
  assert.equal(outcomes.length, 2); assert.equal(outcomes[0].init.body, outcomes[1].init.body);
}));

test('Standard Webhook verification preserves bytes, bounds and workspace; never grants permission', async () => {
  const secret = 'whsec_' + Buffer.alloc(32, 7).toString('base64'), now = Math.floor(Date.now() / 1000);
  const event = { id: 'evt_node', type: 'confirmation.resolved', timestamp: new Date().toISOString(), workspace_id: 'ws_n8n',
    data: { prompt_id: 'cnf_prompt', status: 'approved', source_receipt_id: 'rcp_source', resolution_receipt_id: 'rcp_resolution' } };
  const bytes = Buffer.from(JSON.stringify(event));
  const signature = createHmac('sha256', Buffer.alloc(32, 7)).update(`evt_node.${now}.`).update(bytes).digest('base64');
  const extra = { bytes, binary: { data: { data: bytes.toString('base64') } }, resolutionRawBodyField: 'data',
    resolutionWebhookHeaders: { 'webhook-id': 'evt_node', 'webhook-timestamp': String(now), 'webhook-signature': 'v1,' + signature } };
  const credential = { resolutionWebhookSigningSecret: secret };
  const result = await invoke('verifyResolutionWebhook', original, credential, extra);
  assert.equal(result.event.data.promptId, 'cnf_prompt'); assert.equal(result.notificationOnly, true); assert.equal(result.protectedActionAllowed, false);
  assert.deepEqual(await invoke('verifyResolutionWebhook', original, credential, extra), result); // Durable workflow table, not verifier, deduplicates events.
  await assert.rejects(invoke('verifyResolutionWebhook', original, credential, { ...extra, bytes: Buffer.from(JSON.stringify(event, null, 2)) }), /did not verify/);
  await assert.rejects(invoke('verifyResolutionWebhook', original, { ...credential, executionWorkspaceId: 'ws_other' }, extra), /workspace ID does not match/);
  await assert.rejects(invoke('verifyResolutionWebhook', original, credential, { ...extra, bytes: Buffer.alloc(16 * 1024 + 1) }), /at most 16 KiB/);
  await assert.rejects(invoke('verifyResolutionWebhook', original, credential, { ...extra, binary: undefined }), /original raw binary/);
});

test('generic 409 stays an error even when a rejected review could be fetched', async t => isolated(t, async () => {
  const calls = [], sends = { count: 0 };
  transport([wire(), { code: 409, body: { error: { code: 'idempotency_conflict', message: 'generic conflict' } } },
    wire(), reviewStatus()], calls); provider(sends);
  await invoke('executeHttp'); await assert.rejects(invoke('continueHttpExecution'), /generic conflict/);
  assert.equal(calls.length, 2); assert.equal(sends.count, 0);
}));

test('a different operation in rejection lookup is not a denial', async t => isolated(t, async () => {
  const calls = [], sends = { count: 0 }, other = wire();
  other.operation_id = 'op_other'; other.request_descriptor.operation_id = 'op_other';
  transport([wire(), rejectedReview, other, reviewStatus()], calls); provider(sends);
  await invoke('executeHttp');
  await assert.rejects(invoke('continueHttpExecution'), /execution response does not match the requested operation/);
  assert.equal(calls.length, 3); assert.equal(sends.count, 0);
}));

for (const kind of ['confirm', 'escalate']) {
  test(`${kind} status cannot swap its body prompt ID`, async t => isolated(t, async () => {
    const calls = [], sends = { count: 0 };
    const key = kind === 'confirm' ? 'confirmation_id' : 'escalation_id';
    transport([wire(kind), rejectedReview, wire(kind), reviewStatus(kind, { [key]: kind === 'confirm' ? 'cnf_other' : 'esc_other' })], calls);
    provider(sends); await invoke('executeHttp');
    await assert.rejects(invoke('continueHttpExecution'), /does not match the request/);
    assert.equal(calls.length, 4); assert.equal(sends.count, 0);
  }));
}
