const assert = require('node:assert/strict');
const test = require('node:test');
const {
	mostRestrictiveResult,
	n8nIdempotencyKey,
	parseContext,
	parseEstimatedCostMicros,
} = require('../dist/nodes/Allowly/Allowly.node.js');

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

test('idempotency keys are stable per execution item', () => {
	const key = n8nIdempotencyKey('42', 'Allowly 🔒', 0);
	assert.equal(key, n8nIdempotencyKey('42', 'Allowly 🔒', 0));
	assert.notEqual(key, n8nIdempotencyKey('42', 'Allowly 🔒', 1));
	assert.match(key, /^n8n:[A-Za-z0-9_-]{43}$/);
});
