// Entry module: loads the Signal Chain and Mixer tabs and applies the color theme picked in the header.

import './signalchain.js';
import './mixer.js';

// --- Theme ---

const THEME_ICONS = { auto: 'circle-half-stroke', light: 'sun-bright', dark: 'moon' };
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

function applyTheme(mode) {
  const isDark = mode === 'dark' || (mode === 'auto' && darkQuery.matches);
  document.documentElement.classList.toggle('wa-dark', isDark);
  document.getElementById('theme-icon').name = THEME_ICONS[mode];
}

function setTheme(mode) {
  localStorage.setItem('colorScheme', mode);
  applyTheme(mode);
}

applyTheme(localStorage.getItem('colorScheme') || 'auto');
darkQuery.addEventListener('change', () => {
  applyTheme(localStorage.getItem('colorScheme') || 'auto');
});

document.getElementById('theme-dropdown').addEventListener('wa-select', (e) => {
  setTheme(e.detail.item.value);
});
