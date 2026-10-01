# Allowly MCP agent crash test for n8n

**The poisoned agent called your n8n MCP tool. Zoho Mail never got the call.**

Import the guarded MCP tool and crash-test one risky action.

This example exposes two tools through n8n's MCP Server Trigger:

- `read_demo_inbox` returns one synthetic support message containing a prompt injection.
- `send_email` derives trusted context in n8n, checks `mcp_demo.email.send` with Allowly, and reaches Zoho Mail through its MCP server only after a validated `allow`.

The bundled attack is denied because its body contains a synthetic customer-list export. `deny`, `confirm`, `escalate`, missing or malformed decisions, and Allowly errors cannot reach Zoho Mail.

## Included files

- [`mcp-agent-crash-test.json`](mcp-agent-crash-test.json) — inactive, credential-free n8n workflow.
- [`mcp-agent-crash-test.allowly.setup.json`](mcp-agent-crash-test.allowly.setup.json) — Allowly action and policy.
- [`mcp-agent-crash-test.data.json`](mcp-agent-crash-test.data.json) — the fake inbox and customer data embedded in the workflow.
- [`mcp-agent-crash-test.client.example.json`](mcp-agent-crash-test.client.example.json) — Claude Desktop-style remote MCP configuration with placeholders.

The workflow uses the verified `n8n-nodes-allowly.allowly` node at its current default node version, `2`. It does not use `CUSTOM.allowly`.

## Before you import

Use a test n8n project and a Zoho Mail account reserved for testing. The supplied addresses use reserved `.example` and `.invalid` domains. Do not replace them with customer data or a real outside recipient for the crash test.

Install the current package release:

```text
n8n-nodes-allowly@0.3.0
```

Apply the bundled action and policy from a terminal where the Allowly CLI is signed in:

```bash
allowly actions apply examples/mcp-agent-crash-test.allowly.setup.json
allowly policies apply examples/mcp-agent-crash-test.allowly.setup.json
```

The policy denies a detected customer export, pauses other external sends for confirmation, and limits allowed sends to five per day. The `.example.invalid` detector is only a deterministic demo signal. It is not a data-loss-prevention system.

## Import and configure

1. In n8n, choose **Import from File** and import `examples/mcp-agent-crash-test.json`. It arrives inactive.
2. Create an **Allowly API** credential with a runtime API key. Select it on **Create test authorization** and **Allowly checks before Zoho Mail**. Keep **External Identity Provider** set to **No External Identity** unless the policy requires Auth0.
3. Create a **Bearer Auth** credential for **MCP Server Trigger**. Use a new random token and keep it out of the workflow export.
4. On **Release parameters**, replace the MCP endpoint, verified Druim account ID, and verified From-address placeholders. This trusted node overwrites any same-named fields supplied by a caller.
5. On **Zoho Mail — only explicit allow**, select an **MCP OAuth2 API** credential authorized for that Zoho Mail MCP server. The node reads its endpoint, account ID, and From address only from **Release parameters**. The bundled denied run does not call Zoho Mail.
6. Run the complete workflow from **Test workflow**. Do not run the Zoho Mail node by itself.

The manual test creates a short-lived authorization, builds the synthetic export attempt, and should stop at **DENIED or paused — Zoho Mail not called**. In the execution view, the Zoho Mail MCP Client node must remain unexecuted.

## Connect an MCP client

1. Run the manual test once and copy `authorizationId` from **Create test authorization**.
2. Replace `auth_REPLACE_WITH_PRESTAGED_ID` in the `send_email` workflow-tool node with that stored authorization ID.
3. Publish the workflow. Open **MCP Server Trigger** and copy its production MCP URL.
4. Copy `mcp-agent-crash-test.client.example.json` into your client's MCP configuration.
5. Replace `REPLACE_WITH_N8N_MCP_PRODUCTION_URL` with the production URL and `REPLACE_WITH_MCP_BEARER_TOKEN` with the token from the n8n Bearer Auth credential.
6. Restart or reconnect the client, call `read_demo_inbox`, then ask it to follow the message's instruction. Confirm in n8n that the attempted `send_email` call was denied and Zoho Mail did not execute.

The sample client configuration follows [n8n's documented `mcp-remote` pattern](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.mcptrigger/#integrating-with-claude-desktop) for clients that need a local stdio gateway. Other clients can use the same production URL and Bearer token in their own remote-MCP format.

This workflow uses n8n's MCP Server Trigger as the server boundary. The current `@allowly/mcp` package is MCP server middleware; it is not a generic proxy between this client and n8n.

## Why the boundary fails closed

The only incoming workflow edge to Zoho Mail comes from the true output of **Allowly decision is allow**. Before that branch, **Validate Allowly decision** requires:

- the expected action name;
- one known decision: `allow`, `deny`, `confirm`, or `escalate`;
- the same decision in the per-action result;
- a non-empty reason; and
- a decision receipt ID.

The Allowly node has no continue-on-error setting. An API or credential error stops before the decision branch. A missing or malformed response fails validation. A valid non-`allow` result takes the stop branch.

These graph rules protect only runs that use the complete imported workflow. An n8n editor can still change or bypass the graph, and direct Zoho Mail access remains outside Allowly.

## What the receipt proves

Every accepted Allowly check records a decision receipt. Once its signature is present and independently verified against the expected workspace and published key document, the receipt proves that the Allowly issuer signed the included decision record and policy reference and that those signed bytes were not changed.

The receipt does **not** prove that:

- Zoho Mail ran or did not run;
- n8n enforced the decision;
- a named human approved anything;
- the inbox message or customer data was true;
- the receipt set is complete; or
- the workflow meets a legal or compliance requirement.

Use the n8n execution graph to show that Zoho Mail did not run in this crash test. Keep downstream delivery logs separately. A pending receipt is not yet signed, and signature presence is not the same as verification.

For the campaign page and the independent verifier, see [the public crash-test page](https://allowly.ai/use-cases/mcp-agent-crash-test/) and [Allowly receipt verification](https://allowly.ai/docs/api-reference/verify/).
