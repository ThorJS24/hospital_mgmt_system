// Cross-platform launcher: node scripts/run-backend.mjs <secure|lab>
// "lab" enables the documented vulnerable scenarios; the server itself still refuses non-loopback binding.
import { spawn } from 'node:child_process';
import process from 'node:process';
const mode = process.argv[2] === 'lab' ? 'vulnerable' : 'secure';
const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'start', '-w', 'backend'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, LAB_MODE: mode },
});
child.on('exit', (c) => process.exit(c ?? 0));
