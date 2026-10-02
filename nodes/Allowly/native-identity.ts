import { createPrivateKey, createPublicKey, sign } from 'crypto';

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keyBytes(value: unknown): value is string {
	return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
		&& Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function nativeCredentialSecrets(value: unknown): string[] {
	if (typeof value !== 'string' || !value) return [];
	const secrets = [value];
	try {
		const credential: unknown = JSON.parse(value);
		if (object(credential) && object(credential.private_key_jwk)) {
			secrets.push(JSON.stringify(credential.private_key_jwk));
			if (typeof credential.private_key_jwk.d === 'string' && credential.private_key_jwk.d) {
				secrets.push(credential.private_key_jwk.d);
			}
		}
	} catch {
		// Invalid JSON is rejected with a fixed message before a request is sent.
	}
	return secrets;
}

export function nativeAgentToken(
	value: unknown,
	now = Math.floor(Date.now() / 1_000),
): string | null {
	try {
		if (typeof value !== 'string' || !value.trim()) return null;
		const credential: unknown = JSON.parse(value);
		if (!object(credential) || credential.version !== 1 || credential.provider !== 'allowly') {
			return null;
		}
		for (const field of ['workspace_id', 'agent_id', 'binding_id', 'key_id']) {
			const id = credential[field];
			if (typeof id !== 'string' || !id || id !== id.trim() || id.length > 128 || /[\r\n]/.test(id)) {
				return null;
			}
		}
		if (!/^[A-Za-z0-9_-]+$/.test(credential.binding_id as string)
			|| !/^[A-Za-z0-9_-]+$/.test(credential.key_id as string)) return null;
		const jwk = credential.private_key_jwk;
		if (!object(jwk) || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519'
			|| !keyBytes(jwk.x) || !keyBytes(jwk.d)) return null;
		if (!Number.isSafeInteger(now) || now < 0) return null;
		const privateKey = createPrivateKey({
			key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d },
			format: 'jwk',
		});
		if (createPublicKey(privateKey).export({ format: 'jwk' }).x !== jwk.x) return null;
		const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: credential.key_id }))
			.toString('base64url');
		const payload = Buffer.from(JSON.stringify({
			iss: 'allowly-agent',
			aud: credential.workspace_id,
			sub: credential.agent_id,
			bid: credential.binding_id,
			iat: now,
			nbf: now,
			exp: now + 60,
		})).toString('base64url');
		const input = `${header}.${payload}`;
		return `${input}.${sign(null, Buffer.from(input, 'ascii'), privateKey).toString('base64url')}`;
	} catch {
		return null;
	}
}
