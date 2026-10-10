import { build } from 'esbuild';

// Generated from the maintained local SDK, never a second execution implementation.
await build({
  entryPoints: ['scripts/execution-sdk-entry.mjs'],
  outfile: 'dist/nodes/Allowly/execution-sdk.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
});
