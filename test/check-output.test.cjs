const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { AllowlyApi } = require('../dist/credentials/AllowlyApi.credentials.js');
const {
	Allowly,
	mostRestrictiveResult,
	n8nIdempotencyKey,
	parseContext,
	parseEstimatedCostMicros,
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
