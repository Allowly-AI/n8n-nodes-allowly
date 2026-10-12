// Rebuild from the installed, registry-locked verifier release.
import { build } from "esbuild";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/@allowly/verifier");
const pkg = JSON.parse(await readFile(resolve(source, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
const entry = lock.packages?.["node_modules/@allowly/verifier"];
if (pkg.name !== "@allowly/verifier" || pkg.version !== "5.0.0" || entry?.version !== pkg.version || entry.link) {
  throw new Error("Expected registry-locked @allowly/verifier 5.0.0");
}
const published = JSON.parse(execFileSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "dist", "gitHead",
  "--json", "--prefer-online", "--registry=https://registry.npmjs.org"], { encoding: "utf8" }));
if (published.version !== pkg.version || entry.resolved !== `https://registry.npmjs.org/@allowly/verifier/-/verifier-${pkg.version}.tgz`
  || entry.resolved !== published.dist?.tarball || !/^sha512-/.test(entry.integrity ?? "")
  || entry.integrity !== published.dist?.integrity || !/^[a-f0-9]{40}$/.test(published.gitHead ?? "")) {
  throw new Error("Verifier lock does not match the published npm release");
}
const routingFixture = "test/fixtures/official-check-receipt.json";
if (JSON.parse(await readFile(resolve(root, routingFixture), "utf8")).source_commit !== published.gitHead) {
  throw new Error("Official Check receipt fixture must come from the published verifier commit");
}
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
  banner: { js: "/* Bundled from published @allowly/verifier 5.0.0; wire 5 only. See VERIFIER_PROVENANCE.json. */" },
});
const fixtures = {};
const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
for (const name of ["profile-v1.json", "verification-v1.json"]) {
  const destination = "test/fixtures/seal/" + name;
  await copyFile(resolve(source, "dist/vectors/seal", name), resolve(root, destination));
  fixtures[destination] = await sha256(resolve(root, destination));
}
fixtures[routingFixture] = await sha256(resolve(root, routingFixture));
await writeFile(resolve(root, "VERIFIER_PROVENANCE.json"), JSON.stringify({
  source_package: pkg.name,
  source_version: pkg.version,
  source_repository: "https://github.com/Allowly-AI/allowly-receipt-format",
  source_base_commit: published.gitHead,
  source_status: "published_registry",
  source_tarball: entry.resolved,
  source_integrity: entry.integrity,
  bundle: { path: bundlePath, sha256: await sha256(resolve(root, bundlePath)) },
  fixtures,
}, null, 2) + "\n");
console.log("Rebuilt published wire-5 SEAL bundle and signed conformance fixtures");
