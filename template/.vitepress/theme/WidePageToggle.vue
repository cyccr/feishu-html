<script setup>
import { computed, onMounted, ref } from 'vue';

const storageKey = 'feishu-docs-wide-page';
const wide = ref(false);
const actionLabel = computed(() => wide.value ? '恢复标准宽度' : '展开阅读宽度');

function applyWidth(enabled) {
  wide.value = enabled;
  document.documentElement.classList.toggle('feishu-wide-page', enabled);
}

function toggleWidth() {
  applyWidth(!wide.value);
  try {
    localStorage.setItem(storageKey, wide.value ? '1' : '0');
  } catch {
    // The current page can still switch width when browser storage is unavailable.
  }
}

onMounted(() => {
  try {
    applyWidth(localStorage.getItem(storageKey) === '1');
  } catch {
    applyWidth(false);
  }
});
</script>

<template>
  <button
    class="wide-page-toggle"
    type="button"
    :aria-pressed="wide"
    :aria-label="actionLabel"
    :title="actionLabel"
    @click="toggleWidth"
  >
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path v-if="wide" d="m3 7 5 5-5 5M8 12H2m19-5-5 5 5 5m-5-5h6" />
      <path v-else d="m8 7-5 5 5 5M3 12h18m-5-5 5 5-5 5" />
    </svg>
  </button>
</template>

<style scoped>
.wide-page-toggle {
  display: none;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-left: 8px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background-color: var(--vp-c-bg-soft);
  box-shadow: 0 1px 3px rgb(0 0 0 / 10%);
  color: var(--vp-c-text-2);
  transition: color .15s, background-color .15s, box-shadow .15s;
  cursor: pointer;
}
.wide-page-toggle:hover {
  color: var(--vp-c-text-1);
  background-color: var(--vp-c-default-soft);
}
.wide-page-toggle[aria-pressed='true'] {
  color: var(--vp-c-brand-1);
  background-color: color-mix(in srgb, var(--vp-c-brand-1) 12%, transparent);
}
.wide-page-toggle:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 3px;
}
@media (min-width: 960px) {
  .wide-page-toggle { display: inline-flex; }
}
</style>
