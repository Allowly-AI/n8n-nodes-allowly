# n8n-nodes-allowly

Community n8n node for Allowly.

Use it to create an Allowly authorization from an agent policy, then check that authorization before an AI-agent, tool, or automation step runs. The node returns Allowly's decision object so your workflow can branch on `allow`, `deny`, `confirm`, or `escalate`.

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

The node output includes `authorizationId`. Store it in your workflow or app data, then use it with the **Check** operation.

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

Docs: [Check API](https://allowly.ai/docs/api-reference/check/) and [decisions and attributes](https://allowly.ai/docs/api-reference/decisions-and-attributes/).

## Fields

### Credential fields

- **API Key**: Allowly API key used to call the API. Keep it server-side.
- **API URL**: Allowly API origin. Use only the origin, for example `https://api.allowly.ai` or `http://localhost:8080`.

Use an Allowly runtime key. Credential validation calls the runtime-scoped `GET /v1/authorizations` endpoint.

### Create Authorization fields

- **Policy ID**: reusable agent policy ID copied from the Allowly dashboard. The policy defines the agent and the actions the user is authorizing.
- **User Identifier**: choose how this node produces `user_id`.
- **User ID**: opaque internal app user ID sent directly as `user_id`.
- **User Email**: email to mask locally when **User Identifier** is set to **Mask Email Locally**.
- **User ID Pepper**: stable app-held HMAC secret. Back it up; changing it changes derived user IDs.

### Check fields

- **Authorization**: stored Allowly authorization ID returned by **Create Authorization**.
- **Action(s)**: one action name or comma/newline-separated action names to check.
- **Resource**: optional action target, for example `gmail:thread:abc123`.
- **Session**: optional workflow/session label copied into the signed receipt.
- **Estimated Cost Micros**: optional micro-USD estimate for budgeted authorizations. `50_000_000` means `$50.00`.
- **Workflow User**: optional n8n workflow context field for traceability.
- **Workflow Agent**: optional n8n workflow context field for traceability.
- **Additional Context JSON**: optional JSON object copied into the Allowly check context and receipt.

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

The raw email is not sent to Allowly and is not included in the node output. Do not lose or rotate the pepper casually: it is a permanent app-held secret. If it changes, the same email derives to a different `user_id`, and existing authorizations will no longer match.

More: [PII-safe identifiers](https://allowly.ai/docs/sdk/identifiers/).

## Output

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
