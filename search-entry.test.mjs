import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const entry = fs.readFileSync(new URL('./template/.vitepress/search-entry.js', import.meta.url), 'utf8');

function setup(t, retry = false) {
  const dom = new JSDOM('<div id="local-search"><button>搜索</button></div><input>', {
    url: 'https://example.org/articles/demo.html', runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  if (retry) window.history.replaceState({ feishuSearchRetry: true, scroll: 30 }, '');
  window.eval(entry);
  const doc = window.document;
  const button = doc.querySelector('button');
  const ready = () => window.dispatchEvent(new window.Event('feishu:search-ready'));
  const fail = resource => {
    const event = new window.Event('vite:preloadError');
    event.payload = new TypeError('Failed to fetch dynamically imported module: /assets/chunks/' + resource);
    window.dispatchEvent(event);
  };
  return { doc, button, window, ready, fail };
}

test('search remembers early clicks and opens the hydrated dialog only once', async t => {
  const { doc, button, ready } = setup(t);
  button.click();
  button.click();
  let opened = 0;
  button.onclick = () => {
    opened++;
    doc.body.appendChild(doc.createElement('div')).className = 'VPLocalSearchBox';
  };
  ready();
  ready();
  await Promise.resolve();
  assert.equal(opened, 1);
  assert.equal(doc.documentElement.hasAttribute('data-search-opening'), false);
});

test('typing a slash in an input does not queue search before hydration', t => {
  const { window, doc, button, ready } = setup(t);
  doc.querySelector('input').dispatchEvent(new window.KeyboardEvent('keydown', { key: '/', bubbles: true }));
  let opened = 0;
  button.onclick = () => opened++;
  ready();
  assert.equal(opened, 0);
});

test('search replaces the old collapsed default only on the first open', t => {
  const { window, button } = setup(t);
  const key = 'vitepress:local-search-detailed-list';
  window.localStorage.setItem(key, 'false');
  button.click();
  assert.equal(window.localStorage.getItem(key), null);
  window.localStorage.setItem(key, 'false'); // The reader explicitly collapsed the new view.
  button.click();
  assert.equal(window.localStorage.getItem(key), 'false');
});

test('a restored search reopens once and offers a manual retry on repeated failure', t => {
  const { window, doc, button, ready, fail } = setup(t, true);
  let opened = 0;
  button.onclick = () => opened++;
  ready();
  assert.equal(opened, 1);
  assert.equal(window.history.state.scroll, 30);
  assert.equal(window.history.state.feishuSearchRetry, undefined);
  fail('some-unrelated-component.js');
  assert.equal(doc.querySelector('[role=alert]'), null);
  fail('VPLocalSearchBox.old.js');
  assert.match(doc.querySelector('[role=alert]').textContent, /刷新并重试/);
  doc.querySelector('.feishu-search-error button:last-child').click();
  assert.equal(doc.querySelector('[role=alert]'), null);
});
