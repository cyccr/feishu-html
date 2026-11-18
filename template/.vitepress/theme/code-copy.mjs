// VitePress 1.6 trims shell examples and removes prompt prefixes on copy.
// Copy the code element itself so the clipboard agrees with the static HTML.
export function installCodeCopy(doc) {
  const win = doc.defaultView;
  const timers = new WeakMap();
  doc.addEventListener('click', async event => {
    const button = event.target.closest?.('div[class*="language-"] > button.copy');
    const code = button?.parentElement.querySelector('pre > code');
    if (!code) return;
    event.stopPropagation(); // The default handler is delegated to window.
    const value = code.textContent;
    try {
      await win.navigator.clipboard.writeText(value);
    } catch {
      // Non-HTTPS self-hosted previews may only have the legacy copy API.
      const input = doc.createElement('textarea');
      input.value = value;
      input.readOnly = true;
      input.style.cssText = 'position:fixed;left:-9999px;top:0';
      const focused = doc.activeElement;
      const selection = doc.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      doc.body.append(input);
      try {
        input.select();
        if (!doc.execCommand?.('copy')) return;
      } catch {
        return;
      } finally {
        input.remove();
        focused?.focus({ preventScroll: true });
        if (range) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    }
    button.classList.add('copied');
    win.clearTimeout(timers.get(button));
    timers.set(button, win.setTimeout(() => button.classList.remove('copied'), 2000));
  });
}
