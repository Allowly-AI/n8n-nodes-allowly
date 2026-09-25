import type { ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class AllowlyApi implements ICredentialType {
	name = 'allowlyApi';

	displayName = 'Allowly API';

	icon = 'file:allowly.svg' as const;

	documentationUrl = 'https://allowly.ai/docs';

	authenticate = {
		type: 'generic' as const,
		properties: {
			headers: {
				Authorization: '={{"Bearer " + $credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			method: 'GET' as const,
			url: 'https://api.allowly.ai/v1/authorizations?limit=1',
		},
	};

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description: 'Allowly API key. Keep it server-side and do not expose it in browser workflows.',
		},
		{
			displayName: 'User ID Pepper',
			name: 'userIdPepper',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			description:
				'Optional stable secret for Mask Email Locally. Back it up; changing it changes derived user IDs.',
		},
		{
			displayName: 'Agent Identity',
			name: 'identityMode',
			type: 'options',
			options: [
				{
					name: 'API Key Only',
					value: 'apiKeyOnly',
					description: 'Use for authorizations without an Auth0 agent identity binding',
				},
				{
					name: 'Auth0 Machine-to-Machine',
					value: 'auth0M2M',
					description: 'Acquire a short-lived agent token from the customer Auth0 tenant',
				},
			],
			default: 'apiKeyOnly',
		},
		{
			displayName: 'Auth0 Issuer',
			name: 'auth0Issuer',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://customer.us.auth0.com/',
			description: 'Exact HTTPS issuer configured in Allowly, including the trailing slash',
			displayOptions: { show: { identityMode: ['auth0M2M'] } },
		},
		{
			displayName: 'Auth0 Audience',
			name: 'auth0Audience',
			type: 'string',
			default: '',
			required: true,
			description: 'API audience configured for this agent in Auth0 and Allowly',
			displayOptions: { show: { identityMode: ['auth0M2M'] } },
		},
		{
			displayName: 'Auth0 Client ID',
			name: 'auth0ClientId',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Machine-to-machine application client ID',
			displayOptions: { show: { identityMode: ['auth0M2M'] } },
		},
		{
			displayName: 'Auth0 Client Secret',
			name: 'auth0ClientSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Machine-to-machine application secret. It stays in n8n credential storage.',
			displayOptions: { show: { identityMode: ['auth0M2M'] } },
		},
	];
}
