const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { Allowly } = require('../dist/nodes/Allowly/Allowly.node.js');

const workflowText = readFileSync(join(__dirname, '../examples/stripe-refund-with-jev.json'), 'utf8');
const workflow = JSON.parse(workflowText);
const nodes = Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
const clone = structuredClone;

const request = {
	authorizationId: 'auth_parent',
	refundRequestId: 'refund-jev-001',
	paymentIntentId: 'pi_test123',
	amountMinor: 2500,
	currency: 'usd',
	reason: 'requested_by_customer',
	customerMessageId: 'message-001',
	customerMessage: 'I was charged twice for September. Please refund the duplicate charge.',
	jevMode: 'mock',
};

function liveJevDecision(overrides = {}) {
	const decision = {
		model: 'typesafe/jev-1.13-20260923',
		provider: 'TypeSafe',
		id: 'gen-dec-demo12345',
		answers: {
			refund_requested: { type: 'noul', noul: 0.99 },
			refund_reason: {
				type: 'choice',
				choice: 'duplicate_charge',
				confidence: 0.98,
				probabilities: {
					duplicate_charge: 0.95,
					defective_or_damaged: 0.01,
					not_received: 0.01,
					changed_mind: 0.01,
					unauthorized: 0.01,
					other_or_unclear: 0.01,
				},
			},
		},
		usage: { input_tokens: 18, output_tokens: 9, cost: 0.000012 },
	};
	return { ...decision, ...overrides };
}

function unclearJevDecision(refundRequested = 0.99) {
	return liveJevDecision({
		answers: {
			refund_requested: { type: 'noul', noul: refundRequested },
			refund_reason: {
				type: 'choice',
				choice: 'other_or_unclear',
				confidence: 1,
				probabilities: {
					duplicate_charge: 0,
					defective_or_damaged: 0,
					not_received: 0,
					changed_mind: 0,
					unauthorized: 0,
					other_or_unclear: 1,
				},
			},
		},
	});
}

async function run(options = {}) {
	const outputs = {};
	const requests = [];
	let checks = 0;
	let current = 'Run test refund';
	let item = {};
	const executionId = options.executionId ?? 'jev-refund-execution-1';

	function scope() {
		return {
			$json: item,
			$input: { first: () => ({ json: item }), all: () => [{ json: item }] },
			$: (name) => ({ first: () => ({ json: outputs[name] }) }),
		};
	}

	function value(input) {
		if (typeof input === 'string' && input.startsWith('={{')) {
			return vm.runInNewContext(`(${input.slice(3, -2).trim()})`, scope());
		}
		return input;
	}

	async function allowlyRequest(_credential, call) {
		requests.push({ node: current, ...clone(call) });
		if (call.url.endsWith('/v1/check')) {
			const decision = (options.decisions ?? ['allow'])[checks++] ?? 'allow';
			const result = {
				decision,
				reason: 'test_reason',
				receipt: { status: 'pending', receipt_id: `rcp_test${checks}` },
				...(decision === 'confirm' ? { confirm_nonce: 'nonce_demo' } : {}),
				...(decision === 'escalate' ? { escalation_id: 'esc_demo' } : {}),
			};
			return { results: { 'refund.create': result } };
		}
		if (call.url.includes('/v1/confirmations/')) {
			return call.body.approved
				? { decision: 'approved', authorization_id: 'auth_child_do_not_use', expires_at: '2026-09-23T23:59:59Z' }
				: { decision: 'not_approved', authorization_id: null, expires_at: null };
		}
		if (call.url.includes('/v1/escalations/')) return { status: call.body.resolution };
		throw new Error(`Unexpected Allowly request: ${call.url}`);
	}

	try {
		for (let steps = 0; current && steps < 50; steps++) {
			const node = nodes[current];
			assert.ok(node, `missing node: ${current}`);
			let branch = 0;
			if (node.type.endsWith('.set')) {
				item = { ...JSON.parse(node.parameters.jsonOutput), ...request, ...options.request };
			} else if (node.type.endsWith('.code')) {
				const result = await vm.runInNewContext(`(async () => {\n${node.parameters.jsCode}\n})()`, scope());
				item = clone(result[0].json);
			} else if (node.type.endsWith('.if')) {
				const condition = node.parameters.conditions.conditions[0];
				assert.equal(condition.operator.type, 'boolean');
				assert.equal(condition.operator.operation, 'true');
				branch = value(condition.leftValue) === true ? 0 : 1;
			} else if (node.type === 'n8n-nodes-allowly.allowly') {
				const params = Object.fromEntries(
					Object.entries(node.parameters).map(([key, parameter]) => [key, value(parameter)]),
				);
				const context = {
					getInputData: () => [{ json: item }],
					getCredentials: async () => ({}),
					getNodeParameter: (name) => params[name],
					getExecutionId: () => executionId,
					getNode: () => node,
					continueOnFail: () => false,
					helpers: { httpRequestWithAuthentication: allowlyRequest },
				};
				item = clone((await new Allowly().execute.call(context))[0][0].json);
			} else if (node.type.endsWith('.wait')) {
				item = {
					body: options.review ?? {
						approved: true,
						resource: outputs['Freeze Jev decision'].resource,
					},
				};
			} else if (node.type.endsWith('.httpRequest')) {
				const parameters = node.parameters;
				const rawBody = parameters.jsonBody === undefined ? undefined : value(parameters.jsonBody);
				const call = {
					node: current,
					method: parameters.method ?? 'GET',
					url: value(parameters.url),
					authentication: parameters.authentication,
					credential: parameters.nodeCredentialType ?? parameters.genericAuthType,
					headers: Object.fromEntries(
						(parameters.headerParameters?.parameters ?? []).map(({ name, value: headerValue }) => [name, value(headerValue)]),
					),
					body: rawBody === undefined
						? Object.fromEntries(
							(parameters.bodyParameters?.parameters ?? []).map(({ name, value: bodyValue }) => [name, value(bodyValue)]),
						)
						: JSON.parse(rawBody),
				};
				requests.push(clone(call));
				if (call.url === 'https://openrouter.ai/api/alpha/decisions') {
					item = clone(options.jevResponse ?? liveJevDecision());
				} else if (call.url.includes('/payment_intents/')) {
					item = {
						object: 'payment_intent',
						id: outputs['Validate request'].paymentIntentId,
						livemode: false,
						status: 'succeeded',
						currency: 'usd',
						amount_received: 100000,
					};
				} else if (call.url === 'https://api.stripe.com/v1/refunds') {
					item = {
						object: 'refund',
						id: 're_test1',
						payment_intent: call.body.payment_intent,
						amount: call.body.amount,
						currency: 'usd',
						status: 'succeeded',
					};
				} else if (call.url.startsWith('https://api.allowly.ai/v1/receipts/')) {
					item = { status: 'pending', receipt_id: outputs['Refund result'].decision.receiptId };
				} else {
					throw new Error(`Unexpected HTTP request: ${call.url}`);
				}
			} else if (node.type.endsWith('.stopAndError')) {
				throw new Error(node.parameters.errorMessage);
			} else {
				assert.equal(node.type, 'n8n-nodes-base.manualTrigger');
			}
			outputs[current] = clone(item);
			current = workflow.connections[current]?.main[branch]?.[0]?.node;
		}
		assert.equal(current, undefined, 'graph did not terminate');
		return { outputs, requests, error: null };
	} catch (error) {
		return { outputs, requests, error };
	}
}

const openRouterCalls = (result) => result.requests.filter((call) => call.url === 'https://openrouter.ai/api/alpha/decisions');
const checkCalls = (result) => result.requests.filter((call) => call.url?.endsWith('/v1/check'));
const refundCalls = (result) => result.requests.filter((call) => call.url === 'https://api.stripe.com/v1/refunds');
const escalationCalls = (result) => result.requests.filter((call) => call.url?.includes('/v1/escalations/'));

test('public Jev workflow is inactive, credential-free, and contains no OpenRouter key', () => {
	assert.equal(workflow.name, 'Route Stripe refunds with Jev decisions and Allowly guardrails');
	assert.equal(workflow.active, false);
	assert.deepEqual(workflow.pinData, {});
	assert.equal(workflow.settings.executionOrder, 'v1');
	assert.equal(workflow.nodes.some((node) => node.type === 'n8n-nodes-base.stickyNote'), false);
	assert.equal(new Set(workflow.nodes.map((node) => node.name)).size, workflow.nodes.length);
	assert.equal(new Set(workflow.nodes.map((node) => node.id)).size, workflow.nodes.length);
	for (const node of workflow.nodes) {
		assert.equal(node.credentials, undefined, `${node.name}: no exported credential binding`);
		assert.equal(node.webhookId, undefined, `${node.name}: no hosted webhook binding`);
		assert.equal(node.continueOnFail, undefined, `${node.name}: errors stop`);
		assert.equal(node.onError, undefined, `${node.name}: no error bypass`);
		if (node.type.endsWith('.httpRequest')) {
			assert.equal(node.parameters.options.redirect.redirect.followRedirects, false, `${node.name}: redirects disabled`);
		}
	}
	assert.doesNotMatch(workflowText, /sk-or-v1-[A-Za-z0-9_-]{16,}/);
	assert.doesNotMatch(workflowText, /Bearer\s+(?!YOUR_KEY\b)[A-Za-z0-9._-]{20,}/);

	const openRouter = nodes['Call OpenRouter Jev'];
	assert.equal(openRouter.parameters.authentication, 'predefinedCredentialType');
	assert.equal(openRouter.parameters.nodeCredentialType, 'openRouterApi');
	const headers = Object.fromEntries(openRouter.parameters.headerParameters.parameters.map(({ name, value }) => [name, value]));
	assert.deepEqual(headers, { 'Content-Type': 'application/json', Accept: 'application/json' });
	assert.equal(Object.hasOwn(headers, 'Authorization'), false);
});

test('mock mode makes no OpenRouter call and refunds only after an Allowly allow', async () => {
	const result = await run();
	assert.equal(result.error, null);
	assert.equal(openRouterCalls(result).length, 0);
	assert.equal(checkCalls(result).length, 1);
	assert.equal(refundCalls(result).length, 1);

	const frozen = result.outputs['Freeze Jev decision'];
	assert.equal(frozen.jev.decisionSource, 'mock_fixture');
	assert.equal(frozen.jev.triageRoute, 'ready_for_allowly');
	for (const name of ['refundRequestedPpm', 'refundReasonConfidencePpm', 'refundReasonProbabilityPpm']) {
		assert.equal(Number.isSafeInteger(frozen.jev[name]), true, name);
	}
	assert.equal(Object.hasOwn(frozen, 'customerMessage'), false);
	const context = checkCalls(result)[0].body.context;
	assert.deepEqual(Object.keys(context).sort(), [
		'amount_minor',
		'currency',
		'customer_message_id',
		'jev_generation_id',
		'jev_model',
		'jev_provider',
		'payment_intent_id',
		'reason',
		'refund_reason',
		'refund_reason_confidence_ppm',
		'refund_reason_probability_ppm',
		'refund_request_id',
		'refund_requested_ppm',
		'triage_route',
		'triage_source',
	]);
	assert.equal(JSON.stringify(context).includes(request.customerMessage), false);
	assert.equal(JSON.stringify(context).includes('probabilities'), false);
	assert.equal(JSON.stringify(context).includes('inputTokens'), false);
	assert.equal(JSON.stringify(context).includes('costMicrousd'), false);
	assert.equal(refundCalls(result)[0].body.amount, frozen.amountMinor);
	assert.equal(refundCalls(result)[0].body.payment_intent, frozen.paymentIntentId);
});

test('live mode sends the fixed Jev contract once and normalizes its result before Allowly', async () => {
	const result = await run({ request: { jevMode: 'live' }, jevResponse: liveJevDecision() });
	assert.equal(result.error, null);
	assert.equal(openRouterCalls(result).length, 1);
	assert.equal(checkCalls(result).length, 1);
	assert.equal(refundCalls(result).length, 1);

	const call = openRouterCalls(result)[0];
	assert.equal(call.method, 'POST');
	assert.equal(call.authentication, 'predefinedCredentialType');
	assert.equal(call.credential, 'openRouterApi');
	assert.deepEqual(call.headers, { 'Content-Type': 'application/json', Accept: 'application/json' });
	assert.deepEqual(Object.keys(call.body).sort(), ['model', 'questions', 'state']);
	assert.equal(call.body.model, 'typesafe/jev-1.13');
	assert.deepEqual(clone(call.body.state), { customer_message: request.customerMessage });
	assert.deepEqual(Object.keys(call.body.questions).sort(), ['refund_reason', 'refund_requested']);
	assert.equal(call.body.questions.refund_requested.type, 'noul');
	assert.equal(call.body.questions.refund_reason.type, 'choice');
	assert.deepEqual(Object.keys(call.body.questions.refund_reason.criteria).sort(), [
		'changed_mind',
		'defective_or_damaged',
		'duplicate_charge',
		'not_received',
		'other_or_unclear',
		'unauthorized',
	]);

	const frozen = result.outputs['Freeze Jev decision'];
	assert.equal(frozen.jev.decisionSource, 'openrouter_live');
	assert.equal(frozen.jev.refundRequestedPpm, 990000);
	assert.equal(frozen.jev.refundReasonProbabilityPpm, 950000);
	assert.equal(frozen.jev.refundReasonConfidencePpm, 980000);
	assert.equal(frozen.context.refund_requested_ppm, frozen.jev.refundRequestedPpm);
	assert.equal(JSON.stringify(checkCalls(result)[0].body).includes(request.customerMessage), false);
});

test('Allowly receives only receipt-safe selected Jev facts', async () => {
	const result = await run();
	assert.equal(result.error, null);
	const context = checkCalls(result)[0].body.context;
	assert.deepEqual(Object.keys(context).sort(), [
		'amount_minor',
		'currency',
		'customer_message_id',
		'jev_generation_id',
		'jev_model',
		'jev_provider',
		'payment_intent_id',
		'reason',
		'refund_reason',
		'refund_reason_confidence_ppm',
		'refund_reason_probability_ppm',
		'refund_request_id',
		'refund_requested_ppm',
		'triage_route',
		'triage_source',
	]);
	assert.equal(JSON.stringify(context).includes(request.customerMessage), false);
	assert.equal(Object.hasOwn(context, 'refund_reason_probabilities_ppm'), false);
	assert.equal(Object.hasOwn(context, 'usage'), false);
	for (const value of Object.values(context)) {
		if (typeof value === 'number') assert.equal(Number.isSafeInteger(value), true);
	}
});

test('a malformed Jev probability map fails before Allowly and Stripe', async () => {
	const malformed = liveJevDecision();
	delete malformed.answers.refund_reason.probabilities.other_or_unclear;
	const result = await run({ request: { jevMode: 'live' }, jevResponse: malformed });
	assert.match(result.error?.message ?? '', /one probability for every refund reason/);
	assert.equal(checkCalls(result).length, 0);
	assert.equal(refundCalls(result).length, 0);
});

test('a clear non-request reaches Allowly and cannot reach Stripe on deny', async () => {
	const customerMessage = 'Please explain the September charge. I am not asking for a refund or reversal.';
	const result = await run({
		request: { jevMode: 'live', customerMessage },
		jevResponse: unclearJevDecision(0.03),
		decisions: ['deny'],
	});
	assert.ok(result.error);
	assert.equal(openRouterCalls(result).length, 1);
	assert.equal(checkCalls(result).length, 1);
	assert.equal(refundCalls(result).length, 0);
	assert.equal(result.outputs['Freeze Jev decision'].jev.triageRoute, 'not_requested');
	assert.equal(checkCalls(result)[0].body.context.refund_requested_ppm, 30000);
	assert.equal(JSON.stringify(checkCalls(result)[0].body).includes(customerMessage), false);
});

test('an ambiguous $600 request escalates and rechecks the unchanged snapshot before Stripe', async () => {
	const customerMessage = 'Please refund this payment. It may be a duplicate charge, or it may be an unauthorized purchase; I cannot tell which.';
	const result = await run({
		request: { jevMode: 'live', amountMinor: 60000, customerMessage },
		jevResponse: unclearJevDecision(),
		decisions: ['escalate', 'allow'],
	});
	assert.equal(result.error, null);
	assert.equal(openRouterCalls(result).length, 1);
	assert.equal(result.outputs['Freeze Jev decision'].jev.triageRoute, 'manual_review');
	const checks = checkCalls(result);
	assert.equal(checks.length, 2);
	assert.equal(checks[0].body.context.amount_minor, 60000);
	assert.equal(checks[0].body.context.refund_reason, 'other_or_unclear');
	assert.deepEqual(checks[1].body, checks[0].body);
	assert.equal(JSON.stringify(checks[0].body).includes(customerMessage), false);
	assert.equal(escalationCalls(result).length, 1);
	assert.deepEqual(escalationCalls(result)[0].body, {
		resolution: 'approved',
		resolved_by: 'n8n-refund-review-demo',
		note: 'Customer-reported outcome from the authenticated demo review endpoint.',
	});
	assert.equal(refundCalls(result).length, 1);
});

test('review recheck reuses the exact frozen Allowly snapshot', async () => {
	const result = await run({ decisions: ['confirm', 'allow'] });
	assert.equal(result.error, null);
	const checks = checkCalls(result);
	assert.equal(checks.length, 2);
	assert.deepEqual(checks[1].body, checks[0].body);
	assert.notEqual(checks[1].headers['Idempotency-Key'], checks[0].headers['Idempotency-Key']);
	assert.deepEqual(checks[0].body.context, result.outputs['Freeze Jev decision'].context);
	assert.equal(refundCalls(result).length, 1);
});
