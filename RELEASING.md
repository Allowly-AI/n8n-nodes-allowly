# Releasing

Releases are published from GitHub Actions with npm provenance for n8n verified community-node eligibility.

Before the first release:

- Push this repository to `Allowly-AI/n8n-nodes-allowly`.
- In npm, configure Trusted Publishers for this package using the GitHub repository and `.github/workflows/publish.yml`.
- Run `npm run typecheck`, `npm run lint`, and `npm run build`.

To release, run `npm run release` locally. The local command creates the version commit, tag, and GitHub release. When the tag is pushed, GitHub Actions publishes the package to npm with provenance.

After the first npm publish, run `npm run scan` before submitting the package in the n8n Creator Portal. The scanner checks the package from npm, so it returns a 404 until the first package version exists.
