import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeExport } from './normalize-export.mjs';

// A separate root keeps local previews away from production releases and state.
const app = path.dirname(fileURLToPath(import.meta.url));
const site = path.join(app, '.preview');
const examples = path.join(app, 'examples');
fs.mkdirSync(site, { recursive: true });
const { navigation } = normalizeExport(examples, site);
fs.cpSync(path.join(app, 'template'), site, { recursive: true });
fs.copyFileSync(path.join(examples, 'index.md'), path.join(site, 'index.md'));
fs.writeFileSync(path.join(site, '.vitepress', 'sidebar.json'), JSON.stringify(navigation));
const cli = path.join(app, 'node_modules', 'vitepress', 'bin', 'vitepress.js');
const built = spawnSync(process.execPath, [cli, 'build', site], {
  cwd: app, stdio: 'inherit', env: { ...process.env, SITE_URL: 'http://localhost:4173' },
});
if (built.error) throw built.error;
if (built.status !== 0) throw new Error('Preview build failed.');
console.log('Preview ready. Run npm run preview to open the example site.');
