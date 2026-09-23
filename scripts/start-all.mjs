// Starts the API and the dashboard together, with prefixed output.
// Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  ['api', ['run', 'dev'], '\x1b[36m'],
  ['web', ['run', 'web'], '\x1b[35m'],
].map(([name, args, colour]) => {
  const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `${colour}[${name}]\x1b[0m `;
  const out = (stream) => (chunk) =>
    stream.write(chunk.toString().split('\n').filter(Boolean).map((l) => tag + l).join('\n') + '\n');
  p.stdout.on('data', out(process.stdout));
  p.stderr.on('data', out(process.stderr));
  p.on('exit', (code) => { console.log(`${tag}exited (${code})`); stop(); });
  return p;
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill('SIGINT');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('Nightwatch: API on http://localhost:3000, dashboard on http://localhost:5273 — Ctrl+C to stop.');
