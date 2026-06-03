import type { ICredentialType, INodeProperties } from 'n8n-workflow';

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

	test = {
		request: {
			method: 'GET' as const,
			url: '={{$credentials.apiUrl.replace(/\\/+$/, "") + "/v1/agent-scope-bundles?limit=1"}}',
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
			displayName: 'API URL',
			name: 'apiUrl',
			type: 'string',
			default: 'https://api.allowly.ai',
			required: true,
			description: 'Allowly API base URL.',
		},
	];
}
