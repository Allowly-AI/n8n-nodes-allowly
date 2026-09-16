# Third-party notices

`nodes/Allowly/seal-verifier.js` bundles these packages for local SEAL hashing
and receipt verification:

- `@allowly/verifier` 4.1.0 — Apache License 2.0
- `canonicalize` 3.0.0 — Apache License 2.0
- `lossless-json` 4.3.1 — MIT License

The corresponding license texts are included in `licenses/`.
`VERIFIER_PROVENANCE.json` records the source version and checksums. The test
suite runs every copied conformance vector through the checked-in bundle, so a
bundle or profile change must update and pass those fixtures together.
