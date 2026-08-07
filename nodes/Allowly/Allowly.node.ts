import { createHash, createHmac } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

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

const DECISION_ORDER: Record<string, number> = { allow: 0, confirm: 1, escalate: 2, deny: 3 };

const API_URL = 'https://api.allowly.ai';

const MAX_SAFE_INTEGER = 2 ** 53 - 1;

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
		description: 'Create authorizations, check actions, and settle budget estimates with Allowly.',
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
						name: 'Settle Budget',
						value: 'settleBudget',
						description: 'Report the actual cost of a budgeted check',
						action: 'Settle a budget estimate',
					},
				],
				default: 'check',
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
