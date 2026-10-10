// Rebuild the local, unpublished wire-5 SEAL verifier; never fetch source from a registry.
import { build } from "esbuild";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(process.argv[2] || resolve(root, "../allowly-receipt-format/verifiers/typescript"));
const pkg = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"));
if (pkg.name !== "@allowly/verifier" || pkg.version !== "5.0.0") throw new Error("Expected local @allowly/verifier 5.0.0 source");
const bundlePath = "nodes/Allowly/seal-verifier.js";
await build({
  stdin: {
    contents: 'export { SEAL_MAX_DEPTH, SEAL_MAX_UTF8_BYTES, SEAL_PROFILE, SealInputError, hashSealJson, hashSealValue, loadKeysFromJson, publicKeyFingerprint, decodeReceipt, verifySealJson, verifySealValue } from "./dist/verifier.js";',
    resolveDir: source,
    sourcefile: "seal-verifier-entry.js",
    loader: "js",
  },
  outfile: resolve(root, bundlePath),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  banner: { js: "/* Bundled from local unpublished @allowly/verifier 5.0.0; wire 5 only. See VERIFIER_PROVENANCE.json. */" },
});
const fixtures = {};
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
for (const name of ["profile-v1.json", "verification-v1.json"]) {
  const destination = "test/fixtures/seal/" + name;
  await copyFile(resolve(source, "../../vectors/seal", name), resolve(root, destination));
  fixtures[destination] = await sha256(resolve(root, destination));
}
await writeFile(resolve(root, "VERIFIER_PROVENANCE.json"), JSON.stringify({
  source_package: pkg.name,
  source_version: pkg.version,
  source_repository: "https://github.com/Allowly-AI/allowly-receipt-format",
  source_base_commit: execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  source_status: execFileSync("git", ["-C", source, "status", "--porcelain"], { encoding: "utf8" }).trim() ? "local_uncommitted" : "local_committed",
  bundle: { path: bundlePath, sha256: await sha256(resolve(root, bundlePath)) },
  fixtures,
}, null, 2) + "\n");
console.log("Rebuilt local wire-5 SEAL bundle and signed conformance fixtures");
