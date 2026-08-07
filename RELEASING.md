# Releasing

Releases are published from GitHub Actions with npm provenance for n8n verified community-node eligibility.

Before the first release:

- Push this repository publicly to `Allowly-AI/n8n-nodes-allowly`.
- Add a temporary granular npm publish token as the `npm-publish` environment secret `NPM_TOKEN`.
- Run `npm run typecheck`, `npm run lint`, and `npm run build`.

Because `main` is protected, make version changes through a pull request. After it merges, manually run the `Publish` workflow against `main` and approve its `npm-publish` deployment. The environment is restricted to `main`, requires the Allowly owner account's approval, and has admin bypass disabled; the workflow also rejects any other ref or stale commit. It publishes the package to npm with provenance. After publication, tag that commit as `v<package-version>` and create the GitHub release. Do not run the local release command on `main`; it tries to push a version commit directly.

After the first npm publish, run `npm run scan` before submitting the package in the n8n Creator Portal. The scanner checks the package from npm, so it returns a 404 until the first package version exists.

After that first publish, configure npm Trusted Publishers for `Allowly-AI/n8n-nodes-allowly`, `publish.yml`, and environment `npm-publish`, then delete the `NPM_TOKEN` environment secret and revoke the temporary token.
