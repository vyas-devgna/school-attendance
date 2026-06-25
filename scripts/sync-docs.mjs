import { cpSync, mkdirSync, rmSync } from 'node:fs';

for (const dir of ['admin', 'app', 'shared']) {
  const target = `docs/${dir}`;
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(dir, target, { recursive: true });
}
console.log('Synced admin/, app/, and shared/ into docs/.');
