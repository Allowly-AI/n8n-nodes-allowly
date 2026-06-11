import { createHash, createHmac } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { ApplicationError, NodeOperationError } from 'n8n-workflow';

type AllowlyCheckResponse = {
	authorization_id?: string;
	results?: Record<string, AllowlyScopeResult>;
	[key: string]: unknown;
};

type AllowlyAuthorizationResponse = {
	authorization_id?: string;
	authorizationId?: string;
	receipt?: unknown;
	[key: string]: unknown;
};

type AllowlyScopeResult = {
	decision?: string;
	reason?: string;
	receipt?: unknown;
	policy_eval?: Record<string, unknown> | null;
	[key: string]: unknown;
};

type AllowlyAgentPolicy = {
	policy_id?: string;
	agent_id?: string;
	actions?: Array<{ name?: string }>;
	requires_confirm_for?: string[];
	requires_escalation_for?: string[];
	default_expiry_days?: number | null;
	description?: string | null;
	[key: string]: unknown;
};

type AllowlyAgentPolicyListResponse = {
	items?: AllowlyAgentPolicy[];
	[key: string]: unknown;
};

type CachedPolicyOptions = {
	expiresAt: number;
	options: INodePropertyOptions[];
};

const POLICY_OPTIONS_CACHE_TTL_MS = 60_000;
const POLICY_OPTIONS_CACHE_MAX_ENTRIES = 100;
const policyOptionsCache = new Map<string, CachedPolicyOptions>();
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

function parseScopes(value: string): string[] {
	return Array.from(
		new Set(
			value
				.split(/[\n,]/)
				.map((scope) => scope.trim())
				.filter(Boolean),
		),
	);
}

function userIdFromEmail(email: string, pepper: string): string {
	const normalized = email.trim().toLowerCase();
	const digest = createHmac('sha256', pepper).update(normalized).digest('base64url');
	return `email_hmac:v1:${digest}`;
}

function policyOptionsCacheKey(apiUrl: string, apiKey: string): string {
	const keyHash = createHash('sha256').update(apiKey).digest('base64url').slice(0, 32);
	return `${apiUrl}:${keyHash}`;
}

function getCachedPolicyOptions(cacheKey: string): INodePropertyOptions[] | null {
	const cached = policyOptionsCache.get(cacheKey);
	if (!cached) return null;
	if (cached.expiresAt <= Date.now()) {
		policyOptionsCache.delete(cacheKey);
		return null;
	}
	return cached.options;
}

function setCachedPolicyOptions(cacheKey: string, options: INodePropertyOptions[]): void {
	if (policyOptionsCache.size >= POLICY_OPTIONS_CACHE_MAX_ENTRIES) {
		const oldestKey = policyOptionsCache.keys().next().value;
		if (oldestKey) policyOptionsCache.delete(oldestKey);
	}
	policyOptionsCache.set(cacheKey, {
		expiresAt: Date.now() + POLICY_OPTIONS_CACHE_TTL_MS,
		options,
	});
}

function policyOptionDescription(policy: AllowlyAgentPolicy): string {
	const parts: string[] = [];
	const actions = Array.isArray(policy.actions) ? policy.actions : [];
	const actionNames = actions
		.map((action) => action.name)
		.filter((name): name is string => Boolean(name));

	if (policy.description) parts.push(policy.description);
	if (actionNames.length > 0) {
		parts.push(`${actionNames.length} action${actionNames.length === 1 ? '' : 's'}: ${actionNames.slice(0, 4).join(', ')}`);
	}
	if (policy.requires_confirm_for?.length) parts.push(`confirm: ${policy.requires_confirm_for.join(', ')}`);
	if (policy.requires_escalation_for?.length) parts.push(`escalate: ${policy.requires_escalation_for.join(', ')}`);
	if (policy.default_expiry_days) parts.push(`expires in ${policy.default_expiry_days}d`);

	return parts.join(' · ');
}

function httpStatusCode(error: unknown): number | undefined {
	if (!error || typeof error !== 'object') return undefined;

	const err = error as {
		status?: unknown;
		statusCode?: unknown;
		response?: {
			status?: unknown;
			statusCode?: unknown;
		};
	};
	const candidates = [err.statusCode, err.status, err.response?.statusCode, err.response?.status];
	for (const candidate of candidates) {
		if (typeof candidate === 'number') return candidate;
		if (typeof candidate === 'string') {
			const parsed = Number(candidate);
			if (Number.isInteger(parsed)) return parsed;
		}
	}

	return undefined;
}

function parseContext(value: string, executeFunctions: IExecuteFunctions, itemIndex: number): Record<string, unknown> {
	if (!value.trim()) return {};

	try {
		const parsed: unknown = JSON.parse(value);
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

export class Allowly implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Allowly',
		name: 'allowly',
		icon: 'file:allowly.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Create Allowly authorizations and check whether they permit AI-agent or tool actions.',
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
				],
				default: 'check',
			},
			{
				displayName: 'Policy Name or ID',
				name: 'policyId',
				type: 'options',
				default: '',
				options: [],
				typeOptions: {
					loadOptionsMethod: 'getAgentPolicies',
				},
				required: true,
				description: 'Allowly agent policy to authorize for this user. Loaded from the selected API credential workspace. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
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
					'Stored Allowly authorization ID. The authorization already binds the user, agent, and scopes.',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Action(s)',
				name: 'scopes',
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
					'Optional estimated action cost in micro-USD for budgeted authorizations. Set to 0 to omit.',
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
		],
		usableAsTool: true,
	};

	methods = {
		loadOptions: {
			async getAgentPolicies(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const credentials = await this.getCredentials('allowlyApi');
				const apiKey = String(credentials.apiKey ?? '');
				const apiUrl = normalizeApiUrl(credentials.apiUrl);
				const cacheKey = policyOptionsCacheKey(apiUrl, apiKey);
				const cachedOptions = getCachedPolicyOptions(cacheKey);
				if (cachedOptions) return cachedOptions;

				const options: IHttpRequestOptions = {
					method: 'GET',
					url: `${apiUrl}/v1/policies?limit=100`,
					json: true,
				};

				try {
					const response = (await this.helpers.httpRequestWithAuthentication.call(
						this,
						'allowlyApi',
						options,
					)) as AllowlyAgentPolicyListResponse;
					const policies = response.items ?? [];
					const policyOptions: INodePropertyOptions[] = [];

					for (const policy of policies) {
						const id = String(policy.policy_id ?? '').trim();
						if (!id) continue;
						const agentId = String(policy.agent_id ?? '').trim();

						policyOptions.push({
							name: agentId ? `${id} (${agentId})` : id,
							value: id,
							description: policyOptionDescription(policy),
						});
					}

					setCachedPolicyOptions(cacheKey, policyOptions);
					return policyOptions;
				} catch (error) {
					if (httpStatusCode(error) === 429) {
						throw new NodeOperationError(
							this.getNode(),
							'Could not load Allowly agent policies: rate limit reached. Wait a moment, then reload the Policy options.',
						);
					}

					throw new NodeOperationError(
						this.getNode(),
						`Could not load Allowly agent policies: ${(error as Error).message}. The selected credential must be able to call GET /v1/policies.`,
					);
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
			try {
				const credentials = await this.getCredentials('allowlyApi', itemIndex);
				const apiUrl = normalizeApiUrl(credentials.apiUrl);
				const operation = this.getNodeParameter('operation', itemIndex) as string;

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
							authorizationId: response.authorization_id ?? response.authorizationId,
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

				const authorizationId = this.getNodeParameter('authorization', itemIndex) as string;
				const scopes = parseScopes(this.getNodeParameter('scopes', itemIndex) as string);
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const sessionId = this.getNodeParameter('session', itemIndex) as string;
				const estimatedCostMicros = this.getNodeParameter('estimatedCostMicros', itemIndex) as number;
				const workflowUserId = this.getNodeParameter('workflowUser', itemIndex) as string;
				const workflowAgentId = this.getNodeParameter('workflowAgent', itemIndex) as string;
				const context = parseContext(this.getNodeParameter('contextJson', itemIndex) as string, this, itemIndex);

				if (scopes.length === 0) {
					throw new NodeOperationError(this.getNode(), 'At least one scope is required.', { itemIndex });
				}

				if (workflowUserId.trim()) context.workflow_user_id = workflowUserId.trim();
				if (workflowAgentId.trim()) context.workflow_agent_id = workflowAgentId.trim();

				const body: Record<string, unknown> = {
					authorization_id: authorizationId,
					scopes,
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
					},
					body,
					json: true,
				};

				const response = (await this.helpers.httpRequestWithAuthentication.call(
					this,
					'allowlyApi',
					options,
				)) as AllowlyCheckResponse;
				const firstScope = scopes[0];
				const firstResult = response.results?.[firstScope] ?? {};

				returnData.push({
					json: {
						scope: firstScope,
						decision: firstResult.decision,
						reason: firstResult.reason,
						receipt: firstResult.receipt,
						policyEval: firstResult.policy_eval ?? null,
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
							error: (error as Error).message,
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
