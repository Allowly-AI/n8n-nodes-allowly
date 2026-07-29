const assert = require('node:assert/strict');
const test = require('node:test');
const {
	Allowly,
	mostRestrictiveResult,
	n8nIdempotencyKey,
	parseContext,
	parseEstimatedCostMicros,
} = require('../dist/nodes/Allowly/Allowly.node.js');

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
		getCredentials: async () => ({ apiUrl: 'https://api.allowly.ai' }),
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

function checkContext(parameters, response) {
	const requests = [];
	return {
		requests,
		getInputData: () => [{ json: {} }],
		getCredentials: async () => ({ apiUrl: 'https://api.allowly.ai' }),
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
