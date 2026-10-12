# Changelog

## 0.5.1

- Use the platform temporary directory for durable-execution tests so Linux
  release checks run without a macOS-only path. Runtime behavior is unchanged.

## 0.5.0

- Use the published SDK 0.8.0 and verifier 5.0.0 with registry-backed locks
  and recorded bundle provenance. This breaking release accepts wire 5 only.
- Author exact immutable policy editions with typed OPA conditions, and resume
  saved Execute reviews through status or verified resolution webhooks.
- Keep standalone conformance and example tests independent of sibling repos.
