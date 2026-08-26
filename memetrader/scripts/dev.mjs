#!/usr/bin/env node
/**
 * Single-command dev launcher: starts the API server and the Vite client together
 * and keeps their lifecycles tied, so `npm run dev` is all a user has to remember.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

const children = [];
let shuttingDown = false;

function run(name, command, args, color) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    shell: false,
  });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    stream.setEncoding('utf8');
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(`${prefix}exited (code=${code} signal=${signal ?? 'none'})\n`);
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
run('api', npx, ['tsx', 'watch', '--clear-screen=false', 'src/server/index.ts'], '36');
run('web', npx, ['vite'], '35');
