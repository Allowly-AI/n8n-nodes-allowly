# n8n-nodes-allowly

Community n8n node for Allowly.

Use it to seal and verify JSON records, or to authorize and check an AI-agent, tool, or automation step. SEAL hashes the record inside n8n, sends only the fingerprint and optional short metadata to Allowly, waits for the signer, and verifies the signed receipt before it reports success.

## Install in n8n

After publishing to npm:

1. Open n8n.
2. Go to **Settings -> Community Nodes**.
3. Install:

```text
n8n-nodes-allowly
```

No n8n marketplace approval is needed for this first path. npm publication is enough for self-service community-node installation.

## Operations

### Seal JSON Record

Choose **Parsed Value** for ordinary n8n objects or **Raw JSON Text** when you still have the original JSON text. Raw mode checks duplicate decoded keys, malformed Unicode, number overflow, underflow, and precision loss before parsing. Parsed values have already lost duplicate keys and original number spelling.

The node applies the versioned `allowly.seal.jcs-sha256.v1` profile: RFC 8785 JSON Canonicalization Scheme (JCS), then SHA-256. It calls:

```http
POST /v1/seal
Authorization: Bearer allowly_l1_s001_...
```

```json
{
  "request_id": "n8n:...",
  "profile": "allowly.seal.jcs-sha256.v1",
  "record_sha256": "64-lowercase-hex-characters",
  "metadata": {
    "source": "n8n"
  }
}
```

The original record is not in this request. The operation polls Allowly's fixed receipt endpoint while signing is pending. It reports `sealed: true` only after stock wire-4 signature verification and SEAL-specific record, workspace, action, decision, profile, and identity checks all pass. A seal records that Allowly authorized and signed this fingerprint at its recorded `issued_at` time. It does not prove an external action happened or independently prove the time.

No policy or authorization setup is required. One seal uses one decision from the workspace's existing allowance. The Free plan currently includes 1,000 lifetime decisions.

### Verify JSON Seal

Supply the original JSON, the full signed receipt, and the expected workspace ID retained from the authenticated sealing run. The node obtains that workspace's keys from the fixed Allowly API origin. It returns a verified result only when both the signature and record match. A changed record raises `SEAL verification failed: record_mismatch`.

Keep the original JSON, full receipt, workspace ID, key document, and trusted key fingerprints together. Hosted receipt and key availability is not permanent; the evidence can be verified offline later with retained trusted key material.

### Create Authorization

Creates an authorization from a user and an agent policy:

```http
POST /v1/authorizations
Authorization: Bearer allowly_l1_s001_...
```

```json
{
  "user_id": "user_123",
  "policy_id": "sales_copilot_email_v1"
}
```

The node output includes `authorizationId`. Store it in your workflow or app data, then use it with the **Check** operation. The selected policy must define `default_expiry_days`; this node does not invent an authorization expiry.

Copy the policy ID from the Allowly dashboard into **Policy ID**.

Docs: [Authorizations](https://allowly.ai/docs/api-reference/authorizations/) and [agent policies](https://allowly.ai/docs/api-reference/authorizations/#agent-policies).

### Check

Checks one stored authorization before an action runs:

```http
POST /v1/check
Authorization: Bearer allowly_l1_s001_...
```

```json
{
  "authorization_id": "auth_...",
  "actions": ["email.send"],
  "resource": "gmail:thread:abc123",
  "context": {
    "workflow_user_id": "user_123",
    "workflow_agent_id": "sales-copilot"
  }
}
```

Allowly authorizes from `authorization_id`. The user, agent, allowed actions, expiry, confirmation rules, escalation rules, and budget cap were defined when the authorization was created. Optional workflow user/agent fields in this node are copied into `context` only; they do not replace the authorization.

For `confirm`, map `confirmNonce` into **Resolve Confirmation**. For `escalate`, map `escalationId` into **Resolve Escalation**. After approval or resolution, run a second **Check** node with a different node name so it receives a fresh idempotency key; replaying the first key returns the first decision.

Docs: [Check API](https://allowly.ai/docs/api-reference/check/) and [decisions and attributes](https://allowly.ai/docs/api-reference/decisions-and-attributes/).

### Settle Budget

Reports the actual cost of a budgeted check. Map **Check Receipt ID** from the budgeted action's `receipt.receipt_id`; for a multi-action check, use that action's receipt. Run settlement in the same workflow while the check receipt still exists.

### Resolve Confirmation

Approve or reject the `confirm_nonce` returned by **Check**. Approval is a customer-reported event and does not identify a named approver.

### Resolve Escalation

Report an approved or rejected escalation using its `escalation_id`. **Resolved By** is an opaque, customer-reported identifier recorded in the escalation receipt.

## Fields

### Credential fields

- **API Key**: Allowly API key used to call the API. Keep it server-side.
- **User ID Pepper**: optional encrypted credential used by **Mask Email Locally**. Back it up; changing it changes derived user IDs.

Use an Allowly runtime key. SEAL uses the key's workspace and never accepts a caller-supplied workspace identity. Credential validation calls the runtime-scoped `GET /v1/authorizations` endpoint.
All requests use the hosted Allowly API at `https://api.allowly.ai`.

### SEAL fields

- **JSON Input**: parsed n8n value or original raw JSON text.
- **JSON Record / Raw JSON Text**: record hashed locally, with a 1 MiB UTF-8 limit and maximum nesting depth of 32.
- **Request ID**: stable retry ID. Reusing it with the same fingerprint and profile returns the original logical seal; changing the content conflicts. A new ID creates a new seal.
- **Metadata**: optional object of up to eight short string values copied into the signed context. Do not put secrets or raw records in metadata.
- **Signed Seal Receipt**: full signed wire-4 receipt or Allowly receipt envelope to verify.
- **Expected Workspace ID**: caller-trusted workspace retained from the authenticated sealing flow.

### Create Authorization fields

- **Policy ID**: reusable agent policy ID copied from the Allowly dashboard. The policy defines the agent and the actions the user is authorizing.
- **User Identifier**: choose how this node produces `user_id`.
- **User ID**: opaque internal app user ID sent directly as `user_id`.
- **User Email**: email to mask locally when **User Identifier** is set to **Mask Email Locally**.

### Check fields

- **Authorization**: stored Allowly authorization ID returned by **Create Authorization**.
- **Action(s)**: one action name or comma/newline-separated action names to check.
- **Resource**: optional action target, for example `gmail:thread:abc123`.
- **Session**: optional workflow/session label copied into the signed receipt.
- **Estimated Cost Micros**: optional micro-USD estimate for budgeted authorizations, from `0` through `9007199254740991`. `50_000_000` means `$50.00`. Reserved amounts stay charged until a **Settle Budget** step reports the actual cost.
- **Workflow User**: optional n8n workflow context field for traceability.
- **Workflow Agent**: optional n8n workflow context field for traceability.
- **Additional Context JSON**: optional JSON object copied into the Allowly check context and receipt.

### Settle Budget fields

- **Check Receipt ID**: `receipt.receipt_id` from the budgeted action in the **Check** output.
- **Actual Cost (micro-USD)**: actual integer cost from `0` through `9007199254740991`. The check must include an estimate.
- **Idempotency Key**: optional replay key; defaults to the n8n execution ID plus the check receipt ID.

## Why not use an email as `user_id`?

Allowly receipts are durable proof artifacts. If you send a raw email as `user_id`, that email can become part of API requests, logs, traces, and signed receipt payloads. That may be exactly what you want in a few internal systems, but it is usually not the privacy-safe default.

Prefer one of these:

- An opaque internal ID, such as `user_123`.
- A locally masked email ID, such as `email_hmac:v1:...`.

The **Mask Email Locally** mode does the masking inside n8n before the API request:

1. Trim whitespace.
2. Lowercase the email.
3. HMAC-SHA256 with your **User ID Pepper**.
4. Send only `email_hmac:v1:<digest>` to Allowly.

The raw email is not sent to Allowly and is not included in the node output. The pepper stays in the encrypted Allowly credential. Do not lose or rotate it casually: if it changes, the same email derives to a different `user_id`, and existing authorizations will no longer match.

More: [PII-safe identifiers](https://allowly.ai/docs/sdk/identifiers/).

## Output

### Seal output

```json
{
  "sealed": true,
  "signatureVerified": true,
  "recordMatches": true,
  "requestId": "n8n:...",
  "profile": "allowly.seal.jcs-sha256.v1",
  "recordSha256": "...",
  "workspaceId": "ws_...",
  "recordedAt": "2026-09-12T14:32:00.000Z",
  "receipt": {},
  "keysDocument": {},
  "trustedKeyFingerprints": [],
  "record": {}
}
```

Raw JSON mode returns `recordJson` instead of `record` so the original text can be archived.

### Verify SEAL output

```json
{
  "verified": true,
  "signatureVerified": true,
  "recordMatches": true,
  "failureReason": null,
  "expectedWorkspaceId": "ws_...",
  "receipt": {},
  "keysDocument": {},
  "trustedKeyFingerprints": []
}
```

### Create Authorization output

```json
{
  "authorizationId": "auth_...",
  "userId": "email_hmac:v1:...",
  "policyId": "sales_copilot_email_v1",
  "receipt": {
    "status": "pending",
    "receipt_id": "rcp_..."
  },
  "response": {}
}
```

### Check output

The node outputs the most restrictive action's convenient fields plus the full response. The order is `deny`, `escalate`, `confirm`, then `allow`, so a multi-action check cannot hide a denied action behind an earlier allowed one.

```json
{
  "action": "email.send",
  "decision": "allow",
  "reason": "authorization_granted_action_active",
  "receipt": {
    "status": "pending",
    "receipt_id": "rcp_..."
  },
  "results": {
    "email.send": {
      "decision": "allow",
      "reason": "authorization_granted_action_active"
    }
  },
  "response": {
    "authorization_id": "auth_...",
    "results": {}
  }
}
```
