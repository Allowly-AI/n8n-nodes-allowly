# Route Stripe refunds with Jev decisions and Allowly guardrails

[Import the workflow JSON](stripe-refund-with-jev.json).

The workflow calls Jev through OpenRouter's typed Decisions API to classify each
customer message into refund probabilities. Allowly applies fixed policy rules,
records the decision, and gates the Stripe refund through immediate approval,
confirmation, escalation, or denial.

This demo gives each system one clear job:

```text
Stripe facts → Jev semantic decision → Allowly guardrail and receipt → Stripe refund
```

Jev reads the customer message and returns typed probabilities. The workflow
validates and freezes them. Allowly checks fixed safety limits over the frozen
values and records the resulting action decision. Only an Allowly `allow` can
reach Stripe.

The workflow is inactive, has no credentials or pinned data, and supports one
refund request per execution. It targets **n8n-nodes-allowly 0.2.1** and Stripe
test mode. Keep the original
[refund workflow](stripe-refund-with-approval.md) for a demo without Jev.

## Free mock mode

The imported workflow starts with `jevMode: "mock"`. This path makes no
OpenRouter request and needs no OpenRouter credit. It uses one fixed fixture for
this exact sample message:

```text
I was charged twice for September. Please refund the duplicate charge.
```

The frozen output says `decisionSource: "mock_fixture"`; it never presents the
fixture as a live TypeSafe result. Change the message only after switching to
`jevMode: "live"`.

## Prepare Allowly once

Create or update the `refund.create` action with these context fields:

```json
{
  "context_fields": {
    "refund_request_id": "string",
    "customer_message_id": "string",
    "payment_intent_id": "string",
    "amount_minor": "integer",
    "currency": "string",
    "reason": "string",
    "triage_source": "string",
    "jev_generation_id": "string",
    "jev_model": "string",
    "jev_provider": "string",
    "refund_requested_ppm": "integer",
    "refund_reason": "string",
    "refund_reason_probability_ppm": "integer",
    "refund_reason_confidence_ppm": "integer",
    "triage_route": "string"
  }
}
```

The probabilities are integer parts per million, from 0 to 1,000,000. This
avoids floating-point values in the receipt context.

For the demo policy, use these constraints on `refund.create`:

```json
{
  "deny_when": [
    { "field": "amount_minor", "gt": 100000 },
    { "field": "refund_requested_ppm", "lt": 100001 }
  ],
  "escalate_when": [
    { "field": "amount_minor", "gt": 50000 }
  ],
  "confirm_when": [
    { "field": "amount_minor", "gt": 5000 },
    { "field": "refund_requested_ppm", "lt": 900000 },
    { "field": "refund_reason_confidence_ppm", "lt": 800000 },
    { "field": "refund_reason_probability_ppm", "lt": 600000 },
    { "field": "refund_reason", "eq": "other_or_unclear" },
    { "field": "refund_reason", "eq": "unauthorized" }
  ]
}
```

Conditions inside each list are alternatives. Allowly evaluates deny before
escalate, then confirm. This gives the demo these boundaries:

- More than $1,000, or a clear non-request, is denied.
- More than $500 is escalated.
- More than $50, uncertainty, an unclear reason, or an unauthorized-charge claim
  requires review.
- A clear, low-value request can be allowed.

Set an escalation target such as `finance-review`. Create one stored
authorization for the policy and reuse its `authorizationId`; do not create a
new authorization for every refund.

## Import and run the free demo

1. Install `n8n-nodes-allowly` **0.2.1** on a self-hosted n8n instance that
   permits Code nodes, then import the JSON.
2. Create a succeeded USD PaymentIntent in Stripe test mode with enough received
   funds. No payment is created by this workflow.
3. Select the same Stripe test credential on **Read Stripe payment** and
   **Create Stripe test refund**.
4. Select the same Allowly API credential on both Check nodes, both Resolve
   nodes, and **Fetch decision receipt**.
5. On **Wait for reviewer**, select a dedicated Header Auth credential. Keep its
   secret separate from the Stripe, Allowly, and OpenRouter keys.
6. Edit **Refund request** with the stored authorization, Stripe test PaymentIntent,
   stable refund request ID, opaque customer message ID, and amount in cents.
   Leave the included message and `jevMode: "mock"` unchanged for the free run.
7. Run the complete workflow from **Run test refund** with no pinned nodes.

The included amount is $25, so the sample can follow the direct-allow path.

## Run all three decision paths

These inputs demonstrate an immediate allow, a human escalation, and a denial
with the policy above. The Jev values shown here came from live calls on
September 23, 2026. A future call can vary, while Allowly's decision remains
deterministic for the values frozen by the workflow.

| Path | `amountMinor` | `customerMessage` | Live Jev result | Allowly result |
| --- | ---: | --- | --- | --- |
| Allow | `2500` | `I was charged twice for September. Please refund the duplicate charge.` | Refund requested `0.99`; `duplicate_charge` at `1.00`; route `ready_for_allowly` | `allow` |
| Escalate | `60000` | `Please refund this payment. It may be a duplicate charge, or it may be an unauthorized purchase; I cannot tell which.` | Refund requested `0.99`; `other_or_unclear` at `1.00`; route `manual_review` | `escalate` because $600 exceeds the $500 escalation boundary |
| Deny | `2500` | `Please explain the September charge. I am not asking for a refund or reversal.` | Refund requested `0.03`; `other_or_unclear` at `1.00`; route `not_requested` | `deny` because the refund-request score is below `100001` ppm |

For the escalation path, approve or reject the frozen request through the
authenticated review URL. Approval resolves the escalation and triggers the
unchanged Allowly recheck before Stripe can run. The denial path stops before
Stripe.

## Enable the live Jev call

Jev is a paid OpenRouter model. An account with a $0.00 balance cannot use the
live branch. The cost per short call is very small, but the free OpenRouter
models cannot replace the typed Decisions API used here. Check the
[current Jev price](https://openrouter.ai/typesafe/jev-1.13/api) before adding
credit.

1. In n8n, create an **OpenRouter** credential and paste only the API key. The
   credential supplies the Bearer header; the workflow export contains no key.
2. Select that credential on **Call OpenRouter Jev**.
3. Change `jevMode` to `"live"` and set the real customer message and its opaque,
   stable `customerMessageId`.
4. Run the full workflow.

The HTTP node makes one request to
`POST https://openrouter.ai/api/alpha/decisions` with the pinned model
`typesafe/jev-1.13`. It asks whether money back was explicitly requested and
chooses one reason from:

- `duplicate_charge`
- `defective_or_damaged`
- `not_received`
- `changed_mind`
- `unauthorized`
- `other_or_unclear`

The workflow rejects malformed answers, unknown labels, invalid probabilities,
wrong provider provenance, and unexpected model families. A valid uncertain
answer still reaches Allowly so the policy can return a recorded confirm, deny,
or escalation instead of losing the decision at an unrecorded branch.

## Review and retry rules

For confirmation or escalation, the execution pauses for four minutes at
**Wait for reviewer**. POST only this JSON to the execution's resume URL with the
configured Header Auth credential:

```json
{
  "approved": true,
  "resource": "COPY_THE_EXACT_RESOURCE_FROM_FREEZE_JEV_DECISION"
}
```

Use boolean `false` to reject. A changed resource, string value such as
`"true"`, extra field, timeout, or failed review stops the workflow. Approval
resolves the Allowly review, then performs a fresh check with the original
authorization and the identical frozen Stripe and Jev snapshot. Only a fresh
`allow` reaches Stripe.

Stripe receives `Idempotency-Key: allowly-refund:<refundRequestId>`. Keep the
same ID and all refund fields on a retry. Reconcile an uncertain or old request
in Stripe before running it again. Production use needs a durable refund ledger.

## What the evidence means

The Allowly context contains the opaque message ID, live-or-mock source, Jev
generation ID, exact model/provider labels, selected reason, selected probability,
confidence, refund-request probability, and route. It does not contain the raw
customer message, floating-point values, complete probability map, API key, or
OpenRouter usage data.

The full validated probability map and integer usage summary remain in the n8n
execution output under `jev`. n8n also holds the raw customer message earlier in
the execution, so apply suitable n8n execution-retention and access controls.

An Allowly receipt proves which authorization and policy were checked against
the context supplied by this workflow. It does not prove that Jev was correct,
that the supplied message ID identifies the original message, or that Stripe
completed the refund. The live OpenRouter generation ID is a trace reference.
For production evidence that binds the exact source message, compute a digest of
the source bytes in the system that owns them and include a separately declared
digest field.

## Validation

```sh
node --test test/jev-refund-workflow.test.cjs
npm run typecheck
```

The test executes both branches with mocked external services and the real
Allowly node. It checks the OpenRouter request contract, provenance separation,
integer normalization, frozen recheck snapshot, and that only an Allowly allow
can call the Stripe refund endpoint. A live Jev call is not part of the test.
