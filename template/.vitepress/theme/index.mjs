import DefaultTheme from 'vitepress/theme';
import { h } from 'vue';
import { installCodeCopy } from './code-copy.mjs';
import WidePageToggle from './WidePageToggle.vue';
import './style.css';
export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'nav-bar-content-after': () => h(WidePageToggle),
  }),
  enhanceApp() {
    if (!import.meta.env.SSR) installCodeCopy(document);
  },
};
