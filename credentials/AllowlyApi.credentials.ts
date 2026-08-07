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
	];
}
