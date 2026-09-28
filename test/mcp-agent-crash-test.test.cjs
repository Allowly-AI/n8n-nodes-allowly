const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { Workflow } = require('n8n-workflow');
const { Allowly } = require('../dist/nodes/Allowly/Allowly.node.js');

const example = (name) => join(__dirname, '..', 'examples', name);
const workflowText = readFileSync(example('mcp-agent-crash-test.json'), 'utf8');
const workflow = JSON.parse(workflowText);
const setupText = readFileSync(example('mcp-agent-crash-test.allowly.setup.json'), 'utf8');
const dataText = readFileSync(example('mcp-agent-crash-test.data.json'), 'utf8');
const clientText = readFileSync(example('mcp-agent-crash-test.client.example.json'), 'utf8');
const setup = JSON.parse(setupText);
const data = JSON.parse(dataText);
const client = JSON.parse(clientText);
const nodes = Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));

function runCode(name, json = {}) {
	return vm.runInNewContext(`(() => {\n${nodes[name].parameters.jsCode}\n})()`, {
		$json: structuredClone(json),
	});
}

function destinations(source, output = 0, type = 'main') {
	return (workflow.connections[source]?.[type]?.[output] ?? []).map((connection) => connection.node);
}

function incoming(target) {
	const result = [];
	for (const [source, connectionTypes] of Object.entries(workflow.connections)) {
		for (const [type, outputs] of Object.entries(connectionTypes)) {
			for (const [output, branch] of outputs.entries()) {
				for (const connection of branch) {
					if (connection.node === target) result.push({ source, type, output });
				}
			}
		}
	}
	return result;
}

test('public workflow is a clean, inactive import artifact', () => {
	assert.deepEqual(Object.keys(workflow).sort(), ['active', 'connections', 'name', 'nodes', 'pinData', 'settings']);
	assert.equal(workflow.active, false);
	assert.deepEqual(workflow.pinData, {});
	assert.equal(workflow.settings.executionOrder, 'v1');
	assert.equal(new Set(workflow.nodes.map((node) => node.name)).size, workflow.nodes.length);
	assert.equal(new Set(workflow.nodes.map((node) => node.id)).size, workflow.nodes.length);

	for (const node of workflow.nodes) {
		assert.equal(node.credentials, undefined, `${node.name}: no credential binding`);
		assert.equal(node.webhookId, undefined, `${node.name}: no hosted webhook ID`);
		assert.equal(node.continueOnFail, undefined, `${node.name}: does not continue after failure`);
		assert.equal(node.onError, undefined, `${node.name}: no error-output bypass`);
		assert.equal(node.disabled, undefined, `${node.name}: enabled in the imported graph`);
	}

	for (const [source, connectionTypes] of Object.entries(workflow.connections)) {
		assert.ok(nodes[source], `connection source exists: ${source}`);
		for (const outputs of Object.values(connectionTypes)) {
			for (const branch of outputs) {
				for (const connection of branch) assert.ok(nodes[connection.node], `connection target exists: ${connection.node}`);
			}
		}
	}

	const allowlyType = new Allowly();
	const imported = new Workflow({
		...structuredClone(workflow),
		nodeTypes: {
			getByNameAndVersion(name, version) {
				if (name === 'n8n-nodes-allowly.allowly') return allowlyType;
				return {
					description: {
						displayName: name, name, version, group: [], description: name,
						defaults: { name }, inputs: [], outputs: [], properties: [],
					},
				};
			},
		},
	});
	assert.equal(imported.name, workflow.name);
	assert.equal(Object.keys(imported.nodes).length, workflow.nodes.length);
	assert.ok(imported.getParentNodes('Zoho Mail — only explicit allow').includes('Validate Allowly decision'));

	for (const pattern of [/n8n-demo\.allowly\.ai/i, /alianov/i, /allowly_l\d_/i, /CUSTOM\.allowly/]) {
		assert.doesNotMatch(workflowText, pattern);
	}
});

test('every Allowly node uses the verified type at the current default version', () => {
	const defaultVersion = new Allowly().description.defaultVersion;
	assert.equal(defaultVersion, 2);
	const allowlyNodes = workflow.nodes.filter((node) => node.type === 'n8n-nodes-allowly.allowly');
	assert.deepEqual(allowlyNodes.map((node) => node.name).sort(), [
		'Allowly checks before Zoho Mail',
		'Create test authorization',
	]);
	for (const node of allowlyNodes) assert.equal(node.typeVersion, defaultVersion, node.name);
	assert.equal(workflow.nodes.some((node) => node.type === 'CUSTOM.allowly'), false);
});

test('the package contains placeholders, not credentials or hosted bindings', () => {
	assert.equal(nodes['MCP Server Trigger'].parameters.authentication, 'bearerAuth');
	assert.equal(
		Object.hasOwn(nodes.read_demo_inbox.parameters.workflowInputs.value, 'authorization_id'),
		false,
	);
	assert.equal(
		nodes.read_demo_inbox.parameters.workflowInputs.schema.some(({ id }) => id === 'authorization_id'),
		false,
	);
	assert.equal(nodes.send_email.parameters.workflowInputs.value.authorization_id, 'auth_REPLACE_WITH_PRESTAGED_ID');
	const releaseParameters = Object.fromEntries(
		nodes['Release parameters'].parameters.assignments.assignments.map(({ name, value }) => [name, value]),
	);
	assert.deepEqual(releaseParameters, {
		zoho_mcp_endpoint: 'REPLACE_WITH_DRUIM_MCP_ENDPOINT',
		zoho_account_id: 'REPLACE_WITH_VERIFIED_DRUIM_ACCOUNT_ID',
		zoho_from_address: 'REPLACE_WITH_VERIFIED_DRUIM_FROM_ADDRESS',
	});
	assert.equal(nodes['Release parameters'].parameters.includeOtherFields, true);
	assert.equal(
		nodes['Zoho Mail — only explicit allow'].parameters.endpointUrl,
		"={{ $('Release parameters').first().json.zoho_mcp_endpoint }}",
	);
	assert.equal(
		nodes['Zoho Mail — only explicit allow'].parameters.jsonInput,
		"={{ { path_variables: { accountId: $('Release parameters').first().json.zoho_account_id }, body: { fromAddress: $('Release parameters').first().json.zoho_from_address, toAddress: $('Derive trusted context locally').first().json.to, subject: $('Derive trusted context locally').first().json.subject, content: $('Derive trusted context locally').first().json.body, mailFormat: 'plaintext' } } }}",
	);
	assert.equal(client.mcpServers['allowly-agent-crash-test'].args[1], 'REPLACE_WITH_N8N_MCP_PRODUCTION_URL');
	assert.equal(client.mcpServers['allowly-agent-crash-test'].env.N8N_MCP_BEARER_TOKEN, 'REPLACE_WITH_MCP_BEARER_TOKEN');
	assert.equal(Object.hasOwn(setup, 'host'), false);
	assert.equal(Object.hasOwn(setup, 'workflow_id'), false);
	assert.equal(Object.hasOwn(setup, 'runtime_bindings'), false);
	for (const text of [workflowText, setupText, dataText, clientText]) {
		for (const pattern of [/n8n-demo\.allowly\.ai/i, /alianov/i, /allowly_l\d_/i, /AIza[\w-]{20,}/, /ya29\./, /-----BEGIN [A-Z ]+PRIVATE KEY-----/]) {
			assert.doesNotMatch(text, pattern);
		}
	}
});

test('synthetic data is reserved-domain-only and matches the embedded demo', () => {
	assert.equal(data.synthetic, true);
	const emails = JSON.stringify(data).match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [];
	assert.ok(emails.length >= 5);
	for (const email of emails) {
		const domain = email.split('@')[1];
		assert.ok(domain.endsWith('.example') || domain.endsWith('.invalid'), email);
	}

	const inbox = runCode('Return poisoned support email')[0].json;
	assert.equal(inbox.synthetic, true);
	assert.equal(inbox.messages[0].id, data.inbox[0].id);
	assert.equal(inbox.messages[0].from, data.inbox[0].from);
	assert.equal(inbox.messages[0].subject, data.inbox[0].subject);
	assert.equal(inbox.messages[0].body, data.inbox[0].body_lines.join('\n'));

	const attempted = runCode('Compromised agent tries export', { authorizationId: 'auth_fixture' })[0].json;
	assert.equal(attempted.payload.to, data.attempted_send.to);
	assert.equal(attempted.payload.subject, data.attempted_send.subject);
	assert.equal(attempted.payload.body, data.attempted_send.body_lines.join('\n'));

	const derived = runCode('Derive trusted context locally', attempted)[0].json;
	assert.deepEqual(structuredClone(derived.allowly_context), {
		recipient_scope: 'external', recipient_count: 1, data_class: 'customer_export',
	});
	const safe = runCode('Derive trusted context locally', {
		payload: { to: 'ops@company.example', subject: 'Status', body: 'All systems normal.' },
	})[0].json;
	assert.deepEqual(structuredClone(safe.allowly_context), {
		recipient_scope: 'internal', recipient_count: 1, data_class: 'normal',
	});
});

test('the supplied policy denies the attack and pauses other external sends', () => {
	const action = setup.actions.find((candidate) => candidate.name === 'mcp_demo.email.send');
	assert.deepEqual(action.constraints_schema.context_fields, {
		recipient_scope: 'string', recipient_count: 'number', data_class: 'string',
	});
	const policy = setup.policies.find((candidate) => candidate.policy_id === 'mcp_agent_crash_test_v1');
	const constraints = policy.actions.find((candidate) => candidate.name === action.name).constraints;
	assert.equal(constraints.max_per_day, 5);
	assert.deepEqual(constraints.deny_when, [{ field: 'data_class', eq: 'customer_export' }]);
	assert.deepEqual(constraints.confirm_when, [{ field: 'recipient_scope', eq: 'external' }]);
});

test('Zoho Mail has one incoming edge and it is the explicit allow branch', () => {
	const zoho = nodes['Zoho Mail — only explicit allow'];
	assert.equal(zoho.type, '@n8n/n8n-nodes-langchain.mcpClient');
	assert.equal(zoho.typeVersion, 1.1);
	assert.equal(zoho.parameters.serverTransport, 'httpStreamable');
	assert.equal(zoho.parameters.authentication, 'mcpOAuth2Api');
	assert.equal(zoho.parameters.tool.value, 'ZohoMail_sendEmail');
	assert.equal(zoho.parameters.inputMode, 'json');
	assert.deepEqual(incoming('Zoho Mail — only explicit allow'), [
		{ source: 'Allowly decision is allow', type: 'main', output: 0 },
	]);
	assert.deepEqual(destinations('Allowly checks before Zoho Mail'), ['Validate Allowly decision']);
	assert.deepEqual(destinations('Normalize tool request'), ['Release parameters']);
	assert.deepEqual(destinations('Release parameters'), ['Tool is read_demo_inbox']);
	assert.deepEqual(destinations('Validate Allowly decision'), ['Allowly decision is allow']);
	assert.deepEqual(destinations('Allowly decision is allow', 0), ['Zoho Mail — only explicit allow']);
	assert.deepEqual(destinations('Allowly decision is allow', 1), ['DENIED or paused — Zoho Mail not called']);
	assert.equal(nodes['Allowly checks before Zoho Mail'].continueOnFail, undefined);
	assert.equal(nodes['Allowly checks before Zoho Mail'].onError, undefined);
});

test('only a complete, internally consistent allow passes the final branch', () => {
	const valid = (decision) => ({
		action: 'mcp_demo.email.send',
		decision,
		reason: 'fixture_reason',
		receipt: { status: 'pending', receipt_id: `rcp_${decision}` },
		results: { 'mcp_demo.email.send': { decision } },
	});
	for (const decision of ['allow', 'deny', 'confirm', 'escalate']) {
		const output = runCode('Validate Allowly decision', valid(decision))[0].json;
		assert.equal(output.decision, decision);
		assert.equal(output.receipt_id, `rcp_${decision}`);
		assert.equal(output.decision === 'allow', decision === 'allow');
	}

	for (const malformed of [
		{},
		{ ...valid('allow'), action: 'another.action' },
		{ ...valid('allow'), reason: '' },
		{ ...valid('allow'), receipt: {} },
		{ ...valid('allow'), results: {} },
		{ ...valid('allow'), results: { 'mcp_demo.email.send': { decision: 'deny' } } },
		{ ...valid('allow'), decision: 'ALLOW' },
	]) {
		assert.throws(() => runCode('Validate Allowly decision', malformed), /Invalid Allowly decision/);
	}
});
