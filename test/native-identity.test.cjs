const assert = require('node:assert/strict');
const test = require('node:test');
const { generateKeyPairSync, verify } = require('node:crypto');
const { Allowly } = require('../dist/nodes/Allowly/Allowly.node.js');
const { nativeAgentToken } = require('../dist/nodes/Allowly/native-identity.js');
const { hashSealValue } = require('../dist/nodes/Allowly/seal-verifier.js');

function nativeFixture(overrides = {}) {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	const credential = {
		version: 1,
		provider: 'allowly',
		workspace_id: 'ws_native_test',
		agent_id: 'agent_native_test',
		binding_id: 'aib_native_test',
		key_id: 'ack_native_test',
		private_key_jwk: privateKey.export({ format: 'jwk' }),
		...overrides,
	};
	return { credential, json: JSON.stringify(credential), publicKey };
}

// Use Node's verifier directly, independently from the helper that signs the JWT.
function verifyNativeToken(token, fixture, now) {
	assert.equal(typeof token, 'string');
	const parts = token.split('.');
	assert.equal(parts.length, 3);
	for (const part of parts) {
		assert.match(part, /^[A-Za-z0-9_-]+$/);
		assert.equal(Buffer.from(part, 'base64url').toString('base64url'), part);
	}
	assert.deepEqual(JSON.parse(Buffer.from(parts[0], 'base64url')), {
		alg: 'EdDSA', typ: 'JWT', kid: fixture.credential.key_id,
	});
	const payload = JSON.parse(Buffer.from(parts[1], 'base64url'));
	assert.deepEqual(payload, {
		iss: 'allowly-agent',
		aud: fixture.credential.workspace_id,
		sub: fixture.credential.agent_id,
		bid: fixture.credential.binding_id,
		iat: now,
		nbf: now,
		exp: now + 60,
	});
	assert.equal(verify(null, Buffer.from(parts.slice(0, 2).join('.')), fixture.publicKey,
		Buffer.from(parts[2], 'base64url')), true);
	return payload;
}

const checkParameters = {
	operation: 'check',
	authorization: 'auth_native_test',
	actions: 'refund.create',
	resource: 'refund:test',
	session: '',
	estimatedCostMicros: -1,
	workflowUser: '',
	workflowAgent: '',
	contextJson: { amount_minor: 2500 },
	clientTimestamp: '2026-10-01T10:00:00Z',
};

function nativeContext(options = {}) {
	const fixture = options.fixture ?? nativeFixture();
	const parameters = { ...checkParameters, ...options.parameters };
	const requests = [];
	const tokenRequests = [];
	const context = {
		fixture,
		requests,
		tokenRequests,
		getInputData: () => Array.from({ length: options.itemCount ?? 1 }, () => ({ json: {} })),
		getCredentials: async () => ({
			apiKey: 'runtime-secret-native-test',
			identityMode: 'allowlyNative',
			nativeAgentCredential: fixture.json,
			...options.credentials,
		}),
		getNodeParameter: (name) => parameters[name],
		getExecutionId: () => 'native-execution-test',
		getNode: () => ({ name: 'Allowly native test' }),
		continueOnFail: () => options.continueOnFail ?? false,
		helpers: {
			httpRequest: async (request) => {
				tokenRequests.push(request);
				throw new Error('Native identity must not fetch a token over HTTP');
			},
			httpRequestWithAuthentication: async (credentialName, request) => {
				assert.equal(credentialName, 'allowlyApi');
				requests.push(request);
				if (options.requestHandler) return options.requestHandler(request, requests.length);
				return options.response ?? { results: { 'refund.create': { decision: 'allow' } } };
			},
		},
	};
	return context;
}

test('native identity signs the exact short-lived claims with its Ed25519 private key', () => {
	const fixture = nativeFixture();
	const now = 1_790_852_400;
	const token = nativeAgentToken(fixture.json, now);
	verifyNativeToken(token, fixture, now);
	const otherPublicKey = generateKeyPairSync('ed25519').publicKey;
	const [header, payload, signature] = token.split('.');
	assert.equal(verify(null, Buffer.from(`${header}.${payload}`), otherPublicKey,
		Buffer.from(signature, 'base64url')), false);
});

test('native identity does not sign key or credential material into the JWT', () => {
	const fixture = nativeFixture();
	const token = nativeAgentToken(fixture.json, 1234567890);
	const decoded = token.split('.').slice(0, 2).map((part) => Buffer.from(part, 'base64url').toString()).join(' ');
	for (const secret of [fixture.json, fixture.credential.private_key_jwk.d, 'private_key_jwk']) {
		assert.equal(decoded.includes(secret), false);
	}
});

function invalidCredentials() {
	const fixture = nativeFixture();
	const json = (overrides) => JSON.stringify({ ...fixture.credential, ...overrides });
	const invalid = [
		['missing credential', undefined],
		['empty credential', ''],
		['whitespace credential', '  '],
		['invalid JSON', '{"secret":"malformed-private-secret"'],
		['object instead of CLI JSON text', fixture.credential],
		['JSON null', 'null'],
		['JSON array', '[]'],
		['JSON string', '"private-secret"'],
		['pending CLI credential', JSON.stringify({ version: 1, provider: 'allowly', status: 'pending',
			workspace_id: fixture.credential.workspace_id, agent_id: fixture.credential.agent_id,
			private_key_jwk: fixture.credential.private_key_jwk })],
		['wrong version', json({ version: 2 })],
		['string version', json({ version: '1' })],
		['wrong provider', json({ provider: 'auth0' })],
		['missing private JWK', json({ private_key_jwk: undefined })],
		['non-object private JWK', json({ private_key_jwk: 'private-secret' })],
	];
	for (const field of ['workspace_id', 'agent_id', 'binding_id', 'key_id']) {
		invalid.push([`missing ${field}`, json({ [field]: undefined })]);
		invalid.push([`blank ${field}`, json({ [field]: ' \t ' })]);
		invalid.push([`non-string ${field}`, json({ [field]: 42 })]);
	}
	const jwk = (overrides) => json({ private_key_jwk: { ...fixture.credential.private_key_jwk, ...overrides } });
	invalid.push(
		['wrong key type', jwk({ kty: 'EC' })],
		['wrong curve', jwk({ crv: 'X25519' })],
		['missing public key', jwk({ x: undefined })],
		['missing private key', jwk({ d: undefined })],
		['short public key', jwk({ x: Buffer.alloc(31).toString('base64url') })],
		['long private key', jwk({ d: Buffer.alloc(33).toString('base64url') })],
		['padded public key', jwk({ x: fixture.credential.private_key_jwk.x + '=' })],
		['invalid private key alphabet', jwk({ d: '+'.repeat(43) })],
		['public/private mismatch', jwk({ x: nativeFixture().credential.private_key_jwk.x })],
	);
	return invalid;
}

for (const [name, value] of invalidCredentials()) {
	test(`native identity rejects ${name} with a safe credential error`, () => {
		assert.throws(() => nativeAgentToken(value, 1234567890), (error) => {
			assert.equal(error instanceof Error, true);
			assert.equal(error.message,
				'Allowly Identity Credential must contain the completed JSON file from allowly agent enroll.');
			assert.equal(error.message.includes('malformed-private-secret'), false);
			assert.equal(error.message.includes('private-secret'), false);
			if (typeof value === 'string' && value.length > 10) assert.equal(error.message.includes(value), false);
			return true;
		});
	});
}

for (const operation of ['check', 'checkAndEnforce']) {
	test(`${operation} sends a native token only in the header and disables redirects`, async () => {
		const context = nativeContext({ parameters: { operation } });
		const before = Math.floor(Date.now() / 1000);
		const [items] = await new Allowly().execute.call(context);
		assert.equal(context.requests.length, 1);
		assert.equal(context.tokenRequests.length, 0);
		const request = context.requests[0];
		assert.equal(request.url, 'https://api.allowly.ai/v1/check');
		assert.equal(request.method, 'POST');
		assert.equal(request.disableFollowRedirect, true);
		assert.equal(request.sendCredentialsOnCrossOriginRedirect, false);
		const token = request.headers['X-Allowly-Agent-Token'];
		const issuedAt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).iat;
		assert.ok(issuedAt >= before && issuedAt <= Math.floor(Date.now() / 1000));
		verifyNativeToken(token, context.fixture, issuedAt);
		assert.deepEqual(request.body, {
			authorization_id: 'auth_native_test', actions: ['refund.create'], resource: 'refund:test',
			context: { amount_minor: 2500 }, client_timestamp: '2026-10-01T10:00:00Z',
		});
		assert.equal(items[0].json.protectedActionAllowed, true);
		const requestOutsideToken = { ...request, headers: { ...request.headers } };
		delete requestOutsideToken.headers['X-Allowly-Agent-Token'];
		for (const secret of [token, context.fixture.json, context.fixture.credential.private_key_jwk.d,
			'runtime-secret-native-test']) {
			assert.equal(JSON.stringify(requestOutsideToken).includes(secret), false);
			assert.equal(JSON.stringify(items).includes(secret), false);
		}
	});
}

test('native Acknowledge Receipt verifies identity and binds the exact receipt hash', async () => {
	const receipt = { receipt_id: 'rcp_native_test', issued_at: '2026-10-01T10:00:00Z', signature: 'signed' };
	const context = nativeContext({
		parameters: { operation: 'acknowledgeReceipt', ackReceipt: receipt,
			ackClientTimestamp: '2026-10-01T10:00:03.456Z', ackIdempotencyKey: 'ack-native-test' },
		response: { status: 'succeeded' },
	});
	const [items] = await new Allowly().execute.call(context);
	const request = context.requests[0];
	assert.equal(context.requests.length, 1);
	assert.equal(context.tokenRequests.length, 0);
	assert.equal(request.url, 'https://api.allowly.ai/v1/receipts/rcp_native_test/acknowledgments');
	assert.equal(request.headers['Idempotency-Key'], 'ack-native-test');
	assert.deepEqual(request.body, {
		receipt_sha256: hashSealValue(receipt), client_timestamp: '2026-10-01T10:00:03.456Z',
	});
	assert.equal(request.disableFollowRedirect, true);
	assert.equal(request.sendCredentialsOnCrossOriginRedirect, false);
	const token = request.headers['X-Allowly-Agent-Token'];
	const issuedAt = JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).iat;
	verifyNativeToken(token, context.fixture, issuedAt);
	assert.equal(JSON.stringify(items).includes(token), false);
	assert.equal(JSON.stringify(items).includes(context.fixture.credential.private_key_jwk.d), false);
});

test('each protected native request gets a fresh token after the clock advances', async (t) => {
	let nowMs = 1_790_852_400_000;
	t.mock.method(Date, 'now', () => nowMs);
	const context = nativeContext({ itemCount: 2, requestHandler: () => {
		nowMs += 70_000;
		return { results: { 'refund.create': { decision: 'allow' } } };
	} });
	await new Allowly().execute.call(context);
	assert.equal(context.requests.length, 2);
	const first = context.requests[0].headers['X-Allowly-Agent-Token'];
	const second = context.requests[1].headers['X-Allowly-Agent-Token'];
	const firstPayload = verifyNativeToken(first, context.fixture, 1_790_852_400);
	const secondPayload = verifyNativeToken(second, context.fixture, 1_790_852_470);
	assert.ok(firstPayload.exp < secondPayload.iat);
	assert.notEqual(first, second);
	assert.equal(context.tokenRequests.length, 0);
});

const invalidBeforeHttp = new Set(['missing credential', 'invalid JSON', 'pending CLI credential',
	'missing workspace_id', 'wrong provider', 'wrong key type', 'public/private mismatch']);
for (const [name, credential] of invalidCredentials().filter(([name]) => invalidBeforeHttp.has(name))) {
	test(`Check rejects ${name} before any HTTP request`, async () => {
		const context = nativeContext({ credentials: { nativeAgentCredential: credential } });
		await assert.rejects(() => new Allowly().execute.call(context), /Allowly Identity Credential/);
		assert.equal(context.requests.length, 0);
		assert.equal(context.tokenRequests.length, 0);
	});
}

for (const operation of ['checkAndEnforce', 'acknowledgeReceipt']) {
	test(`${operation} rejects a missing credential before HTTP`, async () => {
		const context = nativeContext({ parameters: { operation }, continueOnFail: operation === 'checkAndEnforce',
			credentials: { nativeAgentCredential: '' } });
		await assert.rejects(() => new Allowly().execute.call(context), /Allowly Identity Credential/);
		assert.equal(context.requests.length, 0);
		assert.equal(context.tokenRequests.length, 0);
	});
}

test('a missing native credential fails closed when Check continues on failure', async () => {
	const context = nativeContext({ credentials: { nativeAgentCredential: '' }, continueOnFail: true });
	const [items] = await new Allowly().execute.call(context);
	assert.equal(items[0].json.protectedActionAllowed, false);
	assert.match(items[0].json.error, /Allowly Identity Credential/);
	assert.equal(context.requests.length, 0);
});

test('native Acknowledge Receipt fails closed on an API identity rejection', async () => {
	const context = nativeContext({
		parameters: { operation: 'acknowledgeReceipt',
			ackReceipt: { receipt_id: 'rcp_native_test', issued_at: '2026-10-01T10:00:00Z', signature: 'signed' },
			ackClientTimestamp: '2026-10-01T10:00:03Z', ackIdempotencyKey: 'ack-native-test' },
		continueOnFail: true,
		requestHandler: () => {
			const error = new Error('Native identity rejected: revoked_identity');
			error.httpCode = '401';
			throw error;
		},
	});
	const [items] = await new Allowly().execute.call(context);
	assert.equal(items[0].json.protectedActionAllowed, false);
	assert.match(items[0].json.error, /revoked_identity/);
	assert.equal(context.requests.length, 1);
	assert.equal(context.tokenRequests.length, 0);
});

test('an unknown identity mode cannot fall back to API-key-only checks', async () => {
	const context = nativeContext({ credentials: { identityMode: 'allowlyNativ' }, continueOnFail: true });
	const [items] = await new Allowly().execute.call(context);
	assert.equal(items[0].json.protectedActionAllowed, false);
	assert.equal(context.requests.length, 0);
	assert.equal(context.tokenRequests.length, 0);
});

for (const reason of ['wrong_workspace', 'wrong_agent', 'wrong_binding', 'revoked_identity', 'expired_identity']) {
	test(`native identity ${reason} rejection never retries without identity or permits the action`, async () => {
		for (const operation of ['check', 'checkAndEnforce']) {
			const context = nativeContext({ parameters: { operation }, continueOnFail: true,
				requestHandler: () => {
					const error = new Error(`Native identity rejected: ${reason}`);
					error.httpCode = '401';
					throw error;
				} });
			if (operation === 'checkAndEnforce') {
				await assert.rejects(() => new Allowly().execute.call(context), new RegExp(reason));
			} else {
				const [items] = await new Allowly().execute.call(context);
				assert.equal(items[0].json.protectedActionAllowed, false);
				assert.match(items[0].json.error, new RegExp(reason));
			}
			assert.equal(context.requests.length, 1);
			assert.equal(typeof context.requests[0].headers['X-Allowly-Agent-Token'], 'string');
			assert.equal(context.tokenRequests.length, 0);
		}
	});
}

test('native request errors redact the whole credential, its private key, issued token, and API key', async () => {
	for (const continueOnFail of [false, true]) {
		const fixture = nativeFixture();
		const context = nativeContext({ fixture, continueOnFail, requestHandler: (request) => {
			throw new Error(['Rejected', fixture.json, JSON.stringify(fixture.credential.private_key_jwk),
				fixture.credential.private_key_jwk.d, request.headers['X-Allowly-Agent-Token'],
				'runtime-secret-native-test'].join(' '));
		} });
		const checkRendered = (rendered) => {
			for (const secret of [fixture.json, JSON.stringify(fixture.credential.private_key_jwk),
				fixture.credential.private_key_jwk.d, context.requests[0].headers['X-Allowly-Agent-Token'],
				'runtime-secret-native-test']) assert.equal(rendered.includes(secret), false);
			assert.match(rendered, /REDACTED/);
		};
		if (continueOnFail) {
			const [items] = await new Allowly().execute.call(context);
			assert.equal(items[0].json.protectedActionAllowed, false);
			checkRendered(JSON.stringify(items));
		} else {
			await assert.rejects(() => new Allowly().execute.call(context), (error) => {
				checkRendered(String(error));
				return true;
			});
		}
	}
});

for (const parameters of [
	{ operation: 'resolveConfirmation', confirmationNonce: 'nonce_test', confirmationApproved: true,
		confirmationTtlSeconds: 60, confirmationIdempotencyKey: '' },
	{ operation: 'resolveEscalation', escalationId: 'esc_test', escalationResolution: 'approved',
		escalationResolvedBy: 'reviewer_test', escalationNote: '' },
]) {
	test(`${parameters.operation} does not sign or send native identity`, async () => {
		const context = nativeContext({ parameters, credentials: { nativeAgentCredential: 'invalid credential' },
			response: { status: 'approved' } });
		await new Allowly().execute.call(context);
		assert.equal(context.requests.length, 1);
		assert.equal(context.requests[0].headers['X-Allowly-Agent-Token'], undefined);
		assert.equal(context.tokenRequests.length, 0);
	});
}

test('Seal does not sign or send native identity when it records a digest', async () => {
	const context = nativeContext({
		parameters: { operation: 'seal', sealRecordInputMode: 'value', sealRecordValue: { record: 'test' },
			sealRequestId: '', sealMetadata: {} },
		credentials: { nativeAgentCredential: 'invalid credential' }, response: { decision: 'deny' },
	});
	await assert.rejects(() => new Allowly().execute.call(context), /invalid seal response/);
	assert.equal(context.requests.length, 1);
	assert.equal(context.requests[0].url, 'https://api.allowly.ai/v1/seal');
	assert.equal(context.requests[0].headers['X-Allowly-Agent-Token'], undefined);
	assert.equal(context.tokenRequests.length, 0);
});
