import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeExport } from './normalize-export.mjs';
import { completeExport, resolvePublicationScope } from './feishu-source.mjs';
import { SITE_NAME } from './template/.vitepress/share-metadata.mjs';

if (process.argv.includes('--preview')) {
  await import('./preview.mjs');
  process.exit(0);
}

const APP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PUBLISH_ROOT || '/var/www/feishu-docs';
if (!process.env.SITE_URL) throw new Error('Set SITE_URL to the public origin of your website.');
const SITE = new URL(process.env.SITE_URL);
if (!['http:', 'https:'].includes(SITE.protocol) || SITE.pathname !== '/' || SITE.username || SITE.password || SITE.search || SITE.hash) {
  throw new Error('SITE_URL must be an HTTP(S) origin without a subdirectory.');
}
const workRoot = path.join(APP, 'work');
fs.mkdirSync(workRoot, { recursive: true });
const work = fs.mkdtempSync(path.join(workRoot, 'run-'));
const source = path.join(work, 'source');
const articles = path.join(source, 'articles');
const exported = path.join(work, 'export');
const release = path.join(ROOT, 'releases', `release-${Date.now()}`);

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: APP, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    timeout: 12 * 60 * 1000, ...options,
  });
  if (path.basename(program) === 'feishu-pages') {
    // Forward only the adapter's counts. Other exporter messages can contain API responses.
    for (const line of (result.stderr || '').split(/\r?\n/)) {
      if (/^Feishu conversion: document=[A-Za-z0-9_-]+ type=[A-Za-z0-9]+ count=[1-9]\d*$/.test(line)) console.warn(line);
    }
  }
  if (result.status !== 0 || result.error) {
    // Exporter output can contain API responses; do not write it to public files or logs.
    if (program.endsWith('vitepress')) {
      console.error((result.stderr || result.stdout || '').slice(-4000));
    }
    throw new Error(`${path.basename(program)} failed (exit ${result.status ?? 'timeout'}).`);
  }
  return result.stdout;
}

function exportFeishu(outputDirectory, rootNodeToken) {
  run(path.join(APP, 'node_modules', '.bin', 'feishu-pages'), [], {
    cwd: work,
    env: {
      ...process.env,
      OUTPUT_DIR: outputDirectory,
      BASE_URL: '/articles/',
      URL_STYLE: 'original',
      ROOT_NODE_TOKEN: rootNodeToken,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(path.join(APP, 'feishu-code-preload.cjs'))}`,
    },
  });
}

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in exported content.');
    return entry.isDirectory() ? filesBelow(full) : [full];
  }).sort();
}

function mdLabel(value) { return value.replace(/[\\[\]`*_<>]/g, '\\$&').replace(/[\r\n]+/g, ' '); }

try {
  fs.mkdirSync(articles, { recursive: true });
  let docs = [];
  let navigation = [];
  let scope;
  {
    const required = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_SPACE_ID'];
    const missing = required.filter(key => !process.env[key]?.trim());
    if (missing.length) throw new Error(`Missing configuration: ${missing.join(', ')}`);
    scope = resolvePublicationScope(process.env);
    console.log('Exporting the configured Feishu knowledge base.');
    exportFeishu(exported, scope.rootNodeToken);
    if (scope.homeNodeToken) {
      const homeExport = path.join(work, 'home-export');
      exportFeishu(homeExport, scope.homeNodeToken);
      fs.cpSync(path.join(homeExport, 'docs'), path.join(exported, 'docs'), { recursive: true });
    }
    const counts = await completeExport(exported, scope);
    console.log(`Prepared ${counts.documents} documents, ${counts.spreadsheets} spreadsheets and ${counts.files} files (${counts.pdfs} PDFs).`);
    ({ pages: docs, navigation } = normalizeExport(exported, source));
  }

  const hash = createHash('sha256').update(SITE.origin);
  for (const file of filesBelow(source)) {
    hash.update(path.relative(source, file)).update('\0').update(fs.readFileSync(file));
  }
  for (const file of filesBelow(path.join(APP, 'template'))) {
    hash.update(path.relative(APP, file)).update('\0').update(fs.readFileSync(file));
  }
  hash.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  hash.update(fs.readFileSync(path.join(APP, 'normalize-export.mjs')));
  hash.update(fs.readFileSync(path.join(APP, 'feishu-source.mjs')));
  hash.update(fs.readFileSync(path.join(APP, 'feishu-code-preload.cjs')));
  hash.update(JSON.stringify({ scope, spaceId: process.env.FEISHU_SPACE_ID, siteName: SITE_NAME }));
  hash.update(JSON.stringify(navigation));
  const digest = hash.digest('hex');
  const statePath = path.join(APP, '.state.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first publish */ }
  if (state?.digest === digest && fs.existsSync(path.join(ROOT, 'current', 'index.html'))) {
    console.log(`No content changes (${docs.length} documents).`);
  } else {
    fs.cpSync(path.join(APP, 'template'), source, { recursive: true });
    fs.writeFileSync(path.join(source, '.vitepress', 'sidebar.json'), JSON.stringify(navigation));
    const intro = '## 文档目录\n\n' + docs.map(doc => `${'  '.repeat(doc.depth)}- [${mdLabel(doc.text)}](${doc.link})`).join('\n') + '\n';
    fs.writeFileSync(path.join(source, 'index.md'), `---\ntitle: ${JSON.stringify(SITE_NAME)}\ndescription: 公开指南、使用说明与常见问题。\n---\n\n# ${mdLabel(SITE_NAME)}\n\n` + intro);
    const publicDir = path.join(source, 'public');
    fs.mkdirSync(publicDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE.origin}/sitemap.xml\n`);
    console.log(`Building ${docs.length} documents as static HTML.`);
    run(path.join(APP, 'node_modules', '.bin', 'vitepress'), ['build', source, '--outDir', release], {
      env: { ...process.env, SITE_URL: SITE.origin },
    });
    for (const name of ['index.html', '404.html', 'sitemap.xml', 'robots.txt']) {
      if (!fs.statSync(path.join(release, name)).isFile()) throw new Error(`Missing output: ${name}`);
    }
    const html = fs.readFileSync(path.join(release, 'index.html'), 'utf8');
    if (!html.includes('<main')) throw new Error('Static HTML verification failed.');
    for (const doc of docs) {
      if (!fs.statSync(path.join(release, doc.link)).isFile()) throw new Error('Missing article HTML.');
    }
    const temporaryLink = path.join(ROOT, `.current-${process.pid}`);
    fs.symlinkSync(release, temporaryLink, 'dir');
    fs.renameSync(temporaryLink, path.join(ROOT, 'current'));
    fs.writeFileSync(statePath, JSON.stringify({ digest, documents: docs.length, publishedAt: new Date().toISOString() }));
    console.log(`Published ${SITE.origin}/ (${docs.length} documents).`);
    // Only remove older release directories inside the dedicated release root.
    const releases = fs.readdirSync(path.join(ROOT, 'releases')).filter(name => /^release-\d+$/.test(name)).sort().reverse();
    for (const name of releases.slice(3)) {
      const target = path.join(ROOT, 'releases', name);
      if (target !== fs.realpathSync(path.join(ROOT, 'current'))) fs.rmSync(target, { recursive: true });
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
