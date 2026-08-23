import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { installElectronHost } from './host-electron.js';
// Стили формул и подсветки кода — до наших, чтобы их можно было перебить
// переменными темы, а не наоборот.
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';
import './globals.css';

// Платформа задаётся до первой отрисовки: экраны спрашивают её сразу.
installElectronHost();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
