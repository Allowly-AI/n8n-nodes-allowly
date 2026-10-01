# n8n-nodes-allowly

Community n8n node for Allowly.

Use it to seal and verify JSON records, or to authorize and check an AI agent, tool, or automation step. The default SEAL flow needs only the private webhook URL copied from the Allowly dashboard. Map JSON into the node and it returns portable signed evidence.

## Install in n8n

Allowly is a verified n8n integration. In n8n Cloud, search for **Allowly** in
the node picker and add it to a workflow.

On self-hosted n8n, an Owner or Admin can install the package:

1. Open n8n.
2. Go to **Settings -> Community Nodes**.
3. Install the current release:

```text
n8n-nodes-allowly@0.3.0
```

The verified integration page is at
[n8n.io/integrations/allowly](https://n8n.io/integrations/allowly/). Queue-mode
deployments must install the package on every worker and webhook processor as
well as the main instance.

## Import the SEAL starter workflow

[Download the managed SEAL workflow JSON](https://raw.githubusercontent.com/Allowly-AI/n8n-nodes-allowly/main/examples/allowly-managed-seal-webhook.json),
then use **Import from File** in n8n. The workflow is inactive and contains no
credential, private URL, workflow ID, or token.

Open **SEAL** in Allowly, copy the private webhook URL, and save it in one
**Allowly SEAL Webhook API** credential. Attach that credential to **2. SEAL +
WAIT + VERIFY**, map your JSON and optional receipt details, and execute the
workflow. Verified evidence is written to an n8n Data Table; a pending result
is kept out of the evidence table and carries the attempt ID needed for later
retrieval.

## Example: Stripe refunds with review

The [Stripe test-refund example](examples/stripe-refund-with-approval.md) targets
`n8n-nodes-allowly` **0.3.0**. Import the workflow, configure credentials and a
stored authorization, then test allow, deny, confirmation, and escalation paths.
It binds approval to the refund request, checks again after review, and preserves
the Stripe result separately from the decision receipt.

## Example: MCP agent crash test

**The poisoned agent called your n8n MCP tool. Zoho Mail never got the call.**

[Import the guarded MCP tool and crash-test one risky action](examples/mcp-agent-crash-test.md).
The package includes an inactive, credential-free workflow, synthetic inbox and
customer data, Allowly action/policy setup, and an example MCP client config.
Only a validated `allow` can reach Zoho Mail through its MCP server; every other decision, a malformed
response, or an Allowly error stops first.

The workflow uses the verified `n8n-nodes-allowly.allowly` type at node version
`2`. Read the guide before importing. It explains the exact credential and
authorization placeholders, the deterministic denied test, and what a signed
decision receipt does and does not prove.

## Set up Allowly Identity for agent workflows

**Allowly Identity is unreleased.** These instructions require a build from this
source that includes the **Allowly Identity** option. Published **0.3.0** supports
unbound and Auth0 authorizations; it does not include native identity support.
Its identity selector is named **External Identity Provider**; this build calls
it **Identity**.

For an enrolled Allowly agent, choose **Allowly Identity** in the **Allowly API**
credential. Set it up once before running protected actions:

1. Create the agent and its policy in Allowly. Keep the exact agent ID.
2. Install the [Allowly CLI](https://github.com/Allowly-AI/allowly-cli#enroll-an-agent),
   sign in, and enroll that agent:

   ```bash
   npm install -g @allowly-ai/cli
   allowly login
   allowly agent enroll <agent-id> --out /secure/path/credential.json
   ```

3. In n8n, create an **Allowly API** credential. Enter the workspace's runtime
   **API Key**, set **Identity** to **Allowly Identity**, and paste the complete
   JSON from the completed file into **Allowly Identity Credential**. Paste the
   JSON itself, not a file path or an identity token.
4. After enrollment succeeds, use **Create Authorization** once for that agent's
   policy. Store the returned `authorizationId` for your workflow.
5. Run **Check** with that stored authorization and a policy action. This checks
   the native identity and writes a decision receipt. Confirm the expected
   decision before connecting a provider action.

Enrollment registers only the public key with Allowly. The private credential
stays in the owner-only CLI file, then in n8n's encrypted credential store. Use
the completed version-1 file with `provider: "allowly"`, `workspace_id`,
`agent_id`, `binding_id`, `key_id`, and `private_key_jwk`. Keep all API keys,
private credentials, and identity tokens out of workflow JSON, items, and logs.

The node signs a 60-second identity token locally using Ed25519 and sends it for
**Check**, **Check & Enforce**, and **Acknowledge Receipt**. The CLI is not needed
when the workflow runs. The runtime API key is still required. Enrollment uses
the CLI setup login; a runtime API key cannot enroll an agent.

The credential's **Test** button only lists one authorization to test the API
key. It does not test the private credential or its authorization binding. Use
the **Check** test above to validate native identity.

Existing authorizations keep the identity recorded when they were created.
Enrollment does not bind an old authorization. When migrating, create a new or
replacement authorization after enrollment, then deliberately update the
workflow's stored ID and test it. A native identity credential cannot be used
with an unbound authorization. Keep **No External Identity** for existing
unbound authorizations, or **Auth0 Machine-to-Machine** for an Auth0 binding.
The credential default remains **No External Identity** for compatibility.

Enrollment must be enabled on the target runtime, and its agent/key limits
apply. If enrollment is interrupted or returns
`native_agent_enrollment_disabled`, keep the pending file. Once enrollment can
complete, rerun the command with `--resume` and the same `--out` path before
creating the authorization.

## Operations

### Seal JSON with Managed Webhook

1. Open **SEAL** in the Allowly dashboard and copy the private webhook URL.
2. In n8n, create an **Allowly SEAL Webhook API** credential and paste that URL into **Private Webhook URL**.
3. Choose **Seal JSON with Managed Webhook** and map the JSON record.
4. Run the node and save its receipt, key document, workspace ID, and original record.

No ordinary API key, policy, authorization, or local hashing step is required. The node sends the complete JSON record to the private webhook as the raw request body. Allowly hashes it in memory and does not retain the original record. The node keeps the mapped value in its output as `record`, or preserves exact input text as `recordJson` in **Raw JSON Text** mode.

Choose **Parsed Value** for ordinary n8n objects. Choose **Raw JSON Text** when exact number spelling, duplicate keys, and other byte-level details matter. Allowly applies the versioned `allowly.seal.jcs-sha256.v1` profile and rejects malformed or unsafe JSON.

Optionally map **Type**, **Reference**, and **Statement** as Receipt details. For example, use `invoice`, `INV-1042`, and `Approved for payment`. The node sends them in the explicit `Allowly-Seal-Type`, `Allowly-Seal-Reference`, and `Allowly-Seal-Statement` headers, so the raw JSON body and its fingerprint stay unchanged. Each value accepts up to 256 printable ASCII characters with no leading or trailing whitespace; interior spaces are kept. Allowly stores the submitted details in the signed receipt; it does not extract them from the JSON or prove that the statement is true. Do not put secrets or the original record in these fields.

**Wait for Signature** is bounded from 0 to 300 seconds and defaults to 120. A `200` or `202` webhook response confirms only the current delivery state. The node reports `sealed: true` after it retrieves the signed receipt and keys and verifies both the signature and original record. If signing is still running when the wait ends, it returns `pending: true` with an `attemptId`.

The output `metadata` field carries the returned Receipt details and is `null` for older receipts with none. Once sealed, the node checks that `metadata` matches the signed receipt before returning verified evidence. A rejected attempt still fails with a safe error.

Set **Idempotency Key** to a stable sender event ID when the upstream system has one. A retry with the same key, exact JSON, and same Receipt details recovers the same attempt. Reusing the key after changing the JSON or a detail returns a conflict. If the field is blank, the node derives a stable key from the n8n execution, node, and item.

The private URL is an encrypted n8n credential. The node never adds it or any token-bearing status, receipt, or keys URL to workflow output or customer-facing errors. Credential testing performs a scoped `GET`; it never creates a seal.

### Retrieve Managed Webhook Seal

Use **Retrieve Managed Webhook Seal** after a pending result. Map its `attemptId` and the same original `recordJson` or `record`, then use the same private webhook credential. The node waits for the selected bounded period, retrieves the receipt and keys through trusted credential-derived routes, and verifies the evidence. It returns another pending result if signing still has not finished.

### Verify Saved JSON Seal

Use **Verify Saved JSON Seal** with the original JSON, signed receipt, saved key document, and expected workspace ID. This operation makes no network request and needs no API key or active webhook. It uses the same bundled Allowly verifier as the other SEAL operations and fails the workflow if the signature, record, or workspace does not match.

Keep the original JSON, full receipt, workspace ID, key document, and trusted key fingerprints together. Hosted receipt and key availability is not permanent.

### Seal JSON Record (API Key)

The earlier direct API operation remains available for existing workflows. It hashes the record inside n8n, sends the fingerprint and optional short metadata to `POST /v1/seal` with an Allowly runtime API key, waits for signing, and verifies the receipt before returning success. It does not send the original JSON to Allowly.

### Verify JSON Seal (API Key)

The earlier API-key verification operation also remains available. Supply the original JSON, full signed receipt, and expected workspace ID. The node retrieves workspace keys from the fixed Allowly API origin, then verifies the signature and record locally.

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

For **Allowly Identity**, enroll the agent before creating this authorization.
Creating it records the agent identity that must sign its checks. Enrollment
never changes an existing grant.

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
  "client_timestamp": "2026-09-24T20:01:02.123Z",
  "context": {
    "workflow_user_id": "user_123",
    "workflow_agent_id": "sales-copilot"
  }
}
```

Allowly authorizes from `authorization_id`. The user, agent, allowed actions, expiry, confirmation rules, escalation rules, and budget cap were defined when the authorization was created. Optional workflow user/agent fields in this node are copied into `context` only; they do not replace the authorization.

For `confirm`, map `confirmNonce` into **Resolve Confirmation**. For `escalate`, map `escalationId` into **Resolve Escalation**. After approval or resolution, run a second **Check** node with a different node name so it receives a fresh idempotency key; replaying the first key returns the first decision.

Docs: [Check API](https://allowly.ai/docs/api-reference/check/) and [decisions and attributes](https://allowly.ai/docs/api-reference/decisions-and-attributes/).

### Check & Enforce

Uses the same inputs as **Check**, but releases an item only when the selected
result is exactly `allow`. `deny`, `confirm`, `escalate`, a missing or malformed
result, and request failure stop the node. Confirmation and escalation must use
their existing resolution actions and a fresh check; they are never treated as
allow.

n8n still lets workflow owners create other routes. Do not connect a node-level
error output or **Continue On Fail** path to the protected action. This operation
also throws on non-allow when **Continue On Fail** is set, but workflow
configuration remains customer-controlled.

### Run a provider action

Place **Check & Enforce** immediately before a provider node in the same
workflow. Only an exact `allow` releases the item. n8n runs the provider node
with its own credential; Allowly receives the policy fields and decision record,
not the provider credential or request. Keep provider credentials in n8n's
encrypted credential store. This flow has a decision receipt, but no independent
witness of the provider response.

### Acknowledge Receipt

Map the complete signed receipt into **Signed Receipt** after it is available.
The node computes the canonical SHA-256 locally, then records the hash and the
required customer-reported **Client Timestamp** through the acknowledgment API.
The resulting evidence records an authenticated workflow report. It is not a
customer signature.

### Settle Budget

Reports the actual cost of a budgeted check. Map **Check Receipt ID** from the budgeted action's `receipt.receipt_id`; for a multi-action check, use that action's receipt. Run settlement in the same workflow while the check receipt still exists.

### Resolve Confirmation

Approve or reject the `confirm_nonce` returned by **Check**. Approval is a customer-reported event and does not identify a named approver.

### Resolve Escalation

Report an approved or rejected escalation using its `escalation_id`. **Resolved By** is an opaque, customer-reported identifier recorded in the escalation receipt.

## Fields

### Credential fields

- **Allowly SEAL Webhook API / Private Webhook URL**: the complete private URL copied from the dashboard. This is the only credential needed for managed sealing and retrieval. Treat it like a password.
- **Allowly API / API Key**: Allowly runtime key used by the older direct SEAL operations and authorization operations.
- **Allowly API / User ID Pepper**: optional encrypted value used only by **Mask Email Locally**. Back it up; changing it changes derived user IDs.
- **Allowly API / Identity**: choose **Allowly Identity** for an authorization bound to native identity, **Auth0 Machine-to-Machine** for an Auth0 binding, or **No External Identity** for an unbound authorization. The existing default remains **No External Identity**.
- **Allowly Identity Credential**: required when **Identity** is **Allowly Identity**. Paste the complete, successfully enrolled CLI credential JSON. Its private key stays in n8n credential storage; the node returns neither the credential nor its signed tokens in items or errors.
- **Auth0 Issuer**, **Auth0 Audience**, **Auth0 Client ID**, and **Auth0 Client Secret**: customer Auth0 machine credential stored by n8n. The node validates the exact HTTPS issuer, obtains a short-lived token without following redirects, and reuses it only while unexpired during the current node execution. Secrets and tokens are not returned in items or errors.

Production webhook credentials must use the hosted Allowly API at `https://api.allowly.ai`. For local development only, enable **Allow Local Development URL** on the credential to accept a private URL on `localhost`, `127.0.0.1`, or `::1`. When n8n SSRF protection is enabled, keep `N8N_SSRF_PROTECTION_ENABLED=true` and add only the loopback hostname in use, such as `N8N_SSRF_ALLOWED_HOSTNAMES=localhost`. These advanced settings are not part of customer credential setup.

### Managed SEAL fields

- **JSON Input**: parsed n8n value or original raw JSON text.
- **JSON Record / Raw JSON Text**: the complete record. **Seal JSON with Managed Webhook** sends it to Allowly for in-memory hashing. Retrieval and verification compare it locally without sending it again. The webhook enforces a 1 MiB UTF-8 limit and maximum nesting depth of 32.
- **Type**, **Reference**, and **Statement**: optional Receipt details, each up to 256 printable ASCII characters with no leading or trailing whitespace. Interior spaces are kept. They are stored with the signed receipt. Reference supports exact retained-receipt search and is not an idempotency key.
- **Idempotency Key**: optional stable sender event ID. Reusing it with the same JSON and details recovers the original attempt; changing either conflicts.
- **Wait for Signature**: maximum time to poll, from 0 to 300 seconds. A timeout returns a pending result rather than claiming the record is sealed.
- **Attempt ID**: opaque ID from a pending result, used by **Retrieve Managed Webhook Seal**.
- **Signed Seal Receipt**, **Saved Key Document**, and **Expected Workspace ID**: retained evidence used by **Verify Saved JSON Seal** without a credential or network request.

### API-key SEAL fields

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
- **Client Timestamp**: optional timezone-aware, customer-reported event time. It never replaces Allowly's receipt time.

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

### Managed SEAL output

```json
{
  "attemptId": "swd_...",
  "workspaceId": "ws_...",
  "status": "sealed",
  "sealed": true,
  "pending": false,
  "signatureVerified": true,
  "recordMatches": true,
  "profile": "allowly.seal.jcs-sha256.v1",
  "recordSha256": "...",
  "receiptId": "rcp_...",
  "recordedAt": "2026-09-12T14:32:00.000Z",
  "receipt": {},
  "keysDocument": {},
  "trustedKeyFingerprints": [],
  "record": {}
}
```

Raw JSON mode returns `recordJson` instead of `record` so the original text can be archived.

If signing is still running, `sealed` is `false`, `pending` is `true`, and the signed evidence fields are `null`. Map `attemptId` and the original record into **Retrieve Managed Webhook Seal**. No output contains the private webhook URL or a token-bearing URL.

### API-key Seal output

The older **Seal JSON Record (API Key)** operation returns the same portable evidence fields with its direct `requestId` instead of a webhook `attemptId`.

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
