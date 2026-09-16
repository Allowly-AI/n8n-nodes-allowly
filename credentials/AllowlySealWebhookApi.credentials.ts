import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class AllowlySealWebhookApi implements ICredentialType {
	name = 'allowlySealWebhookApi';

	displayName = 'Allowly SEAL Webhook API';

	icon = 'file:allowly.svg' as const;

	documentationUrl = 'https://allowly.ai/docs/sdk/n8n/';

	properties: INodeProperties[] = [
		{
			displayName: 'Private Webhook URL',
			name: 'webhookUrl',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description: 'Private URL copied from SEAL. Treat it like a password.',
		},
		{
			displayName: 'Allow Local Development URL',
			name: 'allowLocalDevelopmentUrl',
			type: 'boolean',
			default: false,
			description:
				'Whether to allow a localhost private URL for local development. Keep this disabled for hosted Allowly.',
		},
	];
}
