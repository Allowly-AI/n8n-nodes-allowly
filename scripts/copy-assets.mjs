import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const assets = [
  ['nodes/Allowly/allowly.svg', 'dist/nodes/Allowly/allowly.svg'],
  ['nodes/Allowly/allowly.svg', 'dist/credentials/allowly.svg'],
  ['nodes/Allowly/seal-verifier.js', 'dist/nodes/Allowly/seal-verifier.js'],
];

for (const [source, destination] of assets) {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}
