const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Allowly, waitForSignedSeal, apiBaseUrl, testApiCredential } = require('../dist/nodes/Allowly/Allowly.node.js');
const verifier = require('../dist/nodes/Allowly/seal-verifier.js');

test('operator local endpoint covers ordinary API calls, receipt polling and workspace keys', async t => {
  const oldUrl = process.env.ALLOWLY_N8N_API_BASE_URL, oldLocal = process.env.ALLOWLY_N8N_ALLOW_LOCAL_API;
  t.after(() => {
    for (const [key, value] of [['ALLOWLY_N8N_API_BASE_URL', oldUrl], ['ALLOWLY_N8N_ALLOW_LOCAL_API', oldLocal]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  process.env.ALLOWLY_N8N_API_BASE_URL = 'http://127.0.0.1:18182/';
  process.env.ALLOWLY_N8N_ALLOW_LOCAL_API = 'true';
  const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/seal/verification-v1.json')));
  const vector = fixture.should_verify[0], receiptId = verifier.decodeReceipt(vector.receipt).receipt_id;
  const policyRef = { policy_id: 'pol_local', policy_version: 1, definition_sha256: 'a'.repeat(64) };
  const requests = [];
  const run = async (operation, params, response) => {
    const context = {
      getInputData: () => [{ json: { baseUrl: 'https://attacker.example' } }],
      getCredentials: async () => ({ apiKey: 'synthetic', baseUrl: 'https://attacker.example' }),
      getNodeParameter: (name, _index, fallback) => ({ operation, ...params }[name] ?? fallback),
      getExecutionId: () => 'local-routing-test', getNode: () => ({ name: 'Local Allowly' }), continueOnFail: () => false,
      helpers: { httpRequestWithAuthentication: async (_credential, options) => {
        requests.push(options);
        if (options.url.includes('/keys')) return fixture.public_keys;
        if (options.method === 'GET' && options.url.includes('/receipts/')) return { status: 'signed', receipt: vector.receipt };
        return response;
      } },
    };
    await new Allowly().execute.call(context);
    return context;
  };
  await run('check', { authorization: 'auth_local', actions: 'email.send', resource: '', session: '', workflowUser: '', workflowAgent: '', contextJson: '{}', clientTimestamp: '', estimatedCostMicros: '' }, { results: { 'email.send': { decision: 'allow' } } });
  await run('createAuthorization', { policyId: 'pol_local', policyVersion: 1, authorizationActions: '["email.send"]', userIdentifierMode: 'opaque', userId: 'user_local' }, { authorization_id: 'auth_local', policy_ref: policyRef, actions: ['email.send'] });
  await run('resolveConfirmation', { confirmationNonce: 'cnf/local', confirmationApproved: false, confirmationTtlSeconds: 60, confirmationIdempotencyKey: '' }, { decision: 'rejected' });
  await run('resolveEscalation', { escalationId: 'esc/local', escalationResolution: 'rejected', escalationResolvedBy: 'owner_local', escalationNote: '' }, { status: 'rejected' });
  await run('settleBudget', { checkReceiptId: 'rcp_local', actualCostMicros: 0, settlementIdempotencyKey: '' }, {});
  await run('seal', { sealRecordInputMode: 'rawJson', sealRecordJson: vector.raw_json, sealRequestId: 'seal_local', sealMetadata: '{}' }, {
    request_id: 'seal_local', profile: verifier.SEAL_PROFILE, workspace_id: fixture.expected_workspace_id,
    record_sha256: verifier.decodeReceipt(vector.receipt).context.record_sha256,
    decision: 'allow', receipt: { status: 'signed', receipt: vector.receipt },
  });
  await run('acknowledgeReceipt', { ackReceipt: vector.receipt, ackIdempotencyKey: 'ack_local', ackClientTimestamp: '2026-10-11T00:00:00Z' }, {});
  const ctx = await run('verifySeal', { sealRecordInputMode: 'rawJson', sealRecordJson: vector.raw_json, sealExpectedWorkspaceId: fixture.expected_workspace_id, sealReceipt: { status: 'pending', receipt_id: receiptId } });
  await waitForSignedSeal(ctx, 0, { status: 'pending', receipt_id: receiptId }, 0);
  assert.deepEqual(requests.map(r => new URL(r.url).pathname), ['/v1/check', '/v1/authorizations', '/v1/confirmations/cnf%2Flocal', '/v1/escalations/esc%2Flocal/resolve', '/v1/budget-settlements', '/v1/seal', `/v1/workspaces/${fixture.expected_workspace_id}/keys`, `/v1/receipts/${receiptId}/acknowledgments`, `/v1/receipts/${receiptId}`, `/v1/workspaces/${fixture.expected_workspace_id}/keys`, `/v1/receipts/${receiptId}`]);
  for (const request of requests) {
    assert.equal(new URL(request.url).origin, 'http://127.0.0.1:18182');
    assert.equal(request.disableFollowRedirect, true);
    assert.equal(request.sendCredentialsOnCrossOriginRedirect, false);
  }
  const checked = await testApiCredential.call({ helpers: { request: async options => {
    assert.equal(options.uri, 'http://127.0.0.1:18182/v1/authorizations?limit=1');
    assert.equal(options.followRedirect, false);
    return { statusCode: 200 };
  } } }, { data: { apiKey: 'synthetic' } });
  assert.equal(checked.status, 'OK');
  for (const bad of ['http://public.example', 'http://169.254.169.254', 'http://10.0.0.1', 'https://user:password@example.com', 'https://example.com/v1', 'https://example.com/?query=1', 'https://example.com/#fragment', 'ftp://localhost', 'http://127.1', ' http://localhost']) {
    process.env.ALLOWLY_N8N_API_BASE_URL = bad;
    assert.throws(apiBaseUrl, /Operator API endpoint/);
  }
  process.env.ALLOWLY_N8N_API_BASE_URL = 'http://localhost:18182';
  delete process.env.ALLOWLY_N8N_ALLOW_LOCAL_API;
  assert.throws(apiBaseUrl, /explicitly enabled local/);
  delete process.env.ALLOWLY_N8N_API_BASE_URL;
  assert.equal(apiBaseUrl(), 'https://api.allowly.ai');
});
