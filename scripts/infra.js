import { spawn } from 'node:child_process';
import { z } from 'zod';
import { projectRoot } from '../apps/server/src/config/env.js';
import { setupStorage } from './setup-storage.js';

const command = z.enum(['up', 'down']).parse(process.argv[2]);

function compose(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', ...args], {
      cwd: projectRoot,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error('Docker Compose exited with ' + code)));
  });
}

try {
  if (command === 'up') {
    await compose(['up', '-d', '--wait', '--wait-timeout', '120']);
    await setupStorage();
  } else {
    // Named volumes deliberately survive normal shutdown.
    await compose(['down']);
  }
} catch (error) {
  console.error(error.message);
  console.error('Start Docker Desktop with Linux containers, then retry. Existing volumes were not removed.');
  process.exitCode = 1;
}
