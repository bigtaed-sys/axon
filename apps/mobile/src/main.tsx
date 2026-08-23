import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@axon/ui';
import { installMobileHost } from './host-mobile.js';
// Стили формул и подсветки кода — до наших, чтобы их можно было перебить
// переменными темы, а не наоборот.
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';
import '@axon/ui/globals.css';
import './mobile.css';

installMobileHost({ version: __APP_VERSION__, builtAt: __APP_BUILT_AT__ });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
