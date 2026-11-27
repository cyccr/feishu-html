// VitePress serializes this function into the browser bundle. Keep it self-contained.
export function tokenizeDocs(text, fieldName) {
  const tokens = [];
  for (const [part] of text.normalize('NFKC').matchAll(/\p{Script=Han}+|[^\p{Script=Han}\s\p{P}]+/gu)) {
    if (!/\p{Script=Han}/u.test(part)) {
      tokens.push(part);
      continue;
    }
    const chars = Array.from(part);
    for (let i = 0; i < chars.length; i++) {
      // Index single characters for one-character queries. For longer queries
      // use adjacent pairs, so searching 总链 does not match 总 and 链 separately.
      if (fieldName || chars.length === 1) tokens.push(chars[i]);
      if (i + 1 < chars.length) tokens.push(chars[i] + chars[i + 1]);
    }
  }
  return tokens;
}

export const docsMiniSearch = {
  options: { tokenize: tokenizeDocs },
  searchOptions: { combineWith: 'AND' },
};
