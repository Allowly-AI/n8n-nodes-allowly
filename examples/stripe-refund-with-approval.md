# Stripe test refunds with Allowly review

[Import this workflow JSON](stripe-refund-with-approval.json).
It targets **n8n-nodes-allowly 0.2.1** and uses n8n's standard HTTP, Code, IF,
and Wait nodes. The workflow is inactive and contains no credentials or pinned data.
Use a self-hosted n8n instance that permits this community node and Code nodes.

A refund request is checked against a stored Allowly authorization. Only `allow`
reaches Stripe. `deny` stops; `confirm` and `escalate` wait for an authenticated
review and then require a fresh `allow`. Errors stop the workflow.

This is useful when the same refund policy must apply across several tools or
workflows. For one local amount threshold, a native IF node may be sufficient.

## 1. Prepare Allowly once

Use the dashboard or setup API to create an agent and the action `refund.create`.
Declare these action context fields: `refund_request_id` and `payment_intent_id`
as strings, `amount_minor` as an integer, and `currency` and `reason` as strings.
Create a policy for the agent with that action and `default_expiry_days: 7`.
For a USD demonstration, configure these constraints under that policy action:

| Constraint | Condition | Result |
|---|---|---|
| `deny_when` | `amount_minor` greater than `100000` | Deny above $1,000. |
| `escalate_when` | `amount_minor` greater than `50000` | Escalate above $500 when not denied. |
| `confirm_when` | `amount_minor` greater than `5000` | Confirm above $50 when not denied or escalated. |

The API condition forms are `{ "field": "amount_minor", "gt": 100000 }`,
`{ "field": "amount_minor", "gt": 50000 }`, and
`{ "field": "amount_minor", "gt": 5000 }`, respectively, each in a list.
Set the policy's `escalation_targets["refund.create"]` to an opaque value such as
`finance-review`. Leave unconditional confirmation/escalation/denial lists empty.

Using the **Create Authorization** operation in a separate setup workflow, create
one authorization for the policy and an opaque test user ID. Store its returned
`authorizationId`; the refund workflow reuses it. Do not create a new authorization
for every refund. Setup credentials configure policies; runtime API keys perform
checks. Follow the policy publication instructions when replacing a policy.

See [setup](https://allowly.ai/docs/api-reference/setup-and-tombstones/),
[authorizations](https://allowly.ai/docs/api-reference/authorizations/), and
[decision rules](https://allowly.ai/docs/api-reference/decisions-and-attributes/).

## 2. Prepare Stripe and import

1. Install `n8n-nodes-allowly` **0.2.1** in n8n, then import the JSON file.
2. Create a succeeded USD PaymentIntent in Stripe's test mode or sandbox, with
   enough received funds for the scenario. Keep its `pi_...` ID. No payment is
   created by this workflow.
3. In n8n, select the **same Stripe test credential** on **Read Stripe payment**
   and **Create Stripe test refund**. The workflow rejects a retrieved payment
   unless `livemode` is exactly `false` and the payment ID matches.
4. Select the **same Allowly API credential** on both Check nodes, both Resolve
   nodes, and **Fetch decision receipt**.
5. On **Wait for reviewer**, keep Header Auth and select a dedicated **Header Auth**
   credential. Use a header such as `X-Refund-Review-Token` and a private random
   value. Do not use an Allowly or Stripe API key as the review secret. The shared
   credential represents this demo's trusted review service, not a named person.
6. Edit **Refund request**: set the stored parent `authorizationId`, test
   `paymentIntentId`, a stable `refundRequestId`, and integer `amountMinor` in cents.
   Keep `currency: "usd"` and `reason: "requested_by_customer"`.

Run the full workflow from **Run test refund**, with a fresh execution and no pinned
nodes. Avoid executing the refund node alone. The initial request is validated and
frozen: only that snapshot supplies the check context and the Stripe request.
The example deliberately processes one request per execution.

## 3. Review a confirmation or escalation

For an amount requiring review, the execution waits at **Wait for reviewer**.
Inspect the frozen request and decision in the n8n execution. Copy the `resource`
from **Validate request** and the execution's resume webhook URL. The URL and
review secret must stay with the trusted reviewer.

POST JSON to that resume URL with the configured authentication header:

```json
{
  "approved": true,
  "resource": "COPY_THE_EXACT_RESOURCE_FROM_VALIDATE_REQUEST"
}
```

Use the boolean `false` to reject. A string such as `"true"`, a different resource,
extra fields, or a timeout cannot authorize a refund. A webhook HTTP 200 acknowledges
the resume request; inspect the execution for the actual outcome.

The four-minute wait is bounded because confirmation nonces expire after five
minutes. Rejection is reported to Allowly and stops. Approval resolves the original
nonce or escalation ID, then **Recheck refund after review** uses the original
parent authorization and identical action, resource, and context. It has a distinct
node name, producing a fresh check idempotency key. The child `authorization_id`
returned by confirmation resolution is intentionally not used.

Every executable refund field is included in the resource using a fixed order and
restricted characters. Changing the amount, payment, or request ID changes that
resource and requires a new review. Currency and reason changes are rejected by this
USD-only example. Do not accept arbitrary refund fields from the review webhook.
The escalation `resolved_by` value is the fixed demo service ID
`n8n-refund-review-demo`; it is customer-reported, not verified human identity.

An expired review or a second check returning anything except `allow` stops. Start
a fresh full execution rather than bypassing or reconnecting the decision branches.
[n8n Wait documentation](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.wait/).

## 4. Retry and retain the result

Stripe receives `Idempotency-Key: allowly-refund:<refundRequestId>`. Keep the request
ID and all refund fields unchanged on a retry, including retries in a new n8n
execution. The Stripe body intentionally excludes execution-specific receipt IDs,
so retries can match. Reusing an ID with changed fields conflicts instead of silently
creating another refund. Use a new request ID only for a genuinely new, separately
reviewed refund request.

Stripe may prune an idempotency key after at least 24 hours. This example has no
durable refund ledger: reconcile uncertain or older requests with Stripe before
rerunning them. Adding a database claim/ledger is required before adapting this
demo for unattended production processing.
[Stripe retry semantics](https://docs.stripe.com/api/idempotent_requests),
[refund API](https://docs.stripe.com/api/refunds/create).

**Refund result** preserves the exact request, allowed decision, receipt ID, and
Stripe refund ID/amount/status before receipt retrieval. A later receipt-fetch error
does not mean the refund failed. Recover the receipt separately; do not create a new
refund to recover evidence. Likewise, Stripe refund status may be pending or failed:
a returned object is not proof of completed payment.

**Export refund evidence** retrieves the decision receipt once. It returns
`receiptPending: true` if signing is still pending. Save that output and retrieve
`GET /v1/receipts/{receipt_id}` later, within your retention window, to obtain the
signed envelope. No response-provided URL is followed. If the fetch fails, save
**Refund result** and use its receipt ID. Export the original request, signed
receipt, expected workspace ID, and workspace key document to your own storage.

The workflow reports `receiptVerification: "not_performed"`; even a signed envelope
has not been verified by this example. Use the
[standalone receipt verifiers](https://github.com/Allowly-AI/allowly-receipt-format)
with your configured expected workspace ID. A receipt authenticates the recorded
decision; it does not prove refund execution, human approval, complete history, or
compliance. Stripe records and human identity controls remain separate.

## Validation

```sh
npm test
npm run typecheck
```

`test/refund-workflow.test.cjs` executes the exported graph, inline Code, expressions,
and real Allowly node with mocked services. It covers all decision paths, strict
review input, changed requests, test-mode enforcement, retries, failures, and pending
receipt recovery. The mock Stripe retry behavior represents its documented API
contract; it is not a live Stripe integration test.

The template's node parameters and expressions were also checked against installed
n8n **2.33.3**. Before publishing it as a tested marketplace template, complete an
end-to-end run on your n8n instance with Allowly and Stripe test credentials,
including authenticated review, rejection, timeout, and retries. Those service-backed
runs have not been performed as part of this addition.
