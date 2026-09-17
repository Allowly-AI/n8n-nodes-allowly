const assert = require('node:assert/strict');
const test = require('node:test');

const { NodeHelpers } = require('n8n-workflow');
const { Allowly } = require('../dist/nodes/Allowly/Allowly.node.js');

const WEBHOOK_OPERATIONS = new Set(['sealWebhook', 'retrieveWebhookSeal']);
const CREDENTIAL_FREE_OPERATIONS = new Set(['verifySealEvidence']);

function operationValues(description) {
	return [
		...new Set(
			description.properties
				.filter(({ name }) => name === 'operation')
				.flatMap(({ options }) => options.map(({ value }) => value)),
		),
	];
}

function visibleCredentials(description, version, operation) {
	const node = {
		name: 'Allowly',
		type: 'n8n-nodes-allowly.allowly',
		typeVersion: version,
		parameters: { operation },
		position: [0, 0],
	};
	return description.credentials
		.filter((credential) => NodeHelpers.displayParameter(node.parameters, credential, '', node))
		.map(({ name }) => name);
}

test('n8n does not infer Operation as an authentication selector', () => {
	const description = new Allowly().description;
	assert.equal(description.credentials.some(({ displayOptions }) => displayOptions?.show?.operation), false);
});

test('each operation exposes only its required credential in both node versions', () => {
	const description = new Allowly().description;
	for (const version of [1, 2]) {
		for (const operation of operationValues(description)) {
			const expected = CREDENTIAL_FREE_OPERATIONS.has(operation)
				? []
				: WEBHOOK_OPERATIONS.has(operation)
					? ['allowlySealWebhookApi']
					: ['allowlyApi'];
			assert.deepEqual(visibleCredentials(description, version, operation), expected, `${version}:${operation}`);
		}
	}
});

test('an imported Managed SEAL node keeps its mapped record', () => {
	const description = new Allowly().description;
	const imported = {
		operation: 'sealWebhook',
		sealRecordInputMode: 'rawJson',
		sealRecordJson: '={{ $json.record_json }}',
	};
	const roundTripped = NodeHelpers.getNodeParameters(
		description.properties,
		imported,
		false,
		false,
		{ name: 'Allowly', type: description.name, typeVersion: 2, parameters: imported, position: [0, 0] },
		description,
	);
	assert.equal(roundTripped.sealRecordJson, imported.sealRecordJson);
});

test('legacy Check still requires Authorization and Action(s)', () => {
	const description = new Allowly().description;
	const node = {
		name: 'Allowly',
		type: description.name,
		typeVersion: 1,
		parameters: { operation: 'check' },
		position: [0, 0],
	};
	assert.deepEqual(NodeHelpers.getNodeParametersIssues(description.properties, node), {
		parameters: {
			authorization: ['Parameter "Authorization" is required.'],
			actions: ['Parameter "Action(s)" is required.'],
		},
	});
});
