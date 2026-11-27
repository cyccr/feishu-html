// Runs in the document head so a click on the server-rendered button can be
// replayed after Vue mounts. No page navigation or prefetch on ordinary visits.
(() => {
  const selector = '#local-search button';
  const modal = '.VPLocalSearchBox';
  const retryKey = 'feishuSearchRetry';
  const root = document.documentElement;
  let ready = false;
  let retried = Boolean(history.state?.[retryKey]);
  let pending = retried;
  let observer;
  let timeout;
  let notice;

  if (retried) {
    const state = { ...history.state };
    delete state[retryKey];
    history.replaceState(state, '');
  }

  function clearPending() {
    pending = false;
    observer?.disconnect();
    clearTimeout(timeout);
    root.removeAttribute('data-search-opening');
  }

  function dismissNotice() {
    notice?.remove();
    notice = undefined;
  }

  function reloadForSearch() {
    try {
      history.replaceState({ ...history.state, [retryKey]: true }, '');
    } catch {
      // Manual retries still refresh on browsers that restrict history storage.
    }
    location.reload();
  }

  function offerRetry() {
    root.removeAttribute('data-search-opening');
    if (notice) return;
    notice = document.createElement('div');
    notice.className = 'feishu-search-error';
    notice.setAttribute('role', 'alert');
    notice.append('搜索未能加载。');
    for (const [label, action] of [['刷新并重试', reloadForSearch], ['关闭', () => { clearPending(); dismissNotice(); }]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', action);
      notice.append(button);
    }
    document.body.append(notice);
  }

  function requestOpen() {
    if (document.querySelector(modal)) return;
    // VitePress also saved "false" when readers had never touched the old
    // layout switch. Apply the new default once, then honor later choices.
    try {
      const migrated = 'feishu:search-excerpts-default-v1';
      if (localStorage.getItem(migrated) === null) {
        const layout = 'vitepress:local-search-detailed-list';
        if (localStorage.getItem(layout) === 'false') localStorage.removeItem(layout);
        localStorage.setItem(migrated, '1');
      }
    } catch {
      // Without persistent storage VitePress uses the configured default.
    }
    dismissNotice();
    pending = true;
    root.setAttribute('data-search-opening', '');
    if (!observer) observer = new MutationObserver(() => {
      if (document.querySelector(modal)) {
        clearPending();
        dismissNotice();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    clearTimeout(timeout);
    timeout = setTimeout(offerRetry, 15000);
  }

  document.addEventListener('click', event => {
    if (event.target.closest?.(selector)) requestOpen();
  }, true);

  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.repeat) return;
    const shortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k';
    const slash = event.key === '/' && !event.target.isContentEditable &&
      !event.target.closest?.('input, textarea, select');
    if ((!shortcut && !slash) || !document.querySelector(selector)) return;
    if (!ready) event.preventDefault();
    requestOpen();
  }, true);

  window.addEventListener('feishu:search-ready', () => {
    ready = true;
    if (pending && !document.querySelector(modal)) document.querySelector(selector)?.click();
  }, { once: true });

  // A page kept open across deployments can still refer to the previous
  // release's lazy modal or index. Never loop if the new release also fails.
  window.addEventListener('vite:preloadError', event => {
    if (!pending && !document.querySelector(modal)) return;
    const message = String(event.payload?.message ?? event.payload);
    if (!/VPLocalSearchBox|localSearchIndex|^Importing a module script failed\.?$/i.test(message)) return;
    if (!retried && navigator.onLine) {
      retried = true;
      reloadForSearch();
    } else {
      offerRetry();
    }
  });
})();
