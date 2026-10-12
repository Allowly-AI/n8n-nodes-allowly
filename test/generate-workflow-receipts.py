"""Print fictional wire-5 action fixtures; never rewrite official test vectors."""
import base64
import hashlib
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "allowly-receipt-format/verifiers/python/src"))
from allowly_receipt_format import canonicalize, jws_signing_input

# Public deterministic test key. Never use it for a deployment or customer proof.
key = Ed25519PrivateKey.from_private_bytes(hashlib.sha256(b"allowly-n8n-fictional-workflow-key").digest())
public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)


def b64(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def receipt(name, action, authorization_id="auth_parent", decision="allow", reason="authorization_granted_action_active"):
    payload = {
        "schema_version": "5", "receipt_id": "rcp_n8n_" + ("refund_allow" if name.startswith("cross_") else name), "workspace_id": "ws_test",
        "issued_at": "2026-04-21T14:32:17.482Z", "action": action, "authorization_id": authorization_id,
        "decision": decision, "reason": reason, "user_id": "user_workflow_fixture", "agent_id": "agent_workflow_fixture",
        "resource": "synthetic:workflow-envelope-test", "context": {},
        "engine_version": "sha256:" + hashlib.sha256(b"fictional-workflow-engine").hexdigest(),
        "policy_ref": {"policy_id": "pol_workflow_fixture", "policy_version": 1, "definition_sha256": "a" * 64},
    }
    header = {"alg": "EdDSA", "kid": "fictional-workflow-key/v1", "typ": "allowly-receipt+jws"}
    return {"protected": b64(canonicalize(header)), "payload": b64(canonicalize(payload)),
            "signature": b64(key.sign(jws_signing_input(payload, header["kid"])))}


print(json.dumps({
    "synthetic": True, "description": "Fictional signed action fixtures, not a customer execution proof.",
    "expected_workspace_id": "ws_test",
    "public_keys": {"workspace_id": "ws_test", "keys": [{"key_id": "fictional-workflow-key/v1", "alg": "Ed25519",
        "public_key": b64(public), "public_key_fingerprint": "sha256:" + hashlib.sha256(public).hexdigest(),
        "active_from": "0001-01-01T00:00:00.000Z", "active_until": None}]},
    "receipts": {
        "refund": receipt("refund_allow", "refund.create"),
        "mcp": receipt("mcp_allow", "mcp_demo.email.send", "auth_fixture"),
        "cross_action": receipt("cross_action", "another.action"),
        "cross_authorization": receipt("cross_authorization", "refund.create", "auth_other"),
        "cross_decision": receipt("cross_decision", "refund.create", decision="deny", reason="policy_rule_matched"),
        "cross_reason": receipt("cross_reason", "refund.create", reason="another_reason"),
    },
}, indent=2))
