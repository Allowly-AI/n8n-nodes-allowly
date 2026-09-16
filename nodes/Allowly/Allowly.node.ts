import { createHash, createHmac } from 'crypto';
import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ApplicationError, NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';
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

type AllowlySealWebhookStatus = 'received' | 'signing' | 'sealed' | 'rejected' | 'failed';

type AllowlySealMetadata = Record<string, string>;

type AllowlySealWebhookDelivery = {
	attemptId: string;
	workspaceId: string;
	status: AllowlySealWebhookStatus;
	receivedAt: string;
	updatedAt: string;
	profile: string;
	recordSha256: string | null;
	metadata: AllowlySealMetadata | null;
	receiptId: string | null;
	errorCode: string | null;
	receipt: Record<string, unknown> | null;
};

type SealWebhookEndpoint = {
	origin: string;
	token: string;
};

type FullHttpResponse = {
	body?: unknown;
	headers?: Record<string, unknown>;
	statusCode?: number | string;
};

type RecordInput =
	| { kind: 'json'; value: string }
	| { kind: 'value'; value: unknown };

const DECISION_ORDER: Record<string, number> = { allow: 0, confirm: 1, escalate: 2, deny: 3 };

const API_URL = 'https://api.allowly.ai';

const SEAL_WEBHOOK_PATH = '/v1/seal/webhooks';

const SEAL_WEBHOOK_PROFILE = 'allowly.seal.jcs-sha256.v1';

const SEAL_WEBHOOK_CREDENTIAL = 'allowlySealWebhookApi';

const SEAL_WEBHOOK_POLL_DELAY_MS = 1_000;

const SEAL_WEBHOOK_REQUEST_TIMEOUT_MS = 15_000;

const SEAL_WEBHOOK_MAX_RETRY_AFTER_SECONDS = 5;

const SEAL_WEBHOOK_DETAIL_PARAMETERS = [
	['sealWebhookType', 'Allowly-Seal-Type', 'Type'],
	['sealWebhookReference', 'Allowly-Seal-Reference', 'Reference'],
	['sealWebhookStatement', 'Allowly-Seal-Statement', 'Statement'],
] as const;

const LEGACY_OPERATION_OPTIONS: INodePropertyOptions[] = [
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
		name: 'Seal JSON Record (API Key)',
		value: 'seal',
		description: 'Hash a JSON record locally, request a seal, and wait for its signature',
		action: 'Seal a JSON record with an API key',
	},
	{
		name: 'Settle Budget',
		value: 'settleBudget',
		description: 'Report the actual cost of a budgeted check',
		action: 'Settle a budget estimate',
	},
	{
		name: 'Verify JSON Seal (API Key)',
		value: 'verifySeal',
		description: 'Fetch workspace keys, verify the signature, and compare a JSON record locally',
		action: 'Verify a JSON seal with an API key',
	},
];

const MANAGED_OPERATION_OPTIONS: INodePropertyOptions[] = [
	{
		name: 'Seal JSON with Managed Webhook',
		value: 'sealWebhook',
		description: 'Send JSON through a private SEAL webhook and verify the signed evidence',
		action: 'Seal JSON with a managed webhook',
	},
	{
		name: 'Retrieve Managed Webhook Seal',
		value: 'retrieveWebhookSeal',
		description: 'Retrieve a pending webhook attempt and verify it when sealed',
		action: 'Retrieve a managed webhook seal',
	},
	{
		name: 'Verify Saved JSON Seal',
		value: 'verifySealEvidence',
		description: 'Verify saved receipt and key evidence without an API credential',
		action: 'Verify saved JSON seal evidence',
	},
	...LEGACY_OPERATION_OPTIONS,
];

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
	const document = await executeFunctions.helpers.httpRequestWithAuthentication.call(
		executeFunctions,
		'allowlyApi',
		{
			method: 'GET',
			url: `${API_URL}/v1/workspaces/${encodeURIComponent(expectedWorkspaceId)}/keys`,
			json: true,
		},
	);
	return trustedKeysFromDocument(
		document,
		executeFunctions,
		itemIndex,
		expectedWorkspaceId,
		false,
	);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLoopbackHost(hostname: string): boolean {
	return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname.toLowerCase());
}

function hasUnpairedSurrogate(value: string): boolean {
	return /[\ud800-\udfff]/.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''));
}

export function parseSealWebhookUrl(
	value: unknown,
	allowLocalDevelopmentUrl = false,
): SealWebhookEndpoint {
	if (typeof value !== 'string' || !value.trim()) {
		throw new ApplicationError('Private Webhook URL is required.');
	}

	let parsed: URL | null;
	try {
		parsed = new URL(value.trim());
	} catch {
		parsed = null;
	}
	if (parsed === null) throw new ApplicationError('Private Webhook URL is invalid.');

	if (
		parsed.pathname !== SEAL_WEBHOOK_PATH ||
		parsed.username ||
		parsed.password ||
		parsed.hash
	) {
		throw new ApplicationError(
			'Private Webhook URL must be the SEAL webhook URL copied from Allowly.',
		);
	}
	if (
		parsed.origin !== API_URL &&
		!(
			allowLocalDevelopmentUrl &&
			['http:', 'https:'].includes(parsed.protocol) &&
			isLoopbackHost(parsed.hostname)
		)
	) {
		throw new ApplicationError('Private Webhook URL must use Allowly.');
	}

	const parameters = [...parsed.searchParams.entries()];
	if (parameters.length !== 1 || parameters[0][0] !== 'token') {
		throw new ApplicationError('Private Webhook URL must contain exactly one token.');
	}
	const token = parameters[0][1];
	const containsInvalidCharacter = [...token].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 0x20 || code === 0x7f;
	});
	if (!token || token.length > 256 || containsInvalidCharacter) {
		throw new ApplicationError('Private Webhook URL contains an invalid token.');
	}
	return { origin: parsed.origin, token };
}

function sealWebhookUrl(endpoint: SealWebhookEndpoint, path: string): string {
	const url = new URL(path, `${endpoint.origin}/`);
	url.searchParams.set('token', endpoint.token);
	return url.toString();
}

function sealWebhookRecordJson(
	input: RecordInput,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): string {
	if (input.kind === 'json') return input.value;
	const json = JSON.stringify(input.value);
	if (json === undefined) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'JSON Record must be serializable as JSON.',
			{ itemIndex },
		);
	}
	return json;
}

function sealWebhookWaitSeconds(
	value: unknown,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): number {
	const seconds = Number(value);
	if (!Number.isInteger(seconds) || seconds < 0 || seconds > 300) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Wait for Signature must be a whole number from 0 to 300 seconds.',
			{ itemIndex },
		);
	}
	return seconds;
}

function sealWebhookIdempotencyKey(
	value: unknown,
	fallback: string,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): string {
	const key = value === undefined || value === null || value === '' ? fallback : String(value);
	if (key.length > 128 || /[^\x21-\x7e]/.test(key)) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Idempotency Key must use 1-128 visible ASCII characters without spaces.',
			{ itemIndex },
		);
	}
	return key;
}

function sealWebhookDetailHeaders(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): IDataObject {
	const headers: IDataObject = {};
	for (const [parameter, header, label] of SEAL_WEBHOOK_DETAIL_PARAMETERS) {
		const value = executeFunctions.getNodeParameter(parameter, itemIndex);
		if (value === undefined || value === null || value === '') continue;
		if (typeof value !== 'string') {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				`${label} must be a string.`,
				{ itemIndex },
			);
		}
		if (
			value.length > 256 ||
			value !== value.trim() ||
			/[^\x20-\x7e]/.test(value)
		) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				`${label} must be at most 256 printable ASCII characters with no outer whitespace.`,
				{ itemIndex },
			);
		}
		headers[header] = value;
	}
	return headers;
}

function responseHeader(headers: Record<string, unknown>, name: string): string | null {
	const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
	if (!entry) return null;
	const value = Array.isArray(entry[1]) ? entry[1][0] : entry[1];
	return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function retryAfterSeconds(headers: Record<string, unknown>): number | null {
	const value = responseHeader(headers, 'retry-after');
	if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function safeWebhookErrorCode(body: unknown): string {
	const error = isRecord(body) ? body.error : null;
	const code = isRecord(error) ? error.code : null;
	return typeof code === 'string' && /^[a-z0-9_]{1,64}$/.test(code) ? code : 'error';
}

function parseFullHttpResponse(
	value: unknown,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): { body: unknown; headers: Record<string, unknown>; statusCode: number } {
	if (!isRecord(value)) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly SEAL webhook returned an invalid HTTP response.',
			{ itemIndex },
		);
	}
	const response = value as FullHttpResponse;
	const statusCode = Number(response.statusCode);
	if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly SEAL webhook returned an invalid HTTP status.',
			{ itemIndex },
		);
	}
	let body = response.body;
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body);
		} catch {
			body = null;
		}
	}
	return {
		body,
		headers: isRecord(response.headers) ? response.headers : {},
		statusCode,
	};
}

async function sealWebhookRequest(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	endpoint: SealWebhookEndpoint,
	path: string,
	method: 'GET' | 'POST',
	expectedStatuses: number[],
	options: { body?: Buffer; headers?: IDataObject; idempotencyKey?: string } = {},
): Promise<unknown> {
	const headers: IDataObject = { ...options.headers };
	if (method === 'POST') headers['Content-Type'] = 'application/json';
	if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

	for (let attempt = 0; attempt < 2; attempt += 1) {
		let rawResponse: unknown;
		try {
			rawResponse = await executeFunctions.helpers.httpRequest({
				method,
				url: sealWebhookUrl(endpoint, path),
				headers,
				...(options.body === undefined ? {} : { body: options.body }),
				encoding: 'text',
				json: false,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				disableFollowRedirect: true,
				sendCredentialsOnCrossOriginRedirect: false,
				timeout: SEAL_WEBHOOK_REQUEST_TIMEOUT_MS,
			});
		} catch {
			if (attempt === 0) {
				await sleep(250);
				continue;
			}
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Could not connect to Allowly SEAL. Check the private URL and retry.',
				{ itemIndex },
			);
		}

		const response = parseFullHttpResponse(rawResponse, executeFunctions, itemIndex);
		if (expectedStatuses.includes(response.statusCode)) {
			if (!isRecord(response.body)) {
				throw new NodeOperationError(
					executeFunctions.getNode(),
					'Allowly SEAL webhook returned invalid JSON.',
					{ itemIndex },
				);
			}
			return response.body;
		}

		const retryAfter = retryAfterSeconds(response.headers);
		if (
			attempt === 0 &&
			[429, 503].includes(response.statusCode) &&
			retryAfter !== null &&
			retryAfter <= SEAL_WEBHOOK_MAX_RETRY_AFTER_SECONDS
		) {
			if (retryAfter > 0) await sleep(retryAfter * 1_000);
			continue;
		}

		const code = safeWebhookErrorCode(response.body);
		const retry = retryAfter === null ? '' : ` Retry after ${retryAfter} seconds.`;
		throw new NodeOperationError(
			executeFunctions.getNode(),
			`Allowly SEAL webhook request failed (HTTP ${response.statusCode}: ${code}).${retry}`,
			{ itemIndex },
		);
	}

	throw new NodeOperationError(
		executeFunctions.getNode(),
		'Allowly SEAL webhook request failed.',
		{ itemIndex },
	);
}

function requiredWebhookString(
	value: Record<string, unknown>,
	key: string,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): string {
	const item = value[key];
	if (typeof item !== 'string' || !item) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			`Allowly SEAL webhook response is missing ${key}.`,
			{ itemIndex },
		);
	}
	return item;
}

function optionalWebhookString(
	value: Record<string, unknown>,
	key: string,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): string | null {
	const item = value[key];
	if (item === undefined || item === null) return null;
	if (typeof item !== 'string' || !item) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			`Allowly SEAL webhook response has an invalid ${key}.`,
			{ itemIndex },
		);
	}
	return item;
}

function sealWebhookMetadata(
	value: unknown,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): AllowlySealMetadata | null {
	if (value === undefined || value === null) return null;
	if (!isRecord(value) || Object.keys(value).length > 8) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly SEAL webhook response has invalid metadata.',
			{ itemIndex },
		);
	}
	const entries: Array<[string, string]> = [];
	for (const [key, item] of Object.entries(value)) {
		if (
			![...key].length ||
			[...key].length > 64 ||
			typeof item !== 'string' ||
			[...item].length > 256 ||
			key.includes('\0') ||
			item.includes('\0') ||
			hasUnpairedSurrogate(key) ||
			hasUnpairedSurrogate(item)
		) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Allowly SEAL webhook response has invalid metadata.',
				{ itemIndex },
			);
		}
		entries.push([key, item]);
	}
	return Object.fromEntries(entries);
}

function sameSealMetadata(
	left: AllowlySealMetadata | null,
	right: AllowlySealMetadata | null,
): boolean {
	if (left === null || right === null) return left === right;
	const keys = Object.keys(left);
	return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

function parseSealWebhookDelivery(
	value: unknown,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	expectedAttemptId?: string,
	expectedReceiptId?: string,
): AllowlySealWebhookDelivery {
	if (!isRecord(value)) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly SEAL webhook returned an invalid delivery.',
			{ itemIndex },
		);
	}
	const attemptId = requiredWebhookString(value, 'attempt_id', executeFunctions, itemIndex);
	const workspaceId = requiredWebhookString(value, 'workspace_id', executeFunctions, itemIndex);
	const profile = requiredWebhookString(value, 'profile', executeFunctions, itemIndex);
	const status = requiredWebhookString(value, 'status', executeFunctions, itemIndex);
	if (
		profile !== SEAL_WEBHOOK_PROFILE ||
		!['received', 'signing', 'sealed', 'rejected', 'failed'].includes(status)
	) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly SEAL webhook returned an unsupported delivery state.',
			{ itemIndex },
		);
	}
	if (expectedAttemptId !== undefined && attemptId !== expectedAttemptId) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly SEAL webhook returned a different attempt ID.',
			{ itemIndex },
		);
	}
	const receiptId = optionalWebhookString(value, 'receipt_id', executeFunctions, itemIndex);
	if (expectedReceiptId !== undefined && receiptId !== expectedReceiptId) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly SEAL webhook returned a different receipt ID.',
			{ itemIndex },
		);
	}
	let metadata = sealWebhookMetadata(value.metadata, executeFunctions, itemIndex);
	const rawReceipt = value.receipt;
	const receipt = rawReceipt === undefined || rawReceipt === null
		? null
		: isRecord(rawReceipt)
			? rawReceipt
			: undefined;
	if (receipt === undefined) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly SEAL webhook returned an invalid receipt.',
			{ itemIndex },
		);
	}
	if (
		receipt !== null &&
		(receiptId === null || receipt.receipt_id !== receiptId || receipt.workspace_id !== workspaceId)
	) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly SEAL webhook returned receipt evidence for a different delivery.',
			{ itemIndex },
		);
	}
	if (receipt !== null) {
		const context = isRecord(receipt.context) ? receipt.context : {};
		const signedMetadata = sealWebhookMetadata(
			context.seal_metadata,
			executeFunctions,
			itemIndex,
		);
		if (metadata !== null && !sameSealMetadata(metadata, signedMetadata)) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Allowly SEAL webhook returned metadata that does not match the signed receipt.',
				{ itemIndex },
			);
		}
		metadata = signedMetadata;
	}
	const errorCode = optionalWebhookString(value, 'error_code', executeFunctions, itemIndex);
	return {
		attemptId,
		workspaceId,
		status: status as AllowlySealWebhookStatus,
		receivedAt: requiredWebhookString(value, 'received_at', executeFunctions, itemIndex),
		updatedAt: requiredWebhookString(value, 'updated_at', executeFunctions, itemIndex),
		profile,
		recordSha256: optionalWebhookString(value, 'record_sha256', executeFunctions, itemIndex),
		metadata,
		receiptId,
		errorCode:
			errorCode !== null && /^[a-z0-9_]{1,64}$/.test(errorCode) ? errorCode : null,
		receipt,
	};
}

async function waitForSealWebhookDelivery(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	endpoint: SealWebhookEndpoint,
	initial: AllowlySealWebhookDelivery,
	waitSeconds: number,
): Promise<AllowlySealWebhookDelivery> {
	let current = initial;
	let receiptId = current.receiptId;
	const deadline = Date.now() + waitSeconds * 1_000;
	while (['received', 'signing'].includes(current.status) && Date.now() < deadline) {
		const previousMetadata = current.metadata;
		await sleep(Math.min(SEAL_WEBHOOK_POLL_DELAY_MS, deadline - Date.now()));
		const value = await sealWebhookRequest(
			executeFunctions,
			itemIndex,
			endpoint,
			`${SEAL_WEBHOOK_PATH}/deliveries/${encodeURIComponent(initial.attemptId)}`,
			'GET',
			[200],
		);
		current = parseSealWebhookDelivery(
			value,
			executeFunctions,
			itemIndex,
			initial.attemptId,
			receiptId ?? undefined,
		);
		if (current.workspaceId !== initial.workspaceId) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Allowly SEAL webhook changed the workspace while signing.',
				{ itemIndex },
			);
		}
		if (previousMetadata !== null && !sameSealMetadata(previousMetadata, current.metadata)) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Allowly changed SEAL receipt details while signing.',
				{ itemIndex },
			);
		}
		receiptId ??= current.receiptId;
	}
	return current;
}

function trustedKeysFromDocument(
	value: unknown,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	expectedWorkspaceId: string,
	stripPrivateUrl: boolean,
): { document: KeyDocument; keys: PublicKey[]; fingerprints: string[] } {
	if (!isRecord(value) || value.workspace_id !== expectedWorkspaceId || !Array.isArray(value.keys)) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly returned an invalid key document.',
			{ itemIndex },
		);
	}
	const document = {
		workspace_id: expectedWorkspaceId,
		...(isRecord(value.issuer) ? { issuer: value.issuer } : {}),
		keys: value.keys,
	} as KeyDocument;
	if (!stripPrivateUrl && typeof value.keys_url === 'string') {
		(document as KeyDocument & Record<string, unknown>).keys_url = value.keys_url;
	}
	let keys: PublicKey[];
	try {
		keys = sealVerifier.loadKeysFromJson(document);
	} catch {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly returned an invalid key document.',
			{ itemIndex },
		);
	}
	return {
		document,
		keys,
		fingerprints: keys.map(sealVerifier.publicKeyFingerprint),
	};
}

async function sealWebhookEvidence(
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
	endpoint: SealWebhookEndpoint,
	input: RecordInput,
	delivery: AllowlySealWebhookDelivery,
): Promise<IDataObject> {
	const inputField = (input.kind === 'json'
		? { recordJson: input.value }
		: { record: input.value }) as IDataObject;
	const common = {
		attemptId: delivery.attemptId,
		workspaceId: delivery.workspaceId,
		status: delivery.status,
		profile: delivery.profile,
		recordSha256: delivery.recordSha256,
		metadata: delivery.metadata,
		receiptId: delivery.receiptId,
		receivedAt: delivery.receivedAt,
		updatedAt: delivery.updatedAt,
		errorCode: delivery.errorCode,
		...inputField,
	};
	if (delivery.status === 'rejected' || delivery.status === 'failed') {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			`Allowly SEAL webhook ${delivery.status}: ${delivery.errorCode ?? 'seal_rejected'}.`,
			{ itemIndex },
		);
	}

	if (delivery.status !== 'sealed') {
		return {
			...common,
			sealed: false,
			pending: true,
			signatureVerified: null,
			recordMatches: null,
			receipt: null,
			keysDocument: null,
			trustedKeyFingerprints: [],
		};
	}
	if (delivery.receiptId === null || delivery.recordSha256 === null) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly returned a sealed delivery without its evidence identifiers.',
			{ itemIndex },
		);
	}

	let receipt = delivery.receipt;
	if (receipt === null) {
		const value = await sealWebhookRequest(
			executeFunctions,
			itemIndex,
			endpoint,
			`${SEAL_WEBHOOK_PATH}/receipts/${encodeURIComponent(delivery.receiptId)}`,
			'GET',
			[200],
		);
		const receiptDelivery = parseSealWebhookDelivery(
			value,
			executeFunctions,
			itemIndex,
			delivery.attemptId,
			delivery.receiptId,
		);
		if (receiptDelivery.workspaceId !== delivery.workspaceId) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Allowly returned receipt evidence for a different workspace.',
				{ itemIndex },
			);
		}
		if (delivery.metadata !== null && !sameSealMetadata(delivery.metadata, receiptDelivery.metadata)) {
			throw new NodeOperationError(
				executeFunctions.getNode(),
				'Allowly changed SEAL receipt details while retrieving evidence.',
				{ itemIndex },
			);
		}
		delivery.metadata = receiptDelivery.metadata;
		receipt = receiptDelivery.receipt;
	}
	if (receipt === null) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly did not return the signed webhook receipt.',
			{ itemIndex },
		);
	}

	const keyValue = await sealWebhookRequest(
		executeFunctions,
		itemIndex,
		endpoint,
		`${SEAL_WEBHOOK_PATH}/keys`,
		'GET',
		[200],
	);
	const trustedKeys = trustedKeysFromDocument(
		keyValue,
		executeFunctions,
		itemIndex,
		delivery.workspaceId,
		true,
	);
	const verification = await verifyRecord(
		input,
		receipt,
		trustedKeys.keys,
		delivery.workspaceId,
	);
	if (!verification.signatureVerified || !verification.recordMatches) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			`SEAL verification failed: ${verification.failureReason ?? 'unknown error'}.`,
			{ itemIndex },
		);
	}
	if (typeof receipt.issued_at !== 'string' || !receipt.issued_at) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Allowly returned a signed receipt without its recorded time.',
			{ itemIndex },
		);
	}
	return {
		...common,
		sealed: true,
		pending: false,
		signatureVerified: true,
		recordMatches: true,
		recordedAt: receipt.issued_at,
		receipt,
		keysDocument: trustedKeys.document,
		trustedKeyFingerprints: trustedKeys.fingerprints,
	};
}

export async function testSealWebhookCredential(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted<ICredentialDataDecryptedObject>,
): Promise<INodeCredentialTestResult> {
	let endpoint: SealWebhookEndpoint;
	try {
		endpoint = parseSealWebhookUrl(
			credential.data?.webhookUrl,
			credential.data?.allowLocalDevelopmentUrl === true,
		);
	} catch (error) {
		return {
			status: 'Error',
			message: error instanceof Error ? error.message : 'Private Webhook URL is invalid.',
		};
	}

	let rawResponse: unknown;
	try {
		// ICredentialTestFunctions exposes only this legacy helper in n8n 2.33.3.
		// Read it indirectly because the community-node linter otherwise suggests
		// httpRequest, which is not available in credential test contexts.
		const credentialRequest = Reflect.get(this.helpers, 'request') as ICredentialTestFunctions['helpers']['request'];
		rawResponse = await credentialRequest({
			method: 'GET',
			uri: sealWebhookUrl(endpoint, `${SEAL_WEBHOOK_PATH}/keys`),
			followRedirect: false,
			json: true,
			resolveWithFullResponse: true,
			simple: false,
			timeout: SEAL_WEBHOOK_REQUEST_TIMEOUT_MS,
		});
	} catch {
		return {
			status: 'Error',
			message: 'Could not connect to Allowly SEAL. Check the private URL and retry.',
		};
	}

	if (!isRecord(rawResponse)) {
		return { status: 'Error', message: 'SEAL webhook returned an invalid response.' };
	}
	const response = rawResponse as FullHttpResponse;
	const statusCode = Number(response.statusCode);
	if (
		statusCode === 200 &&
		isRecord(response.body) &&
		typeof response.body.workspace_id === 'string' &&
		Array.isArray(response.body.keys)
	) {
		return { status: 'OK', message: 'SEAL webhook credential is valid.' };
	}
	const headers = isRecord(response.headers) ? response.headers : {};
	const retryAfter = retryAfterSeconds(headers);
	const code = safeWebhookErrorCode(response.body);
	const retry = retryAfter === null ? '' : ` Retry after ${retryAfter} seconds.`;
	return {
		status: 'Error',
		message: `SEAL webhook credential check failed (HTTP ${statusCode || 'error'}: ${code}).${retry}`,
	};
}

export class Allowly implements INodeType {
	methods = {
		credentialTest: {
			testSealWebhookCredential,
		},
	};

	description: INodeTypeDescription = {
		displayName: 'Allowly',
		name: 'allowly',
		icon: 'file:allowly.svg',
		group: ['transform'],
		version: [1, 2],
		defaultVersion: 2,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Seal and verify JSON records, create authorizations, and check actions with Allowly.',
		defaults: {
			name: 'Allowly',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'allowlySealWebhookApi',
				required: true,
				testedBy: 'testSealWebhookCredential',
				displayOptions: {
					show: { operation: ['sealWebhook', 'retrieveWebhookSeal'] },
				},
			},
			{
				name: 'allowlyApi',
				required: true,
				displayOptions: {
					show: {
						operation: [
							'check',
							'createAuthorization',
							'resolveConfirmation',
							'resolveEscalation',
							'seal',
							'settleBudget',
							'verifySeal',
						],
					},
				},
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: LEGACY_OPERATION_OPTIONS,
				default: 'check',
				displayOptions: { show: { '@version': [1] } },
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: MANAGED_OPERATION_OPTIONS,
				default: 'sealWebhook',
				displayOptions: { show: { '@version': [2] } },
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
				displayOptions: {
					show: {
						operation: [
							'sealWebhook',
							'retrieveWebhookSeal',
							'seal',
							'verifySeal',
							'verifySealEvidence',
						],
					},
				},
			},
			{
				displayName: 'JSON Record',
				name: 'sealRecordValue',
				type: 'json',
				default: '={{$json}}',
				required: true,
				description:
					'Managed Webhook Seal sends this record to Allowly for hashing. Retrieve, Verify, and API Key operations compare or hash it inside n8n.',
				displayOptions: {
					show: {
						operation: [
							'sealWebhook',
							'retrieveWebhookSeal',
							'seal',
							'verifySeal',
							'verifySealEvidence',
						],
						sealRecordInputMode: ['value'],
					},
				},
			},
			{
				displayName: 'Raw JSON Text',
				name: 'sealRecordJson',
				type: 'string',
				typeOptions: { rows: 8 },
				default: '',
				required: true,
				description:
					'Managed Webhook Seal sends this exact JSON text to Allowly for hashing. Retrieve, Verify, and API Key operations compare or hash it inside n8n.',
				displayOptions: {
					show: {
						operation: [
							'sealWebhook',
							'retrieveWebhookSeal',
							'seal',
							'verifySeal',
							'verifySealEvidence',
						],
						sealRecordInputMode: ['rawJson'],
					},
				},
			},
			{
				displayName: 'Type',
				name: 'sealWebhookType',
				type: 'string',
				default: '',
				description: 'Optional printable ASCII record type copied into the signed receipt, for example invoice',
				displayOptions: { show: { operation: ['sealWebhook'] } },
			},
			{
				displayName: 'Reference',
				name: 'sealWebhookReference',
				type: 'string',
				default: '',
				description: 'Optional printable ASCII customer reference copied into the signed receipt and available for exact search',
				displayOptions: { show: { operation: ['sealWebhook'] } },
			},
			{
				displayName: 'Statement',
				name: 'sealWebhookStatement',
				type: 'string',
				default: '',
				description: 'Optional printable ASCII customer statement copied into the signed receipt',
				displayOptions: { show: { operation: ['sealWebhook'] } },
			},
			{
				displayName: 'Idempotency Key',
				name: 'sealWebhookIdempotencyKey',
				type: 'string',
				default: '',
				description:
					'Optional stable sender event ID. Defaults to this n8n execution, node, and item. Reuse it only for the same JSON and receipt details.',
				displayOptions: { show: { operation: ['sealWebhook'] } },
			},
			{
				displayName: 'Attempt ID',
				name: 'sealWebhookAttemptId',
				type: 'string',
				default: '={{$json.attemptId}}',
				required: true,
				description: 'Attempt ID returned by an earlier managed webhook seal',
				displayOptions: { show: { operation: ['retrieveWebhookSeal'] } },
			},
			{
				displayName: 'Wait for Signature',
				name: 'sealWebhookWaitSeconds',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 300 },
				default: 120,
				description:
					'Maximum seconds to poll for a signed receipt. A timeout returns pending with an Attempt ID.',
				displayOptions: {
					show: { operation: ['sealWebhook', 'retrieveWebhookSeal'] },
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
				displayOptions: { show: { operation: ['verifySeal', 'verifySealEvidence'] } },
			},
			{
				displayName: 'Expected Workspace ID',
				name: 'sealExpectedWorkspaceId',
				type: 'string',
				default: '',
				required: true,
				description: 'Trusted workspace ID saved from the authenticated sealing workflow',
				displayOptions: { show: { operation: ['verifySeal', 'verifySealEvidence'] } },
			},
			{
				displayName: 'Saved Key Document',
				name: 'sealKeysDocument',
				type: 'json',
				default: '={{$json.keysDocument}}',
				required: true,
				description: 'Trusted key document saved with the receipt evidence',
				displayOptions: { show: { operation: ['verifySealEvidence'] } },
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
				const operation = this.getNodeParameter('operation', itemIndex) as string;
				const idempotencyKey = n8nIdempotencyKey(
					this.getExecutionId(),
					this.getNode().name,
					itemIndex,
				);

				if (operation === 'sealWebhook' || operation === 'retrieveWebhookSeal') {
					const credentials = await this.getCredentials(SEAL_WEBHOOK_CREDENTIAL, itemIndex);
					let endpoint: SealWebhookEndpoint;
					try {
						endpoint = parseSealWebhookUrl(
							credentials.webhookUrl,
							credentials.allowLocalDevelopmentUrl === true,
						);
					} catch (error) {
						throw new NodeOperationError(
							this.getNode(),
							error instanceof Error ? error.message : 'Private Webhook URL is invalid.',
							{ itemIndex },
						);
					}
					const input = recordInput(this, itemIndex);
					const waitSeconds = sealWebhookWaitSeconds(
						this.getNodeParameter('sealWebhookWaitSeconds', itemIndex),
						this,
						itemIndex,
					);

					let delivery: AllowlySealWebhookDelivery;
					if (operation === 'sealWebhook') {
						const detailHeaders = sealWebhookDetailHeaders(this, itemIndex);
						const senderId = sealWebhookIdempotencyKey(
							this.getNodeParameter('sealWebhookIdempotencyKey', itemIndex),
							idempotencyKey,
							this,
							itemIndex,
						);
						const value = await sealWebhookRequest(
							this,
							itemIndex,
							endpoint,
							SEAL_WEBHOOK_PATH,
							'POST',
							[200, 202],
							{
								body: Buffer.from(sealWebhookRecordJson(input, this, itemIndex), 'utf8'),
								headers: detailHeaders,
								idempotencyKey: senderId,
							},
						);
						delivery = parseSealWebhookDelivery(value, this, itemIndex);
					} else {
						const attemptId = (
							this.getNodeParameter('sealWebhookAttemptId', itemIndex) as string
						).trim();
						if (!/^swd_[A-Za-z0-9_-]{1,128}$/.test(attemptId)) {
							throw new NodeOperationError(this.getNode(), 'Attempt ID is invalid.', {
								itemIndex,
							});
						}
						const value = await sealWebhookRequest(
							this,
							itemIndex,
							endpoint,
							`${SEAL_WEBHOOK_PATH}/deliveries/${encodeURIComponent(attemptId)}`,
							'GET',
							[200],
						);
						delivery = parseSealWebhookDelivery(value, this, itemIndex, attemptId);
					}
					delivery = await waitForSealWebhookDelivery(
						this,
						itemIndex,
						endpoint,
						delivery,
						waitSeconds,
					);
					returnData.push({
						json: await sealWebhookEvidence(this, itemIndex, endpoint, input, delivery),
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (operation === 'verifySealEvidence') {
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
					const receipt = signedReceipt(envelope);
					if (receipt === null) {
						throw new NodeOperationError(
							this.getNode(),
							'Saved receipt evidence must contain a signed receipt.',
							{ itemIndex },
						);
					}
					let keyValue = this.getNodeParameter('sealKeysDocument', itemIndex);
					if (typeof keyValue === 'string') {
						try {
							keyValue = JSON.parse(keyValue);
						} catch {
							throw new NodeOperationError(this.getNode(), 'Saved Key Document is invalid JSON.', {
								itemIndex,
							});
						}
					}
					const trustedKeys = trustedKeysFromDocument(
						keyValue,
						this,
						itemIndex,
						expectedWorkspaceId,
						true,
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
							verified: true,
							signatureVerified: true,
							recordMatches: true,
							failureReason: null,
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

				const credentials = await this.getCredentials('allowlyApi', itemIndex);

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
