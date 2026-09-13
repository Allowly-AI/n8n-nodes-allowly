import { createHash, createHmac } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';
import * as sealVerifier from './seal-verifier.js';
import type {
	KeyDocument,
	PublicKey,
	SealVerificationResult,
} from './seal-verifier.js';

type AllowlyCheckResponse = {
	authorization_id?: string;
	results?: Record<string, AllowlyActionResult>;
	[key: string]: unknown;
};

type AllowlyAuthorizationResponse = {
	authorization_id?: string;
	receipt?: unknown;
	[key: string]: unknown;
};

type AllowlyActionResult = {
	decision?: string;
	reason?: string;
	receipt?: unknown;
	policy_eval?: Record<string, unknown> | null;
	confirm_nonce?: string;
	confirm_expires_at?: string;
	escalation_id?: string;
	escalation_to?: string | null;
	escalation_expires_at?: string;
	[key: string]: unknown;
};

type AllowlyReceiptEnvelope = {
	status?: string;
	receipt_id?: string;
	receipt?: Record<string, unknown>;
	[key: string]: unknown;
};

type AllowlySealResponse = {
	request_id: string;
	workspace_id?: string;
	profile?: string;
	record_sha256?: string;
	decision?: string;
	reason?: string;
	receipt?: AllowlyReceiptEnvelope;
	[key: string]: unknown;
};

type RecordInput =
	| { kind: 'json'; value: string }
	| { kind: 'value'; value: unknown };

const DECISION_ORDER: Record<string, number> = { allow: 0, confirm: 1, escalate: 2, deny: 3 };

const API_URL = 'https://api.allowly.ai';

const MAX_SAFE_INTEGER = 2 ** 53 - 1;

function recordInput(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): RecordInput {
	const mode = executeFunctions.getNodeParameter('sealRecordInputMode', itemIndex) as string;
	if (mode === 'rawJson') {
		const value = executeFunctions.getNodeParameter('sealRecordJson', itemIndex);
		if (typeof value !== 'string') {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Raw JSON Text must be a string.',
				{ itemIndex },
			);
		}
		return { kind: 'json', value };
	}
	return {
		kind: 'value',
		value: executeFunctions.getNodeParameter('sealRecordValue', itemIndex),
	};
}

async function recordSha256(input: RecordInput): Promise<string> {
	return input.kind === 'json'
		? sealVerifier.hashSealJson(input.value)
		: sealVerifier.hashSealValue(input.value);
}

async function verifyRecord(
	input: RecordInput,
	receipt: Record<string, unknown>,
	publicKeys: PublicKey[],
	expectedWorkspaceId: string,
): Promise<SealVerificationResult> {
	const options = { expectedWorkspaceId };
	return input.kind === 'json'
		? sealVerifier.verifySealJson(input.value, receipt, publicKeys, options)
		: sealVerifier.verifySealValue(input.value, receipt, publicKeys, options);
}

function signedReceipt(envelope: AllowlyReceiptEnvelope): Record<string, unknown> | null {
	return envelope.status === 'signed' && envelope.receipt && typeof envelope.receipt === 'object'
		? envelope.receipt
		: null;
}

export async function waitForSignedSeal(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	envelope: AllowlyReceiptEnvelope,
	pollDelayMs = 1_000,
): Promise<Record<string, unknown>> {
	let current = envelope;
	let expectedReceiptId: string | null = null;
	while (current.status === 'pending') {
		if (typeof current.receipt_id !== 'string' || !current.receipt_id) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Allowly returned a pending seal without a receipt ID.',
				{ itemIndex },
			);
		}
		if (expectedReceiptId === null) expectedReceiptId = current.receipt_id;
		else if (current.receipt_id !== expectedReceiptId) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Allowly changed the receipt ID while the seal was pending.',
				{ itemIndex },
			);
		}
		current = (await executeFunctions.helpers.httpRequestWithAuthentication.call(
			executeFunctions,
			'allowlyApi',
			{
				method: 'GET',
				url: `${API_URL}/v1/receipts/${encodeURIComponent(expectedReceiptId)}`,
				json: true,
			},
		)) as AllowlyReceiptEnvelope;
		if (current.status === 'pending' && pollDelayMs > 0) {
			await sleep(pollDelayMs);
		}
	}
	const receipt = signedReceipt(current);
	if (!receipt) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly did not return a signed seal receipt.',
			{ itemIndex },
		);
	}
	if (
		typeof receipt.receipt_id !== 'string' ||
		!receipt.receipt_id ||
		(expectedReceiptId !== null && receipt.receipt_id !== expectedReceiptId)
	) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Signed seal receipt ID does not match the requested receipt.',
			{ itemIndex },
		);
	}
	return receipt;
}

async function authenticatedWorkspaceKeys(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	expectedWorkspaceId: string,
): Promise<{ document: KeyDocument; keys: PublicKey[]; fingerprints: string[] }> {
	const document = (await executeFunctions.helpers.httpRequestWithAuthentication.call(
		executeFunctions,
		'allowlyApi',
		{
			method: 'GET',
			url: `${API_URL}/v1/workspaces/${encodeURIComponent(expectedWorkspaceId)}/keys`,
			json: true,
		},
	)) as KeyDocument;
	if (document.workspace_id !== expectedWorkspaceId) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly returned keys for a different workspace.',
			{ itemIndex },
		);
	}
	const keys = sealVerifier.loadKeysFromJson(document);
	return {
		document,
		keys,
		fingerprints: keys.map(sealVerifier.publicKeyFingerprint),
	};
}

function parseSealEnvelope(value: unknown): AllowlyReceiptEnvelope {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}
	const object = value as Record<string, unknown>;
	if (object.status === 'signed' || object.status === 'pending') {
		return object as AllowlyReceiptEnvelope;
	}
	return { status: 'signed', receipt: object };
}

function parseActions(value: string): string[] {
	return Array.from(
		new Set(
			value
				.split(/[\n,]/)
				.map((action) => action.trim())
				.filter(Boolean),
		),
	);
}

function userIdFromEmail(email: string, pepper: string): string {
	const normalized = email.trim().toLowerCase();
	const digest = createHmac('sha256', pepper).update(normalized).digest('base64url');
	return `email_hmac:v1:${digest}`;
}

export function mostRestrictiveResult(
	results: Record<string, AllowlyActionResult>,
	actions: string[],
): { action: string; result: AllowlyActionResult } {
	const action = actions.reduce((worst, candidate) =>
		(DECISION_ORDER[results[candidate]?.decision ?? ''] ?? 4) >
		(DECISION_ORDER[results[worst]?.decision ?? ''] ?? 4)
			? candidate
			: worst,
	);
	return { action, result: results[action] ?? {} };
}

export function parseContext(value: unknown, executeFunctions: IExecuteFunctions, itemIndex: number): Record<string, unknown> {
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	const raw = String(value ?? '').trim();
	if (!raw) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			`Context JSON is invalid: ${(error as Error).message}`,
			{ itemIndex },
		);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new NodeOperationError(executeFunctions.getNode(), 'Context JSON must be an object', { itemIndex });
	}
	return parsed as Record<string, unknown>;
}

function parseSealMetadata(
	value: unknown,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): Record<string, string> | undefined {
	let parsed = value;
	if (typeof value === 'string') {
		const raw = value.trim();
		if (!raw) return undefined;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				`Metadata JSON is invalid: ${(error as Error).message}`,
				{ itemIndex },
			);
		}
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new NodeOperationError(executeFunctions.getNode(), 'Metadata must be an object.', {
			itemIndex,
		});
	}
	const entries = Object.entries(parsed as Record<string, unknown>);
	if (entries.length === 0) return undefined;
	if (entries.length > 8) {
		throw new NodeOperationError(executeFunctions.getNode(), 'Metadata supports at most 8 entries.', {
			itemIndex,
		});
	}
	for (const [key, item] of entries) {
		if (!key || key.length > 64 || typeof item !== 'string' || item.length > 256) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Metadata keys must be 1-64 characters and values must be strings up to 256 characters.',
				{ itemIndex },
			);
		}
	}
	return Object.fromEntries(entries) as Record<string, string>;
}

export function parseEstimatedCostMicros(
	value: unknown,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): number | null {
	// Absent input and the -1 UI default both mean "no estimate". An explicit 0
	// is a real value and must be serialized — the API treats it as a
	// deliberate zero-cost reservation, not an omission.
	if (value === undefined || value === null || value === '') return null;
	const cost = Number(value);
	if (cost === -1) return null;
	const rounded = Math.round(cost);
	if (!Number.isSafeInteger(rounded) || rounded < 0 || Math.abs(cost - rounded) > 1e-6) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			`Estimated Cost Micros must be a non-negative integer up to ${MAX_SAFE_INTEGER} (or -1 to omit).`,
			{ itemIndex },
		);
	}
	return rounded;
}

export function n8nIdempotencyKey(executionId: string, nodeName: string, itemIndex: number): string {
	const digest = createHash('sha256')
		.update(`${executionId}\0${nodeName}\0${itemIndex}`)
		.digest('base64url');
	return `n8n:${digest}`;
}

export class Allowly implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Allowly',
		name: 'allowly',
		icon: 'file:allowly.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Seal and verify JSON records, create authorizations, and check actions with Allowly.',
		defaults: {
			name: 'Allowly',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'allowlyApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Check',
						value: 'check',
						description: 'Call /v1/check before a tool or agent action runs',
						action: 'Check an authorization',
					},
					{
						name: 'Create Authorization',
						value: 'createAuthorization',
						description: 'Create an authorization from a user ID and agent policy',
						action: 'Create an authorization',
					},
					{
						name: 'Resolve Confirmation',
						value: 'resolveConfirmation',
						description: 'Approve or reject a confirmation returned by Check',
						action: 'Resolve a confirmation',
					},
					{
						name: 'Resolve Escalation',
						value: 'resolveEscalation',
						description: 'Report an approved or rejected escalation',
						action: 'Resolve an escalation',
					},
					{
						name: 'Seal JSON Record',
						value: 'seal',
						description: 'Hash a JSON record locally, request a seal, and wait for its signature',
						action: 'Seal a JSON record',
					},
					{
						name: 'Settle Budget',
						value: 'settleBudget',
						description: 'Report the actual cost of a budgeted check',
						action: 'Settle a budget estimate',
					},
					{
						name: 'Verify JSON Seal',
						value: 'verifySeal',
						description: 'Verify the signature and compare a JSON record locally',
						action: 'Verify a JSON seal',
					},
				],
				default: 'check',
			},
			{
				displayName: 'JSON Input',
				name: 'sealRecordInputMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Parsed Value',
						value: 'value',
						description: 'Use an n8n JSON value. Original number spelling and duplicate keys are already lost.',
					},
					{
						name: 'Raw JSON Text',
						value: 'rawJson',
						description: 'Validate raw JSON before parsing, including duplicate keys and number precision',
					},
				],
				default: 'value',
				displayOptions: { show: { operation: ['seal', 'verifySeal'] } },
			},
			{
				displayName: 'JSON Record',
				name: 'sealRecordValue',
				type: 'json',
				default: '={{$json}}',
				required: true,
				description: 'Record hashed inside n8n. The record is not sent to Allowly.',
				displayOptions: {
					show: { operation: ['seal', 'verifySeal'], sealRecordInputMode: ['value'] },
				},
			},
			{
				displayName: 'Raw JSON Text',
				name: 'sealRecordJson',
				type: 'string',
				typeOptions: { rows: 8 },
				default: '',
				required: true,
				description: 'Raw UTF-8 JSON text hashed inside n8n. It is not sent to Allowly.',
				displayOptions: {
					show: { operation: ['seal', 'verifySeal'], sealRecordInputMode: ['rawJson'] },
				},
			},
			{
				displayName: 'Request ID',
				name: 'sealRequestId',
				type: 'string',
				default: '',
				description: 'Optional stable retry ID. Defaults to this n8n execution, node, and item.',
				displayOptions: { show: { operation: ['seal'] } },
			},
			{
				displayName: 'Metadata',
				name: 'sealMetadata',
				type: 'json',
				default: '{}',
				description: 'Optional object of up to eight short string values copied into the signed seal',
				displayOptions: { show: { operation: ['seal'] } },
			},
			{
				displayName: 'Signed Seal Receipt',
				name: 'sealReceipt',
				type: 'json',
				default: '={{$json.receipt}}',
				required: true,
				description: 'A signed receipt object or signed receipt envelope from Allowly',
				displayOptions: { show: { operation: ['verifySeal'] } },
			},
			{
				displayName: 'Expected Workspace ID',
				name: 'sealExpectedWorkspaceId',
				type: 'string',
				default: '',
				required: true,
				description: 'Trusted workspace ID saved from the authenticated sealing workflow',
				displayOptions: { show: { operation: ['verifySeal'] } },
			},
			{
				displayName: 'Policy ID',
				name: 'policyId',
				type: 'string',
				default: '',
				required: true,
				description: 'Allowly agent policy ID to authorize for this user',
				displayOptions: {
					show: {
						operation: ['createAuthorization'],
					},
				},
			},
			{
				displayName: 'User Identifier',
				name: 'userIdentifierMode',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Mask Email Locally',
						value: 'emailHmac',
						description: 'Derive email_hmac:v1 locally with the credential pepper before sending to Allowly',
					},
					{
						name: 'Opaque User ID',
						value: 'opaque',
						description: 'Use an internal app user ID or pre-derived Allowly-safe user ID',
					},
				],
				default: 'opaque',
				description: 'Choose how the Allowly user_id is produced',
				displayOptions: {
					show: {
						operation: ['createAuthorization'],
					},
				},
			},
			{
				displayName: 'User ID',
				name: 'userId',
				type: 'string',
				default: '',
				required: true,
				description: 'Opaque user ID sent as user_id. Do not use raw email by default.',
				displayOptions: {
					show: {
						operation: ['createAuthorization'],
						userIdentifierMode: ['opaque'],
					},
				},
			},
			{
				displayName: 'User Email',
				name: 'userEmail',
				type: 'string',
				default: '',
				required: true,
				description: 'Email to HMAC locally. The raw email is not sent to Allowly.',
				displayOptions: {
					show: {
						operation: ['createAuthorization'],
						userIdentifierMode: ['emailHmac'],
					},
				},
			},
			{
				displayName: 'Authorization',
				name: 'authorization',
				type: 'string',
				default: '',
				required: true,
				description:
					'Stored Allowly authorization ID. The authorization already binds the user, agent, and actions.',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Action(s)',
				name: 'actions',
				type: 'string',
				default: '',
				required: true,
				description: 'One action name, or multiple action names separated by commas or new lines',
				placeholder: 'email.send',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'string',
				default: '',
				description: 'Optional target resource for the action, for example gmail:thread:abc123',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Session',
				name: 'session',
				type: 'string',
				default: '',
				description: 'Optional workflow or agent-session identifier copied into the signed receipt',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Estimated Cost Micros',
				name: 'estimatedCostMicros',
				type: 'number',
				default: -1,
				description:
					'Optional estimated action cost in micro-USD for budgeted authorizations. Leave at -1 to omit; 0 is sent as an explicit zero-cost estimate. Reserved amounts stay charged until a Settle Budget step reports the actual cost.',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Workflow User',
				name: 'workflowUser',
				type: 'string',
				default: '',
				description:
					'Optional n8n workflow context value. Authorization is still determined by Authorization.',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Workflow Agent',
				name: 'workflowAgent',
				type: 'string',
				default: '',
				description:
					'Optional n8n workflow context value. Authorization is still determined by Authorization.',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Additional Context JSON',
				name: 'contextJson',
				type: 'json',
				default: '{}',
				description: 'Optional JSON object copied into the Allowly check context and receipt',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Check Receipt ID',
				name: 'checkReceiptId',
				type: 'string',
				default: '',
				required: true,
				description:
					'Map the receipt_id from the budgeted action in the Check step output. Settle in the same workflow run while the receipt still exists.',
				displayOptions: {
					show: {
						operation: ['settleBudget'],
					},
				},
			},
			{
				displayName: 'Confirmation Nonce',
				name: 'confirmationNonce',
				type: 'string',
				default: '',
				required: true,
				description: 'Map confirm_nonce from the Check result',
				displayOptions: { show: { operation: ['resolveConfirmation'] } },
			},
			{
				displayName: 'Approved',
				name: 'confirmationApproved',
				type: 'boolean',
				default: true,
				description: 'Whether the customer application reports that the prompt was approved',
				displayOptions: { show: { operation: ['resolveConfirmation'] } },
			},
			{
				displayName: 'Approval TTL Seconds',
				name: 'confirmationTtlSeconds',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 300 },
				default: 60,
				description: 'How long an approved confirmation may satisfy the follow-up Check (1-300 seconds)',
				displayOptions: { show: { operation: ['resolveConfirmation'] } },
			},
			{
				displayName: 'Confirmation Idempotency Key',
				name: 'confirmationIdempotencyKey',
				type: 'string',
				default: '',
				description: 'Optional replay key. Defaults to this n8n execution, node, and item.',
				displayOptions: { show: { operation: ['resolveConfirmation'] } },
			},
			{
				displayName: 'Escalation ID',
				name: 'escalationId',
				type: 'string',
				default: '',
				required: true,
				description: 'Map escalation_id from the Check result',
				displayOptions: { show: { operation: ['resolveEscalation'] } },
			},
			{
				displayName: 'Resolution',
				name: 'escalationResolution',
				type: 'options',
				options: [
					{ name: 'Approved', value: 'approved' },
					{ name: 'Rejected', value: 'rejected' },
				],
				default: 'approved',
				displayOptions: { show: { operation: ['resolveEscalation'] } },
			},
			{
				displayName: 'Resolved By',
				name: 'escalationResolvedBy',
				type: 'string',
				default: '',
				required: true,
				description: 'Opaque customer-reported approver identifier recorded in the escalation receipt',
				displayOptions: { show: { operation: ['resolveEscalation'] } },
			},
			{
				displayName: 'Note',
				name: 'escalationNote',
				type: 'string',
				default: '',
				description: 'Optional customer-reported resolution note',
				displayOptions: { show: { operation: ['resolveEscalation'] } },
			},
			{
				displayName: 'Actual Cost (Micro-USD)',
				name: 'actualCostMicros',
				type: 'number',
				default: 0,
				required: true,
				description: 'Actual non-negative integer cost. Settlement requires a Check with an estimated cost.',
				displayOptions: {
					show: {
						operation: ['settleBudget'],
					},
				},
			},
			{
				displayName: 'Idempotency Key',
				name: 'settlementIdempotencyKey',
				type: 'string',
				default: '',
				description: 'Optional replay key. Defaults to the n8n execution ID plus check receipt ID.',
				displayOptions: {
					show: {
						operation: ['settleBudget'],
					},
				},
			},
		],
		usableAsTool: true,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
			try {
				const credentials = await this.getCredentials('allowlyApi', itemIndex);
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const idempotencyKey = n8nIdempotencyKey(
					this.getExecutionId(),
					this.getNode().name,
					itemIndex,
				);

				if (operation === 'seal') {
					const input = recordInput(this, itemIndex);
					const digest = await recordSha256(input);
					const requestId =
						(this.getNodeParameter('sealRequestId', itemIndex) as string).trim() || idempotencyKey;
					const metadata = parseSealMetadata(
						this.getNodeParameter('sealMetadata', itemIndex),
						this,
						itemIndex,
					);
					const { SEAL_PROFILE } = sealVerifier;
					const body: Record<string, unknown> = {
						request_id: requestId,
						profile: SEAL_PROFILE,
						record_sha256: digest,
					};
					if (metadata) body.metadata = metadata;
					const sealResponse = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'allowlyApi',
						{
							method: 'POST',
							url: `${API_URL}/v1/seal`,
							headers: { 'Content-Type': 'application/json' },
							body,
							json: true,
						},
					)) as AllowlySealResponse;
					if (
						sealResponse.request_id !== requestId ||
						sealResponse.decision !== 'allow' ||
						sealResponse.profile !== SEAL_PROFILE ||
						sealResponse.record_sha256 !== digest ||
						typeof sealResponse.workspace_id !== 'string' ||
						!sealResponse.workspace_id ||
						!sealResponse.receipt
					) {
						throw new NodeOperationError(
							this.getNode(),
							'Allowly returned an invalid seal response.',
							{ itemIndex },
						);
					}
					const workspaceId = sealResponse.workspace_id;
					const receipt = await waitForSignedSeal(this, itemIndex, sealResponse.receipt);
					const trustedKeys = await authenticatedWorkspaceKeys(this, itemIndex, workspaceId);
					const verification = await verifyRecord(input, receipt, trustedKeys.keys, workspaceId);
					if (!verification.signatureVerified || !verification.recordMatches) {
						throw new NodeOperationError(
							this.getNode(),
							`Signed seal failed local verification: ${verification.failureReason ?? 'unknown error'}.`,
							{ itemIndex },
						);
					}
					returnData.push({
						json: {
							sealed: true,
							signatureVerified: true,
							recordMatches: true,
							requestId,
							profile: SEAL_PROFILE,
							recordSha256: digest,
							workspaceId,
							recordedAt: receipt.issued_at,
							receipt,
							keysDocument: trustedKeys.document,
							trustedKeyFingerprints: trustedKeys.fingerprints,
							...(input.kind === 'json'
								? { recordJson: input.value }
								: { record: input.value }),
						} as IDataObject,
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (operation === 'verifySeal') {
					const input = recordInput(this, itemIndex);
					const expectedWorkspaceId = (
						this.getNodeParameter('sealExpectedWorkspaceId', itemIndex) as string
					).trim();
					if (!expectedWorkspaceId) {
						throw new NodeOperationError(this.getNode(), 'Expected Workspace ID is required.', {
							itemIndex,
						});
					}
					const envelope = parseSealEnvelope(this.getNodeParameter('sealReceipt', itemIndex));
					const receipt = await waitForSignedSeal(this, itemIndex, envelope);
					const trustedKeys = await authenticatedWorkspaceKeys(
						this,
						itemIndex,
						expectedWorkspaceId,
					);
					const verification = await verifyRecord(
						input,
						receipt,
						trustedKeys.keys,
						expectedWorkspaceId,
					);
					if (!verification.signatureVerified || !verification.recordMatches) {
						throw new NodeOperationError(
							this.getNode(),
							`SEAL verification failed: ${verification.failureReason ?? 'unknown error'}.`,
							{ itemIndex },
						);
					}
					returnData.push({
						json: {
							verified: verification.signatureVerified && verification.recordMatches,
							signatureVerified: verification.signatureVerified,
							recordMatches: verification.recordMatches,
							failureReason: verification.failureReason,
							expectedWorkspaceId,
							recordedAt: receipt.issued_at,
							receipt,
							keysDocument: trustedKeys.document,
							trustedKeyFingerprints: trustedKeys.fingerprints,
						} as IDataObject,
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (operation === 'createAuthorization') {
					const policyId = (this.getNodeParameter('policyId', itemIndex) as string).trim();
					const userIdentifierMode = this.getNodeParameter('userIdentifierMode', itemIndex) as string;
					let userId: string;

					if (!policyId) {
						throw new NodeOperationError(this.getNode(), 'Policy is required.', { itemIndex });
					}

					if (userIdentifierMode === 'emailHmac') {
						const userEmail = (this.getNodeParameter('userEmail', itemIndex) as string).trim();
						const userIdPepper = String(credentials.userIdPepper ?? '');

						if (!userEmail) {
							throw new NodeOperationError(this.getNode(), 'User Email is required.', { itemIndex });
						}
						if (!userIdPepper) {
							throw new NodeOperationError(this.getNode(), 'User ID Pepper is required.', { itemIndex });
						}

						userId = userIdFromEmail(userEmail, userIdPepper);
					} else {
						userId = (this.getNodeParameter('userId', itemIndex) as string).trim();
						if (!userId) {
							throw new NodeOperationError(this.getNode(), 'User ID is required.', { itemIndex });
						}
					}

					const options: IHttpRequestOptions = {
						method: 'POST',
						url: `${API_URL}/v1/authorizations`,
						headers: {
							'Content-Type': 'application/json',
							'Idempotency-Key': idempotencyKey,
						},
						body: {
							user_id: userId,
							policy_id: policyId,
						},
						json: true,
					};

					const response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'allowlyApi',
						options,
					)) as AllowlyAuthorizationResponse;
					returnData.push({
						json: {
							authorizationId: response.authorization_id,
							userId,
							policyId,
							receipt: response.receipt,
							response,
						} as IDataObject,
						pairedItem: {
							item: itemIndex,
						},
					});
					continue;
				}

				if (operation === 'settleBudget') {
					const checkReceiptId = (this.getNodeParameter('checkReceiptId', itemIndex) as string).trim();
					const actualCostMicros = Number(this.getNodeParameter('actualCostMicros', itemIndex));
					const settlementIdempotencyKey = (
						this.getNodeParameter('settlementIdempotencyKey', itemIndex) as string
					).trim() || `${this.getExecutionId()}:${checkReceiptId}`;

					if (!checkReceiptId) {
						throw new NodeOperationError(this.getNode(), 'Check Receipt ID is required.', { itemIndex });
					}
					if (!Number.isSafeInteger(actualCostMicros) || actualCostMicros < 0) {
						throw new NodeOperationError(
							this.getNode(),
							`Actual Cost (micro-USD) must be a non-negative integer up to ${MAX_SAFE_INTEGER}.`,
							{ itemIndex },
						);
					}

					const response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'allowlyApi',
						{
							method: 'POST',
							url: `${API_URL}/v1/budget-settlements`,
							headers: {
								'Content-Type': 'application/json',
								'Idempotency-Key': settlementIdempotencyKey,
							},
							body: {
								check_receipt_id: checkReceiptId,
								actual_cost_micros: actualCostMicros,
							},
							json: true,
						},
					)) as Record<string, unknown>;

					returnData.push({ json: response as IDataObject, pairedItem: { item: itemIndex } });
					continue;
				}

				if (operation === 'resolveConfirmation') {
					const nonce = (this.getNodeParameter('confirmationNonce', itemIndex) as string).trim();
					const approved = this.getNodeParameter('confirmationApproved', itemIndex) as boolean;
					const ttlSeconds = Number(this.getNodeParameter('confirmationTtlSeconds', itemIndex));
					const confirmationIdempotencyKey =
						(this.getNodeParameter('confirmationIdempotencyKey', itemIndex) as string).trim() || idempotencyKey;
					if (!nonce) throw new NodeOperationError(this.getNode(), 'Confirmation Nonce is required.', { itemIndex });
					if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) {
						throw new NodeOperationError(this.getNode(), 'Approval TTL Seconds must be an integer from 1 to 300.', { itemIndex });
					}
					const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'allowlyApi', {
						method: 'POST',
						url: `${API_URL}/v1/confirmations/${encodeURIComponent(nonce)}`,
						headers: {
							'Content-Type': 'application/json',
							'Idempotency-Key': confirmationIdempotencyKey,
						},
						body: { approved, ttl_seconds: ttlSeconds },
						json: true,
					})) as Record<string, unknown>;
					returnData.push({
						json: response as IDataObject,
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (operation === 'resolveEscalation') {
					const escalationId = (this.getNodeParameter('escalationId', itemIndex) as string).trim();
					const resolution = this.getNodeParameter('escalationResolution', itemIndex) as string;
					const resolvedBy = (this.getNodeParameter('escalationResolvedBy', itemIndex) as string).trim();
					const note = (this.getNodeParameter('escalationNote', itemIndex) as string).trim();
					if (!escalationId) throw new NodeOperationError(this.getNode(), 'Escalation ID is required.', { itemIndex });
					if (!resolvedBy) throw new NodeOperationError(this.getNode(), 'Resolved By is required.', { itemIndex });
					if (!['approved', 'rejected'].includes(resolution)) {
						throw new NodeOperationError(this.getNode(), 'Resolution must be approved or rejected.', { itemIndex });
					}
					if (resolvedBy.length > 128) {
						throw new NodeOperationError(this.getNode(), 'Resolved By must be at most 128 characters.', { itemIndex });
					}
					if (note.length > 512) {
						throw new NodeOperationError(this.getNode(), 'Note must be at most 512 characters.', { itemIndex });
					}
					const body: Record<string, unknown> = {
						resolution,
						resolved_by: resolvedBy,
					};
					if (note) body.note = note;
					const response = (await this.helpers.httpRequestWithAuthentication.call(this, 'allowlyApi', {
						method: 'POST',
						url: `${API_URL}/v1/escalations/${encodeURIComponent(escalationId)}/resolve`,
						headers: { 'Content-Type': 'application/json' },
						body,
						json: true,
					})) as Record<string, unknown>;
					returnData.push({
						json: response as IDataObject,
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				const authorizationId = (this.getNodeParameter('authorization', itemIndex) as string).trim();
				const actions = parseActions(this.getNodeParameter('actions', itemIndex) as string);
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const sessionId = this.getNodeParameter('session', itemIndex) as string;
				const estimatedCostMicros = parseEstimatedCostMicros(
					this.getNodeParameter('estimatedCostMicros', itemIndex),
					this,
					itemIndex,
				);
				const workflowUserId = this.getNodeParameter('workflowUser', itemIndex) as string;
				const workflowAgentId = this.getNodeParameter('workflowAgent', itemIndex) as string;
				const context = parseContext(this.getNodeParameter('contextJson', itemIndex), this, itemIndex);

				if (!authorizationId) {
					throw new NodeOperationError(this.getNode(), 'Authorization is required.', { itemIndex });
				}
				if (actions.length === 0) {
					throw new NodeOperationError(this.getNode(), 'At least one action is required.', { itemIndex });
				}
				if (actions.length > 25) {
					throw new NodeOperationError(this.getNode(), 'At most 25 actions may be checked at once.', { itemIndex });
				}

				if (workflowUserId.trim()) context.workflow_user_id = workflowUserId.trim();
				if (workflowAgentId.trim()) context.workflow_agent_id = workflowAgentId.trim();

				const body: Record<string, unknown> = {
					authorization_id: authorizationId,
					actions,
				};
				if (resource.trim()) body.resource = resource.trim();
				if (sessionId.trim()) body.session_id = sessionId.trim();
				if (estimatedCostMicros !== null) body.estimated_cost_micros = estimatedCostMicros;
				if (Object.keys(context).length > 0) body.context = context;

				const options: IHttpRequestOptions = {
					method: 'POST',
					url: `${API_URL}/v1/check`,
					headers: {
						'Content-Type': 'application/json',
						'Idempotency-Key': idempotencyKey,
					},
					body,
					json: true,
				};

				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'allowlyApi',
					options,
				)) as AllowlyCheckResponse;
				const { action, result } = mostRestrictiveResult(response.results ?? {}, actions);

				returnData.push({
					json: {
						action,
						decision: result.decision,
						reason: result.reason,
						receipt: result.receipt,
						policyEval: result.policy_eval ?? null,
						confirmNonce: result.confirm_nonce,
						confirmExpiresAt: result.confirm_expires_at,
						escalationId: result.escalation_id,
						escalationTo: result.escalation_to,
						escalationExpiresAt: result.escalation_expires_at,
						results: response.results,
						response,
					} as IDataObject,
					pairedItem: {
						item: itemIndex,
					},
				});
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: (error as { description?: string }).description || (error as Error).message,
						},
						pairedItem: {
							item: itemIndex,
						},
					});
					continue;
				}

				throw new NodeOperationError(
					this.getNode(),
					error instanceof Error ? error : String(error),
					{ itemIndex },
				);
			}
		}

		return [returnData];
	}
}
