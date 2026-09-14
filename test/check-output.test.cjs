const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const { join } = require('node:path');
const axios = require('axios');
const { AllowlyApi } = require('../dist/credentials/AllowlyApi.credentials.js');
const { AllowlySealWebhookApi } = require('../dist/credentials/AllowlySealWebhookApi.credentials.js');
const {
	Allowly,
	mostRestrictiveResult,
	n8nIdempotencyKey,
	parseContext,
	parseEstimatedCostMicros,
	parseSealWebhookUrl,
	testSealWebhookCredential,
	waitForSignedSeal,
} = require('../dist/nodes/Allowly/Allowly.node.js');

async function sealFixture() {
	const verification = packagedSealVector('verification-v1.json');
	const vector = verification.should_verify[0];
	return {
		digest: vector.receipt.context.record_sha256,
		keysDocument: verification.public_keys,
		receipt: vector.receipt,
		record: JSON.parse(vector.raw_json),
		workspaceId: verification.expected_workspace_id,
	};
}

function packagedSealVector(relativePath) {
	return JSON.parse(
		readFileSync(join(__dirname, 'fixtures', 'seal', relativePath), 'utf8'),
	);
}

test('vendored verifier and SEAL fixtures match recorded provenance', () => {
	const provenance = require('../VERIFIER_PROVENANCE.json');
	const expected = {
		[provenance.bundle.path]: provenance.bundle.sha256,
		...provenance.fixtures,
	};
	for (const [relativePath, digest] of Object.entries(expected)) {
		const actual = createHash('sha256')
			.update(readFileSync(join(__dirname, '..', relativePath)))
			.digest('hex');
		assert.equal(actual, digest, relativePath);
	}
});

function generatedSealJson(generator) {
	if (generator.kind === 'string_value_total_utf8_bytes') {
		const prefix = '{"v":"';
		const suffix = '"}';
		return prefix + 'a'.repeat(generator.utf8_bytes - prefix.length - suffix.length) + suffix;
	}
	if (generator.kind === 'nested_arrays') {
		return '['.repeat(generator.depth - 1) + '0' + ']'.repeat(generator.depth - 1);
	}
	throw new Error(`Unknown SEAL vector generator: ${generator.kind}`);
}

function sealVectorInput(vector) {
	if (Object.hasOwn(vector, 'raw_json')) return vector.raw_json;
	if (Object.hasOwn(vector, 'raw_utf8_base64')) {
		return new Uint8Array(Buffer.from(vector.raw_utf8_base64, 'base64url'));
	}
	return generatedSealJson(vector.generator);
}

function settlementContext(response, checkReceiptIds = ['rcp_check_123']) {
	const parameters = {
		operation: 'settleBudget',
		actualCostMicros: 25,
		settlementIdempotencyKey: '',
	};
	const requests = [];
	return {
		requests,
		getInputData: () => checkReceiptIds.map(() => ({ json: {} })),
		getCredentials: async () => ({}),
		getNodeParameter: (name, itemIndex) =>
			name === 'checkReceiptId' ? checkReceiptIds[itemIndex] : parameters[name],
		getExecutionId: () => 'execution-42',
		getNode: () => ({ name: 'Settle Budget' }),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentials, options) => {
				requests.push(options);
				if (response instanceof Error) throw response;
				return response;
			},
		},
	};
}

test('multi-action output selects the most restrictive result', () => {
	const selected = mostRestrictiveResult(
		{
			'email.send': { decision: 'allow' },
			'payment.charge': { decision: 'deny', reason: 'blocked' },
		},
		['email.send', 'payment.charge'],
	);

	assert.deepEqual(selected, {
		action: 'payment.charge',
		result: { decision: 'deny', reason: 'blocked' },
	});
});

test('context accepts a native object from an expression', () => {
	const context = { source: 'workflow' };
	assert.equal(parseContext(context, null, 0), context);
});

test('estimated cost removes floating-point dust', () => {
	assert.equal(parseEstimatedCostMicros(2.01 * 1_000_000, null, 0), 2_010_000);
});

test('explicit zero estimate is preserved; -1 and absent are omitted', () => {
	assert.equal(parseEstimatedCostMicros(0, null, 0), 0);
	assert.equal(parseEstimatedCostMicros(-1, null, 0), null);
	assert.equal(parseEstimatedCostMicros('', null, 0), null);
	assert.equal(parseEstimatedCostMicros(undefined, null, 0), null);
});

test('estimated cost rejects fractional and unsafe integers', () => {
	const executeFunctions = { getNode: () => ({ name: 'Allowly' }) };
	assert.throws(() => parseEstimatedCostMicros(1.5, executeFunctions, 0), /non-negative integer/);
	assert.throws(() => parseEstimatedCostMicros(Number.MAX_SAFE_INTEGER + 1, executeFunctions, 0), /non-negative integer/);
});

function checkContext(parameters, response) {
	const requests = [];
	return {
		requests,
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({}),
		getNodeParameter: (name) => parameters[name],
		getExecutionId: () => 'execution-42',
		getNode: () => ({ name: 'Allowly' }),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentials, options) => {
				requests.push(options);
				return response;
			},
		},
	};
}

test('check serializes an explicit zero-cost estimate', async () => {
	const context = checkContext(
		{
			operation: 'check',
			authorization: 'auth_123',
			actions: 'llm.enrich',
			resource: '',
			session: '',
			estimatedCostMicros: 0,
			workflowUser: '',
			workflowAgent: '',
			contextJson: '',
		},
		{ results: { 'llm.enrich': { decision: 'allow', reason: 'authorization_granted_action_active' } } },
	);
	await new Allowly().execute.call(context);
	assert.equal(context.requests[0].body.estimated_cost_micros, 0);
	assert.ok(Object.hasOwn(context.requests[0].body, 'estimated_cost_micros'));
});

test('check omits the estimate at the -1 default', async () => {
	const context = checkContext(
		{
			operation: 'check',
			authorization: 'auth_123',
			actions: 'llm.enrich',
			resource: '',
			session: '',
			estimatedCostMicros: -1,
			workflowUser: '',
			workflowAgent: '',
			contextJson: '',
		},
		{ results: { 'llm.enrich': { decision: 'allow', reason: 'authorization_granted_action_active' } } },
	);
	await new Allowly().execute.call(context);
	assert.ok(!Object.hasOwn(context.requests[0].body, 'estimated_cost_micros'));
});

test('idempotency keys are stable per execution item', () => {
	const key = n8nIdempotencyKey('42', 'Allowly 🔒', 0);
	assert.equal(key, n8nIdempotencyKey('42', 'Allowly 🔒', 0));
	assert.notEqual(key, n8nIdempotencyKey('42', 'Allowly 🔒', 1));
	assert.match(key, /^n8n:[A-Za-z0-9_-]{43}$/);
});

test('packaged SEAL conformance vectors gate the n8n hashing and verifier dependency', async () => {
	const verifier = require('../dist/nodes/Allowly/seal-verifier.js');
	const profile = packagedSealVector('profile-v1.json');
	const verification = packagedSealVector('verification-v1.json');

	assert.equal(profile.profile, verifier.SEAL_PROFILE);
	assert.deepEqual(profile.limits, {
		max_utf8_bytes: verifier.SEAL_MAX_UTF8_BYTES,
		max_depth: verifier.SEAL_MAX_DEPTH,
	});
	for (const vector of [...profile.should_hash, ...profile.generated_should_hash]) {
		assert.equal(verifier.hashSealJson(sealVectorInput(vector)), vector.record_sha256, vector.name);
	}
	for (const vector of profile.equivalent) {
		assert.deepEqual(
			new Set(vector.raw_jsons.map(verifier.hashSealJson)),
			new Set([vector.record_sha256]),
			vector.name,
		);
	}
	for (const vector of profile.should_differ) {
		assert.equal(
			new Set(vector.raw_jsons.map(verifier.hashSealJson)).size,
			vector.raw_jsons.length,
			vector.name,
		);
	}
	for (const vector of profile.should_reject) {
		assert.throws(
			() => verifier.hashSealJson(sealVectorInput(vector)),
			(error) => error instanceof verifier.SealInputError && error.code === vector.expected_code,
			vector.name,
		);
	}

	const keys = verifier.loadKeysFromJson(verification.public_keys);
	for (const vector of [...verification.should_verify, ...verification.should_reject]) {
		const result = await verifier.verifySealJson(vector.raw_json, vector.receipt, keys, {
			expectedWorkspaceId: verification.expected_workspace_id,
			trustedKeyFingerprints: new Set(verification.trusted_key_fingerprints),
			now: new Date(verification.now),
		});
		assert.deepEqual(
			result,
			{
				signatureVerified: vector.expected.signature_verified,
				recordMatches: vector.expected.record_matches,
				failureReason: vector.expected.failure_reason,
			},
			vector.name,
		);
	}
});

function sealContext(operation, parameters, requestHandler) {
	const requests = [];
	return {
		requests,
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({}),
		getNodeParameter: (name) => (name === 'operation' ? operation : parameters[name]),
		getExecutionId: () => 'seal-execution-42',
		getNode: () => ({ name: operation === 'seal' ? 'Seal Record' : 'Verify Seal' }),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentials, options) => {
				requests.push(options);
				return requestHandler(options);
			},
		},
	};
}

test('Seal hashes locally, polls until signed, and returns portable evidence', async () => {
	const fixture = await sealFixture();
	const record = fixture.record;
	const context = sealContext(
		'seal',
		{
			sealRecordInputMode: 'value',
			sealRecordValue: record,
			sealRequestId: '',
			sealMetadata: { source: 'n8n' },
		},
		(options) => {
			if (options.url.endsWith('/v1/seal')) {
				return {
					request_id: options.body.request_id,
					workspace_id: fixture.workspaceId,
					profile: 'allowly.seal.jcs-sha256.v1',
					record_sha256: fixture.digest,
					decision: 'allow',
					reason: 'authorization_granted_action_active',
					receipt: { status: 'pending', receipt_id: fixture.receipt.receipt_id },
				};
			}
			if (options.url.includes('/v1/receipts/')) {
				return { status: 'signed', receipt: fixture.receipt };
			}
			if (options.url.includes('/v1/workspaces/')) return fixture.keysDocument;
			throw new Error(`unexpected URL ${options.url}`);
		},
	);

	const output = await new Allowly().execute.call(context);
	const sealRequest = context.requests.find((request) => request.url.endsWith('/v1/seal'));
	assert.deepEqual(sealRequest.body, {
		request_id: n8nIdempotencyKey('seal-execution-42', 'Seal Record', 0),
		profile: 'allowly.seal.jcs-sha256.v1',
		record_sha256: fixture.digest,
		metadata: { source: 'n8n' },
	});
	assert.equal(Object.hasOwn(sealRequest.body, 'record'), false);
	assert.equal(output[0][0].json.sealed, true);
	assert.equal(output[0][0].json.signatureVerified, true);
	assert.equal(output[0][0].json.recordMatches, true);
	assert.equal(output[0][0].json.workspaceId, fixture.workspaceId);
	assert.deepEqual(output[0][0].json.record, record);
	assert.deepEqual(output[0][0].json.receipt, fixture.receipt);
	assert.deepEqual(output[0][0].json.keysDocument, fixture.keysDocument);
});

test('Seal rejects a response for another request ID', async () => {
	const fixture = await sealFixture();
	const record = fixture.record;
	const context = sealContext(
		'seal',
		{
			sealRecordInputMode: 'value',
			sealRecordValue: record,
			sealRequestId: 'expected-request',
			sealMetadata: {},
		},
		() => ({
			request_id: 'another-request',
			workspace_id: fixture.workspaceId,
			profile: 'allowly.seal.jcs-sha256.v1',
			record_sha256: fixture.digest,
			decision: 'allow',
			reason: 'authorization_granted_action_active',
			receipt: { status: 'pending', receipt_id: 'rcp_wrong_attempt' },
		}),
	);

	await assert.rejects(
		() => new Allowly().execute.call(context),
		/invalid seal response/i,
	);
});

test('Seal rejects a response without an authenticated workspace ID', async () => {
	const fixture = await sealFixture();
	const context = sealContext(
		'seal',
		{
			sealRecordInputMode: 'value',
			sealRecordValue: fixture.record,
			sealRequestId: 'expected-request',
			sealMetadata: {},
		},
		() => ({
			request_id: 'expected-request',
			profile: 'allowly.seal.jcs-sha256.v1',
			record_sha256: fixture.digest,
			decision: 'allow',
			reason: 'authorization_granted_action_active',
			receipt: { status: 'pending', receipt_id: fixture.receipt.receipt_id },
		}),
	);

	await assert.rejects(
		() => new Allowly().execute.call(context),
		/invalid seal response/i,
	);
});

test('Verify Seal fails the workflow when the record does not match', async () => {
	const fixture = await sealFixture();
	const context = sealContext(
		'verifySeal',
		{
			sealRecordInputMode: 'value',
			sealRecordValue: { ...fixture.record, status: 'changed' },
			sealReceipt: { status: 'signed', receipt: fixture.receipt },
			sealExpectedWorkspaceId: fixture.workspaceId,
		},
		(options) => {
			if (options.url.includes('/v1/workspaces/')) return fixture.keysDocument;
			throw new Error(`unexpected URL ${options.url}`);
		},
	);

	await assert.rejects(
		() => new Allowly().execute.call(context),
		/record_mismatch/,
	);
});

test('receipt polling ignores response URLs and uses the fixed Allowly origin', async () => {
	let calls = 0;
	const context = sealContext('verifySeal', {}, (options) => {
		calls += 1;
		assert.equal(options.url, 'https://api.allowly.ai/v1/receipts/rcp%2Ftrusted');
		return { status: 'signed', receipt: { receipt_id: 'rcp/trusted' } };
	});

	const receipt = await waitForSignedSeal(
		context,
		0,
		{
			status: 'pending',
			receipt_id: 'rcp/trusted',
			url: 'https://attacker.example/receipt',
		},
		0,
	);
	assert.equal(calls, 1);
	assert.equal(receipt.receipt_id, 'rcp/trusted');
});

test('receipt polling rejects a changed receipt ID', async () => {
	const context = sealContext('verifySeal', {}, () => ({
		status: 'signed',
		receipt: { receipt_id: 'rcp_other' },
	}));

	await assert.rejects(
		() => waitForSignedSeal(
			context,
			0,
			{ status: 'pending', receipt_id: 'rcp_expected' },
			0,
		),
		/receipt ID does not match/i,
	);
});

const WEBHOOK_TOKEN = 'seal_w1_s001_private_test_token_1_signature';
const WEBHOOK_URL = `https://api.allowly.ai/v1/seal/webhooks?token=${WEBHOOK_TOKEN}`;

function fullHttpResponse(statusCode, body, headers = {}) {
	return { statusCode, headers, body: JSON.stringify(body) };
}

function webhookDelivery(fixture, overrides = {}) {
	const attemptId = overrides.attempt_id ?? 'swd_test_attempt';
	const receiptId = overrides.receipt_id === undefined
		? fixture.receipt.receipt_id
		: overrides.receipt_id;
	return {
		attempt_id: attemptId,
		workspace_id: fixture.workspaceId,
		status: 'sealed',
		received_at: '2026-09-13T12:00:00.000Z',
		updated_at: '2026-09-13T12:00:01.000Z',
		profile: 'allowly.seal.jcs-sha256.v1',
		record_sha256: fixture.digest,
		receipt_id: receiptId,
		error_code: null,
		status_url: `https://api.allowly.ai/v1/seal/webhooks/deliveries/${attemptId}?token=${WEBHOOK_TOKEN}`,
		receipt_url: receiptId === null
			? null
			: `https://api.allowly.ai/v1/seal/webhooks/receipts/${receiptId}?token=${WEBHOOK_TOKEN}`,
		keys_url: `https://api.allowly.ai/v1/seal/webhooks/keys?token=${WEBHOOK_TOKEN}`,
		receipt: fixture.receipt,
		...overrides,
	};
}

function managedWebhookContext(operation, parameters, requestHandler, webhookUrl = WEBHOOK_URL) {
	const requests = [];
	const credentialNames = [];
	return {
		requests,
		credentialNames,
		getInputData: () => [{ json: {} }],
		getCredentials: async (name) => {
			credentialNames.push(name);
			return {
				webhookUrl,
				allowLocalDevelopmentUrl: webhookUrl.startsWith('http://'),
			};
		},
		getNodeParameter: (name) => (name === 'operation' ? operation : parameters[name]),
		getExecutionId: () => 'managed-seal-execution-42',
		getNode: () => ({ name: 'Managed SEAL', typeVersion: 2 }),
		continueOnFail: () => false,
		helpers: {
			httpRequest: async (options) => {
				requests.push(options);
				return requestHandler(options, requests.length);
			},
			httpRequestWithAuthentication: async () => {
				throw new Error('ordinary API credential must not be used');
			},
		},
	};
}

test('managed webhook is the v2 default while v1 keeps Check', () => {
	const description = new Allowly().description;
	const packageManifest = require('../package.json');
	assert.deepEqual(description.version, [1, 2]);
	assert.equal(description.defaultVersion, 2);
	assert.deepEqual(Object.keys(new Allowly().methods.credentialTest), ['testSealWebhookCredential']);
	assert.ok(packageManifest.n8n.nodes.includes('dist/nodes/Allowly/Allowly.node.js'));
	assert.ok(
		packageManifest.n8n.credentials.includes(
			'dist/credentials/AllowlySealWebhookApi.credentials.js',
		),
	);
	const operations = description.properties.filter(({ name }) => name === 'operation');
	assert.equal(operations.length, 2);
	assert.equal(operations.find(({ displayOptions }) => displayOptions.show['@version'][0] === 1).default, 'check');
	assert.equal(operations.find(({ displayOptions }) => displayOptions.show['@version'][0] === 2).default, 'sealWebhook');
	assert.equal(
		description.credentials.find(({ name }) => name === 'allowlySealWebhookApi').testedBy,
		'testSealWebhookCredential',
	);
});

test('managed webhook credential stores one password URL plus a disabled local-development option', () => {
	const credential = new AllowlySealWebhookApi();
	assert.equal(credential.name, 'allowlySealWebhookApi');
	assert.equal(credential.properties.length, 2);
	assert.equal(credential.properties[0].name, 'webhookUrl');
	assert.equal(credential.properties[0].typeOptions.password, true);
	assert.equal(credential.properties[1].name, 'allowLocalDevelopmentUrl');
	assert.equal(credential.properties[1].default, false);
	assert.equal(Object.hasOwn(credential, 'test'), false);
});

test('managed webhook URL parser pins production and permits loopback development only', () => {
	assert.deepEqual(parseSealWebhookUrl(WEBHOOK_URL), {
		origin: 'https://api.allowly.ai',
		token: WEBHOOK_TOKEN,
	});
	const loopbackUrl = `http://localhost:8081/v1/seal/webhooks?token=${WEBHOOK_TOKEN}`;
	assert.throws(
		() => parseSealWebhookUrl(loopbackUrl),
		/Private Webhook URL must use Allowly/,
	);
	assert.equal(parseSealWebhookUrl(loopbackUrl, true).origin, 'http://localhost:8081');
	for (const url of [
		'not-a-url',
		`http://api.allowly.ai/v1/seal/webhooks?token=${WEBHOOK_TOKEN}`,
		`https://attacker.example/v1/seal/webhooks?token=${WEBHOOK_TOKEN}`,
		`https://api.allowly.ai/v1/seal/webhooks?token=${WEBHOOK_TOKEN}&extra=1`,
		`https://api.allowly.ai/v1/seal/webhooks?token=${WEBHOOK_TOKEN}&token=again`,
		`https://api.allowly.ai/v1/seal/webhooks/keys?token=${WEBHOOK_TOKEN}`,
	]) {
		assert.throws(() => parseSealWebhookUrl(url), /Private Webhook URL/);
	}
});

test('credential test validates first, performs only a scoped GET, and returns safe errors', async () => {
	let request;
	const context = {
		helpers: {
			request: async (options) => {
				request = options;
				return {
					statusCode: 200,
					headers: {},
					body: { workspace_id: 'ws_test', keys: [] },
				};
			},
		},
	};
	const credential = {
		id: 'credential-id',
		name: 'SEAL webhook',
		type: 'allowlySealWebhookApi',
		data: { webhookUrl: WEBHOOK_URL, allowLocalDevelopmentUrl: false },
	};
	assert.deepEqual(await testSealWebhookCredential.call(context, credential), {
		status: 'OK',
		message: 'SEAL webhook credential is valid.',
	});
	assert.equal(request.method, 'GET');
	assert.equal(request.uri, `https://api.allowly.ai/v1/seal/webhooks/keys?token=${WEBHOOK_TOKEN}`);
	assert.equal(request.followRedirect, false);

	let invalidRequests = 0;
	for (const invalidUrl of [
		'not-a-url',
		`https://attacker.example/v1/seal/webhooks?token=${WEBHOOK_TOKEN}`,
		`https://api.allowly.ai/v1/seal/webhooks?token=${WEBHOOK_TOKEN}&extra=1`,
	]) {
		const invalid = await testSealWebhookCredential.call(
			{ helpers: { request: async () => { invalidRequests += 1; } } },
			{ ...credential, data: { webhookUrl: invalidUrl, allowLocalDevelopmentUrl: false } },
		);
		assert.equal(invalid.status, 'Error');
	}
	assert.equal(invalidRequests, 0);

	const failed = await testSealWebhookCredential.call(
		{
			helpers: {
				request: async () => ({
					statusCode: 401,
					headers: { 'retry-after': '2' },
					body: { error: { code: 'invalid_seal_webhook', message: WEBHOOK_TOKEN } },
				}),
			},
		},
		credential,
	);
	assert.match(failed.message, /HTTP 401: invalid_seal_webhook/);
	assert.match(failed.message, /Retry after 2 seconds/);
	assert.equal(failed.message.includes(WEBHOOK_TOKEN), false);

	const unavailable = await testSealWebhookCredential.call(
		{ helpers: { request: async () => { throw new Error(WEBHOOK_URL); } } },
		credential,
	);
	assert.deepEqual(unavailable, {
		status: 'Error',
		message: 'Could not connect to Allowly SEAL. Check the private URL and retry.',
	});
});

test('managed webhook sends exact raw JSON bytes and returns verified evidence without token URLs', async () => {
	const fixture = await sealFixture();
	const rawJson = JSON.stringify(fixture.record);
	const context = managedWebhookContext(
		'sealWebhook',
		{
			sealRecordInputMode: 'rawJson',
			sealRecordJson: rawJson,
			sealWebhookIdempotencyKey: 'sender-event-7',
			sealWebhookWaitSeconds: 0,
		},
		(options) => {
			const url = new URL(options.url);
			if (options.method === 'POST') {
				return fullHttpResponse(200, webhookDelivery(fixture));
			}
			if (url.pathname.endsWith('/keys')) {
				return fullHttpResponse(200, {
					...fixture.keysDocument,
					keys_url: `https://api.allowly.ai/v1/seal/webhooks/keys?token=${WEBHOOK_TOKEN}`,
				});
			}
			throw new Error(`unexpected safe path ${url.pathname}`);
		},
	);

	const output = await new Allowly().execute.call(context);
	const post = context.requests[0];
	const postedUrl = new URL(post.url);
	assert.equal(post.method, 'POST');
	assert.equal(postedUrl.origin + postedUrl.pathname, 'https://api.allowly.ai/v1/seal/webhooks');
	assert.deepEqual([...postedUrl.searchParams.entries()], [['token', WEBHOOK_TOKEN]]);
	assert.equal(post.headers['Idempotency-Key'], 'sender-event-7');
	assert.equal(post.headers['Content-Type'], 'application/json');
	assert.equal(Buffer.isBuffer(post.body), true);
	assert.equal(post.body.toString('utf8'), rawJson);
	assert.equal(Object.hasOwn(post.headers, 'X-Allowly-Seal-Webhook-Token'), false);
	assert.deepEqual(context.credentialNames, ['allowlySealWebhookApi']);
	assert.equal(output[0][0].json.sealed, true);
	assert.equal(output[0][0].json.signatureVerified, true);
	assert.equal(output[0][0].json.recordMatches, true);
	assert.equal(output[0][0].json.recordJson, rawJson);
	assert.equal(Object.hasOwn(output[0][0].json.keysDocument, 'keys_url'), false);
	assert.equal(JSON.stringify(output).includes(WEBHOOK_TOKEN), false);
	assert.equal(JSON.stringify(output).includes('status_url'), false);
});

test('managed webhook raw body survives the HTTP client transform unchanged', async () => {
	const rawJson = '{"duplicate":1,"duplicate":2,"unsafe":9007199254740993';
	let captured;
	const server = createServer((request, response) => {
		const chunks = [];
		request.on('data', (chunk) => chunks.push(chunk));
		request.on('end', () => {
			captured = {
				body: Buffer.concat(chunks),
				headers: request.headers,
				url: request.url,
			};
			response.writeHead(422, { 'Content-Type': 'application/json' });
			response.end('{"error":{"code":"seal_invalid_json","message":"invalid"}}');
		});
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	assert.notEqual(address, null);
	try {
		const context = managedWebhookContext(
			'sealWebhook',
			{
				sealRecordInputMode: 'rawJson',
				sealRecordJson: rawJson,
				sealWebhookIdempotencyKey: 'raw-byte-test',
				sealWebhookWaitSeconds: 0,
			},
			async (options) => {
				const response = await axios({
					method: options.method,
					url: options.url,
					headers: options.headers,
					data: options.body,
					maxRedirects: 0,
					responseType: 'text',
					transformResponse: [(body) => body],
					validateStatus: () => true,
				});
				return {
					body: response.data,
					headers: response.headers,
					statusCode: response.status,
				};
			},
			`http://127.0.0.1:${address.port}/v1/seal/webhooks?token=${WEBHOOK_TOKEN}`,
		);
		await assert.rejects(() => new Allowly().execute.call(context), /HTTP 422: seal_invalid_json/);
		assert.equal(captured.body.toString('utf8'), rawJson);
		assert.equal(captured.headers['content-type'], 'application/json');
		assert.equal(captured.url, `/v1/seal/webhooks?token=${WEBHOOK_TOKEN}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
});

test('zero-wait webhook output is pending and the retrieve operation completes it', async () => {
	const fixture = await sealFixture();
	const rawJson = JSON.stringify(fixture.record);
	const pendingDelivery = webhookDelivery(fixture, { status: 'signing', receipt: null });
	const sendContext = managedWebhookContext(
		'sealWebhook',
		{
			sealRecordInputMode: 'rawJson',
			sealRecordJson: rawJson,
			sealWebhookIdempotencyKey: '',
			sealWebhookWaitSeconds: 0,
		},
		() => fullHttpResponse(202, pendingDelivery),
	);
	const pending = await new Allowly().execute.call(sendContext);
	assert.equal(pending[0][0].json.sealed, false);
	assert.equal(pending[0][0].json.pending, true);
	assert.equal(pending[0][0].json.attemptId, pendingDelivery.attempt_id);
	assert.equal(pending[0][0].json.recordJson, rawJson);
	assert.equal(sendContext.requests.length, 1);

	const retrieveContext = managedWebhookContext(
		'retrieveWebhookSeal',
		{
			sealRecordInputMode: 'rawJson',
			sealRecordJson: pending[0][0].json.recordJson,
			sealWebhookAttemptId: pending[0][0].json.attemptId,
			sealWebhookWaitSeconds: 0,
		},
		(options) => {
			const path = new URL(options.url).pathname;
			if (path.includes('/deliveries/')) {
				return fullHttpResponse(200, webhookDelivery(fixture));
			}
			if (path.endsWith('/keys')) return fullHttpResponse(200, fixture.keysDocument);
			throw new Error(`unexpected safe path ${path}`);
		},
	);
	const sealed = await new Allowly().execute.call(retrieveContext);
	assert.equal(sealed[0][0].json.sealed, true);
	assert.equal(sealed[0][0].json.attemptId, pendingDelivery.attempt_id);
	assert.equal(sealed[0][0].json.recordJson, rawJson);
	assert.equal(JSON.stringify(sealed).includes(WEBHOOK_TOKEN), false);
});

test('managed webhook retries Retry-After with the same ID and exact content', async () => {
	const fixture = await sealFixture();
	const rawJson = JSON.stringify(fixture.record);
	const context = managedWebhookContext(
		'sealWebhook',
		{
			sealRecordInputMode: 'rawJson',
			sealRecordJson: rawJson,
			sealWebhookIdempotencyKey: 'sender-event-retry',
			sealWebhookWaitSeconds: 0,
		},
		(_options, call) => call === 1
			? fullHttpResponse(503, { error: { code: 'overloaded' } }, { 'Retry-After': '0' })
			: fullHttpResponse(202, webhookDelivery(fixture, { status: 'signing', receipt: null })),
	);
	const output = await new Allowly().execute.call(context);
	assert.equal(output[0][0].json.pending, true);
	assert.equal(context.requests.length, 2);
	assert.equal(context.requests[0].url, context.requests[1].url);
	assert.equal(context.requests[0].headers['Idempotency-Key'], 'sender-event-retry');
	assert.equal(context.requests[1].headers['Idempotency-Key'], 'sender-event-retry');
	assert.equal(context.requests[0].body.toString('utf8'), rawJson);
	assert.equal(context.requests[1].body.toString('utf8'), rawJson);
});

test('managed webhook errors and malformed credentials never expose the URL or record', async () => {
	const privateRecord = '{"private":"PRIVATE_RECORD_MARKER"}';
	const context = managedWebhookContext(
		'sealWebhook',
		{
			sealRecordInputMode: 'rawJson',
			sealRecordJson: privateRecord,
			sealWebhookIdempotencyKey: 'sender-conflict',
			sealWebhookWaitSeconds: 0,
		},
		() => fullHttpResponse(409, {
			error: { code: 'idempotency_key_reused', message: `${WEBHOOK_TOKEN} ${privateRecord}` },
		}),
	);
	await assert.rejects(
		() => new Allowly().execute.call(context),
		(error) => {
			assert.match(error.message, /HTTP 409: idempotency_key_reused/);
			assert.equal(error.message.includes(WEBHOOK_TOKEN), false);
			assert.equal(error.message.includes('PRIVATE_RECORD_MARKER'), false);
			return true;
		},
	);

	for (const invalidUrl of [
		`https://attacker.example/v1/seal/webhooks?token=${WEBHOOK_TOKEN}`,
		`https://api.allowly.ai/v1/seal/webhooks?token=${WEBHOOK_TOKEN}&extra=1`,
	]) {
		const invalid = managedWebhookContext(
			'sealWebhook',
			{
				sealRecordInputMode: 'rawJson',
				sealRecordJson: privateRecord,
				sealWebhookIdempotencyKey: '',
				sealWebhookWaitSeconds: 0,
			},
			() => { throw new Error('request must not run'); },
			invalidUrl,
		);
		await assert.rejects(() => new Allowly().execute.call(invalid), /Private Webhook URL/);
		assert.equal(invalid.requests.length, 0);
	}
});

test('saved evidence verifies without any credential or network request', async () => {
	const fixture = await sealFixture();
	const context = sealContext(
		'verifySealEvidence',
		{
			sealRecordInputMode: 'value',
			sealRecordValue: fixture.record,
			sealReceipt: { status: 'signed', receipt: fixture.receipt },
			sealExpectedWorkspaceId: fixture.workspaceId,
			sealKeysDocument: fixture.keysDocument,
		},
		() => { throw new Error('network request must not run'); },
	);
	let credentialCalls = 0;
	context.getCredentials = async () => {
		credentialCalls += 1;
		throw new Error('credential must not be read');
	};

	const output = await new Allowly().execute.call(context);
	assert.equal(credentialCalls, 0);
	assert.equal(context.requests.length, 0);
	assert.equal(output[0][0].json.verified, true);
	assert.equal(output[0][0].json.signatureVerified, true);
	assert.equal(output[0][0].json.recordMatches, true);
});

test('keeps the email pepper in credentials and pins requests to the Allowly API', async () => {
	const credential = new AllowlyApi();
	const pepperProperty = credential.properties.find(({ name }) => name === 'userIdPepper');
	assert.equal(credential.properties.some(({ name }) => name === 'apiUrl'), false);
	assert.equal(pepperProperty.typeOptions.password, true);
	assert.equal(new Allowly().description.properties.some(({ name }) => name === 'userIdPepper'), false);

	const requests = [];
	const parameters = {
		operation: 'createAuthorization',
		policyId: 'policy_123',
		userIdentifierMode: 'emailHmac',
		userEmail: ' Alice@Example.COM ',
	};
	const context = {
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({
			apiUrl: 'https://attacker.example',
			userIdPepper: 'credential-secret',
		}),
		getNodeParameter: (name) => {
			assert.notEqual(name, 'userIdPepper');
			return parameters[name];
		},
		getExecutionId: () => 'execution-42',
		getNode: () => ({ name: 'Allowly' }),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentials, options) => {
				requests.push(options);
				return { authorization_id: 'auth_123' };
			},
		},
	};

	const output = await new Allowly().execute.call(context);
	const expectedUserId = 'email_hmac:v1:3ICm-xnjBrsMfGEj1mG6hCoepxjL2ZRlvmWNig2XUk0';
	assert.equal(requests[0].url, 'https://api.allowly.ai/v1/authorizations');
	assert.equal(requests[0].body.user_id, expectedUserId);
	assert.equal(output[0][0].json.userId, expectedUserId);
});

test('budget settlement passes through the response and defaults the idempotency key', async () => {
	const response = {
		check_receipt_id: 'rcp_check_123',
		authorization_id: 'auth_123',
		estimated_cost_micros: 30,
		actual_cost_micros: 25,
		delta_micros: -5,
		spent_before_micros: 30,
		spent_after_micros: 25,
		receipt: { receipt_id: 'rcp_settlement_123', status: 'pending' },
	};

	const context = settlementContext(response, ['rcp_check_123', 'rcp_check_456']);
	const output = await new Allowly().execute.call(context);

	assert.deepEqual(output[0][0].json, response);
	assert.deepEqual(context.requests[0].body, {
		check_receipt_id: 'rcp_check_123',
		actual_cost_micros: 25,
	});
	assert.deepEqual(
		context.requests.map((request) => request.headers['Idempotency-Key']),
		['execution-42:rcp_check_123', 'execution-42:rcp_check_456'],
	);
});

function resolutionContext(operation, parameters, response) {
	const requests = [];
	return {
		requests,
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({}),
		getNodeParameter: (name) => (name === 'operation' ? operation : parameters[name]),
		getExecutionId: () => 'execution-42',
		getNode: () => ({ name: operation }),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (_credentials, options) => {
				requests.push(options);
				return response;
			},
		},
	};
}

test('resolves a confirmation with an idempotency key', async () => {
	const context = resolutionContext(
		'resolveConfirmation',
		{
			confirmationNonce: 'nonce/value',
			confirmationApproved: true,
			confirmationTtlSeconds: 60,
			confirmationIdempotencyKey: 'confirm-1',
		},
		{ decision: 'approved', authorization_id: 'auth_child' },
	);

	await new Allowly().execute.call(context);
	assert.equal(context.requests[0].url, 'https://api.allowly.ai/v1/confirmations/nonce%2Fvalue');
	assert.equal(context.requests[0].headers['Idempotency-Key'], 'confirm-1');
	assert.deepEqual(context.requests[0].body, {
		approved: true,
		ttl_seconds: 60,
	});
});

test('resolves an escalation with a customer-reported actor', async () => {
	const context = resolutionContext(
		'resolveEscalation',
		{
			escalationId: 'esc/value',
			escalationResolution: 'rejected',
			escalationResolvedBy: 'ops:user_123',
			escalationNote: 'suppression match',
		},
		{ escalation_id: 'esc/value', status: 'rejected' },
	);

	await new Allowly().execute.call(context);
	assert.equal(context.requests[0].url, 'https://api.allowly.ai/v1/escalations/esc%2Fvalue/resolve');
	assert.deepEqual(context.requests[0].body, {
		resolution: 'rejected',
		resolved_by: 'ops:user_123',
		note: 'suppression match',
	});
});

for (const code of [
	'budget_settlement_duplicate',
	'budget_settlement_actual_cost_conflict',
	'check_receipt_not_found',
	'budget_settlement_receipt_without_estimate',
]) {
	test(`budget settlement surfaces ${code} verbatim`, async () => {
		await assert.rejects(
			new Allowly().execute.call(settlementContext(new Error(code))),
			(error) => error.message === code,
		);
	});
}
