const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { Allowly } = require('../dist/nodes/Allowly/Allowly.node.js');

const workflow = JSON.parse(readFileSync(join(__dirname, '../examples/stripe-refund-with-approval.json')));
const nodes = Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
const request = {
	authorizationId: 'auth_parent', refundRequestId: 'refund-case-001',
	paymentIntentId: 'pi_test123', amountMinor: 2500, currency: 'usd', reason: 'requested_by_customer',
};
const clone = structuredClone;

// Execute the exported graph and its Code/expressions, with real Allowly node execution.
// Only external services, the human response, and core node plumbing are simulated.
// Actual n8n import/schema/expression validation is a separate acceptance check.
async function run(options = {}) {
	const outputs = {};
	const requests = [];
	const refunds = options.refunds ?? new Map();
	let checks = 0;
	let current = 'Run test refund';
	let item = {};
	const executionId = options.executionId ?? 'refund-execution-1';
	function scope() {
		return {
			$json: item,
			$input: { first: () => ({ json: item }), all: () => [{ json: item }] },
			$: (name) => ({ first: () => ({ json: outputs[name] }) }),
		};
	}
	function value(input) {
		if (typeof input === 'string' && input.startsWith('={{')) {
			return vm.runInNewContext('(' + input.slice(3, -2).trim() + ')', scope());
		}
		return input;
	}
	async function allowlyRequest(_credential, call) {
		requests.push(clone(call));
		if (call.url.endsWith('/v1/check')) {
			if (options.checkError) throw new Error('Allowly unavailable');
			const decision = (options.decisions ?? ['allow'])[checks++] ?? 'allow';
			const result = {
				decision, reason: 'test_reason', receipt: { status: 'pending', receipt_id: 'rcp_test' + checks },
				...(decision === 'confirm' ? { confirm_nonce: 'nonce_demo' } : {}),
				...(decision === 'escalate' ? { escalation_id: 'esc_demo' } : {}),
			};
			return options.checkResponse ?? { results: { 'refund.create': result } };
		}
		if (options.resolveError) throw new Error('Review expired');
		if (call.url.includes('/v1/confirmations/')) return call.body.approved
			? { decision: 'approved', authorization_id: 'auth_child_do_not_use', expires_at: '2026-09-16T23:59:59Z' }
			: { decision: 'not_approved', authorization_id: null, expires_at: null };
		if (call.url.includes('/v1/escalations/')) return { status: call.body.resolution };
		throw new Error('Unexpected Allowly request: ' + call.url);
	}
	try {
		for (let steps = 0; current && steps < 40; steps++) {
			const node = nodes[current];
			let branch = 0;
			if (node.type.endsWith('.set')) item = { ...JSON.parse(node.parameters.jsonOutput), ...request, ...options.request };
			else if (node.type.endsWith('.code')) {
				const result = await vm.runInNewContext('(async () => {\n' + node.parameters.jsCode + '\n})()', scope());
				item = clone(result[0].json);
			} else if (node.type.endsWith('.if')) {
				const condition = node.parameters.conditions.conditions[0];
				assert.equal(condition.operator.type, 'boolean');
				assert.equal(condition.operator.operation, 'true');
				branch = value(condition.leftValue) === true ? 0 : 1;
			} else if (node.type === 'n8n-nodes-allowly.allowly') {
				const params = Object.fromEntries(Object.entries(node.parameters).map(([key, val]) => [key, value(val)]));
				const context = {
					getInputData: () => [{ json: item }], getCredentials: async () => ({}),
					getNodeParameter: (name) => params[name], getExecutionId: () => executionId,
					getNode: () => node, continueOnFail: () => false,
					helpers: { httpRequestWithAuthentication: allowlyRequest },
				};
				item = clone((await new Allowly().execute.call(context))[0][0].json);
			} else if (node.type.endsWith('.wait')) {
				const review = typeof options.review === 'function' ? options.review(outputs['Validate request']) : options.review;
				item = options.timeout ? item : { body: review ?? { approved: options.approved ?? true, resource: outputs['Validate request'].resource } };
			} else if (node.type.endsWith('.httpRequest')) {
				const p = node.parameters;
				const call = {
					method: p.method ?? 'GET', url: value(p.url), credential: p.nodeCredentialType,
					headers: Object.fromEntries((p.headerParameters?.parameters ?? []).map(({ name, value: val }) => [name, value(val)])),
					body: Object.fromEntries((p.bodyParameters?.parameters ?? []).map(({ name, value: val }) => [name, value(val)])),
				};
				requests.push(clone(call));
				if (call.url.includes('/payment_intents/')) {
					item = { object: 'payment_intent', id: outputs['Validate request'].paymentIntentId, livemode: false, status: 'succeeded', currency: 'usd', amount_received: 100000, ...options.payment };
				} else if (call.url === 'https://api.stripe.com/v1/refunds') {
					if (options.stripeError) throw new Error('Stripe unavailable');
					const key = call.headers['Idempotency-Key'];
					assert.ok(key);
					const previous = refunds.get(key);
					if (previous && JSON.stringify(previous.body) !== JSON.stringify(call.body)) throw new Error('Stripe idempotency parameter conflict');
					item = previous?.response ?? { object: 'refund', id: 're_test' + (refunds.size + 1), payment_intent: call.body.payment_intent, amount: call.body.amount, currency: 'usd', status: 'succeeded' };
					refunds.set(key, { body: clone(call.body), response: clone(item) });
				} else if (call.url.startsWith('https://api.allowly.ai/v1/receipts/')) {
					if (options.receiptError) throw new Error('Receipt unavailable');
					const id = outputs['Refund result'].decision.receiptId;
					item = options.receiptResponse ?? (options.signed ? { status: 'signed', receipt: { receipt_id: id, signature: 'fixture-not-a-verified-signature' } } : { status: 'pending', receipt_id: id });
				} else throw new Error('Unexpected HTTP request');
			} else if (node.type.endsWith('.stopAndError')) throw new Error(node.parameters.errorMessage);
			else assert.equal(node.type, 'n8n-nodes-base.manualTrigger');
			outputs[current] = clone(item);
			current = workflow.connections[current]?.main[branch]?.[0]?.node;
		}
		assert.equal(current, undefined, 'graph did not terminate');
		return { outputs, requests, error: null };
	} catch (error) { return { outputs, requests, error }; }
}

const refundCalls = (result) => result.requests.filter((call) => call.url === 'https://api.stripe.com/v1/refunds');
const checkCalls = (result) => result.requests.filter((call) => call.url.endsWith('/v1/check'));

test('refund template is inactive, credential-free, and requires authenticated bounded review', () => {
	assert.equal(workflow.active, false);
	assert.deepEqual(workflow.pinData, {});
	for (const node of workflow.nodes) {
		assert.equal(node.credentials, undefined);
		assert.equal(node.continueOnFail, undefined);
		assert.equal(node.disabled, undefined);
		if (node.type.endsWith('.httpRequest')) assert.equal(node.parameters.options.redirect.redirect.followRedirects, false);
	}
	assert.equal(nodes['Wait for reviewer'].parameters.incomingAuthentication, 'headerAuth');
	assert.equal(nodes['Wait for reviewer'].parameters.httpMethod, 'POST');
	assert.equal(nodes['Wait for reviewer'].parameters.limitWaitTime, true);
	assert.equal(nodes['Wait for reviewer'].parameters.resumeAmount, 4);
	assert.equal(nodes['Create Stripe test refund'].parameters.contentType, 'form-urlencoded');
});

test('allow sends exactly the checked refund fields and preserves pending receipt evidence', async () => {
	const result = await run();
	assert.equal(result.error, null);
	assert.equal(refundCalls(result).length, 1);
	assert.equal(checkCalls(result).length, 1);
	assert.equal(refundCalls(result)[0].body.amount, checkCalls(result)[0].body.context.amount_minor);
	assert.equal(refundCalls(result)[0].body.payment_intent, checkCalls(result)[0].body.context.payment_intent_id);
	const evidence = result.outputs['Export refund evidence'];
	assert.equal(evidence.receiptPending, true);
	assert.equal(evidence.receiptVerification, 'not_performed');
	assert.equal(evidence.stripeRefund.status, 'succeeded');
});

for (const decision of ['confirm', 'escalate']) {
	test(decision + ' needs explicit review and a fresh check against the original parent and snapshot', async () => {
		const result = await run({ decisions: [decision, 'allow'], signed: true });
		assert.equal(result.error, null);
		const checks = checkCalls(result);
		assert.equal(checks.length, 2);
		assert.equal(checks[1].body.authorization_id, 'auth_parent');
		assert.deepEqual(checks[1].body, checks[0].body);
		assert.notEqual(checks[1].headers['Idempotency-Key'], checks[0].headers['Idempotency-Key']);
		assert.equal(refundCalls(result).length, 1);
		assert.equal(result.outputs['Export refund evidence'].receiptPending, false);
		assert.equal(result.outputs['Export refund evidence'].receiptVerification, 'not_performed');
	});
	test(decision + ' rejection is resolved but never refunded', async () => {
		const result = await run({ decisions: [decision], approved: false });
		assert.ok(result.error);
		assert.equal(refundCalls(result).length, 0);
		assert.equal(checkCalls(result).length, 1);
		const resolution = result.requests.find((call) => /confirmations|escalations/.test(call.url));
		assert.ok(resolution);
		assert.equal(decision === 'confirm' ? resolution.body.approved : resolution.body.resolution, decision === 'confirm' ? false : 'rejected');
	});
}

for (const [name, options] of [
	['deny', { decisions: ['deny'] }],
	['unknown decision', { decisions: ['maybe'] }],
	['missing result', { checkResponse: { results: {} } }],
	['missing receipt', { checkResponse: { results: { 'refund.create': { decision: 'allow' } } } }],
	['API outage', { checkError: true }],
	['timeout', { decisions: ['confirm'], timeout: true }],
	['string approval', { decisions: ['confirm'], review: (r) => ({ approved: 'true', resource: r.resource }) }],
	['changed approved resource', { decisions: ['confirm'], review: { approved: true, resource: 'another-refund' } }],
	['unexpected review fields', { decisions: ['confirm'], review: (r) => ({ approved: true, resource: r.resource, amountMinor: 1 }) }],
	['expired review', { decisions: ['confirm'], resolveError: true }],
	['review followed by deny', { decisions: ['escalate', 'deny'] }],
	['review needs another confirmation', { decisions: ['confirm', 'confirm'] }],
	['live payment', { payment: { livemode: true } }],
	['unconfirmed payment', { payment: { status: 'requires_confirmation' } }],
	['different payment', { payment: { id: 'pi_other' } }],
	['fractional cents', { request: { amountMinor: 2.5 } }],
	['zero refund', { request: { amountMinor: 0 } }],
]) {
	test(name + ' never reaches the refund endpoint', async () => {
		const result = await run(options);
		assert.ok(result.error, name);
		assert.equal(refundCalls(result).length, 0, name);
	});
}

test('each changed executable field changes the approval resource', async () => {
	const original = await run();
	for (const changed of [{ amountMinor: 2501 }, { paymentIntentId: 'pi_another' }, { refundRequestId: 'refund-case-002' }]) {
		const result = await run({ request: changed });
		assert.notEqual(checkCalls(result)[0].body.resource, checkCalls(original)[0].body.resource);
	}
	for (const changed of [{ currency: 'eur' }, { reason: 'duplicate' }]) {
		const result = await run({ request: changed });
		assert.ok(result.error);
		assert.equal(refundCalls(result).length, 0);
	}
});

test('retries across executions retain Stripe key and body; changing amount conflicts', async () => {
	const refunds = new Map();
	const first = await run({ refunds });
	const retry = await run({ refunds, executionId: 'refund-execution-2' });
	assert.equal(retry.error, null);
	assert.deepEqual(refundCalls(first)[0], refundCalls(retry)[0]);
	assert.notEqual(checkCalls(first)[0].headers['Idempotency-Key'], checkCalls(retry)[0].headers['Idempotency-Key']);
	assert.equal(refunds.size, 1);
	const changed = await run({ refunds, request: { amountMinor: 2501 } });
	assert.match(changed.error.message, /idempotency parameter conflict/);
	assert.equal(refunds.size, 1);
});

test('a Stripe failure cannot produce success evidence', async () => {
	const result = await run({ stripeError: true });
	assert.ok(result.error);
	assert.equal(result.outputs['Refund result'], undefined);
});

test('receipt failure preserves the refund result for recovery without another refund', async () => {
	const result = await run({ receiptError: true });
	assert.ok(result.error);
	assert.equal(refundCalls(result).length, 1);
	assert.equal(result.outputs['Refund result'].stripeRefund.id, 're_test1');
	assert.equal(result.outputs['Refund result'].decision.receiptId, 'rcp_test1');
	assert.equal(result.outputs['Export refund evidence'], undefined);
});

test('receipt response must belong to this decision', async () => {
	const result = await run({ receiptResponse: { status: 'signed', receipt: { receipt_id: 'rcp_other', signature: 'wrong' } } });
	assert.ok(result.error);
	assert.equal(result.outputs['Export refund evidence'], undefined);
});
