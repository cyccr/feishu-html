import DefaultTheme from 'vitepress/theme';
import { installCodeCopy } from './code-copy.mjs';
import './style.css';
export default {
  extends: DefaultTheme,
  enhanceApp() {
    if (!import.meta.env.SSR) installCodeCopy(document);
  },
};
