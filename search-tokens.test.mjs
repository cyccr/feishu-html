import { test } from 'node:test';
import assert from 'node:assert/strict';
import MiniSearch from 'minisearch';
import { docsMiniSearch } from './template/.vitepress/search-tokens.mjs';

test('Chinese substrings in published sections are searchable alongside SDK identifiers', () => {
  const options = {
    fields: ['title', 'titles', 'text'],
    searchOptions: { prefix: true, fuzzy: 0.2, ...docsMiniSearch.searchOptions },
    ...docsMiniSearch.options,
  };
  const index = new MiniSearch(options);
  index.addAll([
    { id: 'download', title: '杰理SDK仓库总链：', titles: '杰理SDK汇总与下载', text: '见协议初始化说明。' },
    { id: 'flags', title: '示例', titles: '开发指南', text: 'AC632N 的 CONFIG_DEBUG_LIB 宏与 C++ 接口' },
    { id: 'other', title: '汇总与链接', titles: '手册', text: '其他链接' },
  ]);
  const browserIndex = MiniSearch.loadJSON(JSON.stringify(index), options);
  const hits = q => browserIndex.search(q).map(hit => hit.id);
  for (const query of ['总链', '仓库总链', '杰理SDK仓库总链', '协议初始', '汇总与下载']) {
    assert.deepEqual(hits(query), ['download'], query);
  }
  for (const query of ['ac632n', 'CONFIG_DEBUG_LIB', 'C++', '开发指南']) {
    assert.deepEqual(hits(query), ['flags'], query);
  }
  assert.ok(hits('链').includes('download'));
});
