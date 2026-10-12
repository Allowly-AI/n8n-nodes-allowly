type Sdk = typeof import('@allowly/sdk', { with: { 'resolution-mode': 'import' } });
export declare const Allowly: Sdk['Allowly'];
export declare const AllowlyAPIError: Sdk['AllowlyAPIError'];
export declare const verifyResolutionWebhook: Sdk['verifyResolutionWebhook'];
export declare const commitCustomerHttpRequest: Sdk['commitCustomerHttpRequest'];
export declare const hashSealValue: Sdk['hashSealValue'];
