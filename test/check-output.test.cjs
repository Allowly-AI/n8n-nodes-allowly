const assert = require('node:assert/strict');
const test = require('node:test');
const { mostRestrictiveResult, parseContext } = require('../dist/nodes/Allowly/Allowly.node.js');

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
