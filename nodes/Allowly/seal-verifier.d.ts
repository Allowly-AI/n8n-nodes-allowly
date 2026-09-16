export type KeyDocument = {
	workspace_id: string;
	keys: unknown[];
};

export type PublicKey = {
	keyId: string;
	publicKeyBytes: Uint8Array;
	activeFrom: Date;
	activeUntil: Date | null;
};

export type SealVerificationResult = {
	signatureVerified: boolean;
	recordMatches: boolean;
	failureReason: string | null;
};

export const SEAL_PROFILE: string;
export function hashSealJson(rawJson: string | Uint8Array): string;
export function hashSealValue(record: unknown): string;
export function verifySealJson(
	rawJson: string | Uint8Array,
	receipt: Record<string, unknown>,
	publicKeys: PublicKey[],
	options: { expectedWorkspaceId: string },
): Promise<SealVerificationResult>;
export function verifySealValue(
	record: unknown,
	receipt: Record<string, unknown>,
	publicKeys: PublicKey[],
	options: { expectedWorkspaceId: string },
): Promise<SealVerificationResult>;
export function loadKeysFromJson(document: KeyDocument): PublicKey[];
export function publicKeyFingerprint(key: PublicKey): string;
