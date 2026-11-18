import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeExport, resolvePublicationScope } from './feishu-source.mjs';
import { normalizeExport } from './normalize-export.mjs';

test('missing scope cannot accidentally expand a selected subtree to the whole knowledge base', () => {
  assert.throws(() => resolvePublicationScope({}), /ROOT_NODE_TOKEN/);
  assert.deepEqual(resolvePublicationScope({ ROOT_NODE_TOKEN: 'chosen-node' }), { mode: 'subtree', rootNodeToken: 'chosen-node' });
});

test('explicit whole-space publication overrides a stale previous root and rejects unknown modes', () => {
  assert.deepEqual(resolvePublicationScope({ PUBLISH_SCOPE: 'space', ROOT_NODE_TOKEN: 'old-empty-page' }), { mode: 'space', rootNodeToken: '' });
  assert.throws(() => resolvePublicationScope({ PUBLISH_SCOPE: 'all' }), /PUBLISH_SCOPE/);
});

test('a separate space homepage is explicit and cannot change subtree publication', () => {
  assert.deepEqual(resolvePublicationScope({ PUBLISH_SCOPE: 'space', SPACE_HOME_NODE_TOKEN: ' home ' }), {
    mode: 'space', rootNodeToken: '', homeNodeToken: 'home',
  });
  assert.deepEqual(resolvePublicationScope({ ROOT_NODE_TOKEN: 'selected', SPACE_HOME_NODE_TOKEN: 'home' }), {
    mode: 'subtree', rootNodeToken: 'selected',
  });
});

function spaceFixture(t, homeSpace = 'space') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-space-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exported = path.join(root, 'export');
  fs.mkdirSync(path.join(exported, 'docs'), { recursive: true });
  for (const name of ['home', 'category', 'article']) {
    fs.writeFileSync(path.join(exported, 'docs', name + '.md'), `# ${name}\n\n${name} content`);
  }
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input);
    if (url.pathname.endsWith('/tenant_access_token/internal')) {
      return Response.json({ code: 0, tenant_access_token: 'test-token' });
    }
    let data;
    if (url.pathname.endsWith('/get_node')) {
      data = { node: { node_token: 'home', title: '知识库首页', obj_type: 'docx', space_id: homeSpace, has_child: false } };
    } else {
      const category = { node_token: 'category', title: '分类', obj_type: 'docx', has_child: true };
      const article = { node_token: 'article', title: '下级文章', obj_type: 'docx', has_child: false };
      data = { items: url.searchParams.get('parent_node_token') === 'category' ? [article] : [category] };
    }
    return Response.json({ code: 0, data });
  });
  return { root, exported, environment: { FEISHU_SPACE_ID: 'space', SITE_URL: 'https://example.com' } };
}

test('a space homepage with has_child false still publishes the complete directory and descendants', async t => {
  const { root, exported, environment } = spaceFixture(t);
  const counts = await completeExport(exported, { mode: 'space', rootNodeToken: '', homeNodeToken: 'home' }, environment);
  assert.equal(counts.documents, 3);
  const tree = JSON.parse(fs.readFileSync(path.join(exported, 'docs.json'), 'utf8'));
  assert.equal(tree[0].node_token, 'home');
  assert.equal(tree[0].children[0].node_token, 'category');
  assert.equal(tree[0].children[0].children[0].node_token, 'article');
  assert.match(fs.readFileSync(path.join(exported, 'docs', 'home.md'), 'utf8'), /\]\(\/articles\/category\.html\)/);
  const result = normalizeExport(exported, path.join(root, 'source'));
  assert.deepEqual(result.pages.map(page => page.link), ['/articles/home.html', '/articles/category.html', '/articles/article.html']);
});

test('a homepage from a different space cannot be added to a whole-space export', async t => {
  const { exported, environment } = spaceFixture(t, 'another-space');
  await assert.rejects(completeExport(exported, { mode: 'space', rootNodeToken: '', homeNodeToken: 'home' }, environment), /homepage belongs to a different knowledge base/);
  assert.equal(fs.existsSync(path.join(exported, 'docs.json')), false);
});
