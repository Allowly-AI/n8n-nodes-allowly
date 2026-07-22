import { createHash, createHmac } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ApplicationError, NodeOperationError } from 'n8n-workflow';

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
	[key: string]: unknown;
};

const DECISION_ORDER: Record<string, number> = { allow: 0, confirm: 1, escalate: 2, deny: 3 };

const DEFAULT_API_URL = 'https://api.allowly.ai';

function normalizeApiUrl(value: unknown): string {
	const raw = String(value ?? DEFAULT_API_URL).trim();
	if (!raw) return DEFAULT_API_URL;

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new ApplicationError('API URL must be a valid absolute URL.');
	}

	if (!['https:', 'http:'].includes(parsed.protocol)) {
		throw new ApplicationError('API URL must use http or https.');
	}
	if (!parsed.hostname) {
		throw new ApplicationError('API URL must include a hostname.');
	}
	if (parsed.username || parsed.password) {
		throw new ApplicationError('API URL must not include embedded credentials.');
	}
	if (parsed.pathname && parsed.pathname !== '/') {
		throw new ApplicationError('API URL must be a base origin without a path.');
	}
	if (parsed.search || parsed.hash) {
		throw new ApplicationError('API URL must not include query strings or fragments.');
	}

	return `${parsed.protocol}//${parsed.host}`;
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

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new NodeOperationError(executeFunctions.getNode(), 'Context JSON must be an object', { itemIndex });
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (error instanceof NodeOperationError) throw error;

		throw new NodeOperationError(
			executeFunctions.getNode(),
			`Context JSON is invalid: ${(error as Error).message}`,
			{ itemIndex },
		);
	}
}

export function parseEstimatedCostMicros(
	value: unknown,
	executeFunctions: IExecuteFunctions,
	itemIndex: number,
): number {
	const cost = Number(value);
	if (!Number.isFinite(cost) || cost < 0) {
		throw new NodeOperationError(
			executeFunctions.getNode(),
			'Estimated Cost Micros must be a non-negative number.',
			{ itemIndex },
		);
	}
	return Math.round(cost);
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
		inputs: ['main'],
		outputs: ['main'],
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
						name: 'Create Authorization',
						value: 'createAuthorization',
						description: 'Create an authorization from a user ID and agent policy',
						action: 'Create an authorization',
					},
					{
						name: 'Check',
						value: 'check',
						description: 'Call /v1/check before a tool or agent action runs',
						action: 'Check an authorization',
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
						name: 'Opaque User ID',
						value: 'opaque',
						description: 'Use an internal app user ID or pre-derived Allowly-safe user ID',
					},
					{
						name: 'Mask Email Locally',
						value: 'emailHmac',
						description: 'Derive email_hmac:v1 locally with a pepper before sending to Allowly',
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
				displayName: 'User ID Pepper',
				name: 'userIdPepper',
				type: 'string',
				typeOptions: {
					password: true,
				},
				default: '',
				required: true,
				description:
					'Stable app-held secret for email HMAC. Back it up; changing it changes derived user IDs.',
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
				default: 0,
				description:
					'Optional estimated action cost in micro-USD for budgeted authorizations. Set to 0 to omit. Reserved amounts stay charged until a Settle Budget step reports the actual cost.',
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
				description: 'Optional replay key. Defaults to the n8n execution ID.',
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
				const apiUrl = normalizeApiUrl(credentials.apiUrl);
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
						const userIdPepper = this.getNodeParameter('userIdPepper', itemIndex) as string;

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
						url: `${apiUrl}/v1/authorizations`,
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
					).trim() || this.getExecutionId();

					if (!checkReceiptId) {
						throw new NodeOperationError(this.getNode(), 'Check Receipt ID is required.', { itemIndex });
					}
					if (!Number.isInteger(actualCostMicros) || actualCostMicros < 0) {
						throw new NodeOperationError(
							this.getNode(),
							'Actual Cost (micro-USD) must be a non-negative integer.',
							{ itemIndex },
						);
					}

					const response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'allowlyApi',
						{
							method: 'POST',
							url: `${apiUrl}/v1/budget-settlements`,
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

				if (workflowUserId.trim()) context.workflow_user_id = workflowUserId.trim();
				if (workflowAgentId.trim()) context.workflow_agent_id = workflowAgentId.trim();

				const body: Record<string, unknown> = {
					authorization_id: authorizationId,
					actions,
				};
				if (resource.trim()) body.resource = resource.trim();
				if (sessionId.trim()) body.session_id = sessionId.trim();
				if (estimatedCostMicros > 0) body.estimated_cost_micros = estimatedCostMicros;
				if (Object.keys(context).length > 0) body.context = context;

				const options: IHttpRequestOptions = {
					method: 'POST',
					url: `${apiUrl}/v1/check`,
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

				throw error;
			}
		}

		return [returnData];
	}
}
