import { createHmac } from 'crypto';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

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
	[key: string]: unknown;
};

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

function parseContext(value: string, executeFunctions: IExecuteFunctions, itemIndex: number): Record<string, unknown> {
	if (!value.trim()) return {};

	try {
		const parsed: unknown = JSON.parse(value);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Context JSON must be an object.');
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
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
		icon: 'fa:shield-alt',
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
						description: 'Create an authorization from a user ID and agent scope bundle',
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
				displayName: 'Bundle ID',
				name: 'bundleId',
				type: 'string',
				default: '',
				required: true,
				description: 'Allowly agent scope bundle ID to authorize for this user.',
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
				description: 'Choose how the Allowly user_id is produced.',
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
				displayName: 'Authorization ID',
				name: 'authorizationId',
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
				displayName: 'Scope(s)',
				name: 'scopes',
				type: 'string',
				default: '',
				required: true,
				description: 'One scope, or multiple scopes separated by commas or new lines.',
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
				description: 'Optional target resource for the action, for example gmail:thread:abc123.',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description: 'Optional workflow or agent-session identifier copied into the signed receipt.',
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
				displayName: 'Workflow User ID',
				name: 'workflowUserId',
				type: 'string',
				default: '',
				description:
					'Optional n8n workflow context value. Authorization is still determined by Authorization ID.',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
			{
				displayName: 'Workflow Agent ID',
				name: 'workflowAgentId',
				type: 'string',
				default: '',
				description:
					'Optional n8n workflow context value. Authorization is still determined by Authorization ID.',
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
				description: 'Optional JSON object copied into the Allowly check context and receipt.',
				displayOptions: {
					show: {
						operation: ['check'],
					},
				},
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
			try {
				const credentials = await this.getCredentials('allowlyApi', itemIndex);
				const apiKey = String(credentials.apiKey ?? '');
				const apiUrl = String(credentials.apiUrl ?? 'https://api.allowly.ai').replace(/\/+$/, '');
				const operation = this.getNodeParameter('operation', itemIndex) as string;

				if (operation === 'createAuthorization') {
					const bundleId = (this.getNodeParameter('bundleId', itemIndex) as string).trim();
					const userIdentifierMode = this.getNodeParameter('userIdentifierMode', itemIndex) as string;
					let userId: string;

					if (!bundleId) {
						throw new NodeOperationError(this.getNode(), 'Bundle ID is required.', { itemIndex });
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
							Authorization: `Bearer ${apiKey}`,
							'Content-Type': 'application/json',
						},
						body: {
							user_id: userId,
							bundle_id: bundleId,
						},
						json: true,
					};

					const response = (await this.helpers.httpRequest(options)) as AllowlyAuthorizationResponse;
					returnData.push({
						json: {
							authorizationId: response.authorization_id ?? response.authorizationId,
							userId,
							bundleId,
							receipt: response.receipt,
							response,
						} as IDataObject,
						pairedItem: {
							item: itemIndex,
						},
					});
					continue;
				}

				const authorizationId = this.getNodeParameter('authorizationId', itemIndex) as string;
				const scopes = parseScopes(this.getNodeParameter('scopes', itemIndex) as string);
				const resource = this.getNodeParameter('resource', itemIndex) as string;
				const sessionId = this.getNodeParameter('sessionId', itemIndex) as string;
				const estimatedCostMicros = this.getNodeParameter('estimatedCostMicros', itemIndex) as number;
				const workflowUserId = this.getNodeParameter('workflowUserId', itemIndex) as string;
				const workflowAgentId = this.getNodeParameter('workflowAgentId', itemIndex) as string;
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
						Authorization: `Bearer ${apiKey}`,
						'Content-Type': 'application/json',
					},
					body,
					json: true,
				};

				const response = (await this.helpers.httpRequest(options)) as AllowlyCheckResponse;
				const firstScope = scopes[0];
				const firstResult = response.results?.[firstScope] ?? {};

				returnData.push({
					json: {
						scope: firstScope,
						decision: firstResult.decision,
						reason: firstResult.reason,
						receipt: firstResult.receipt,
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
