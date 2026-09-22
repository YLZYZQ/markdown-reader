'use strict';

(function () {
  const body = document.body;
  const navButtons = new Map([
    ['guide', document.getElementById('btn-guide')],
    ['about', document.getElementById('btn-about')]
  ]);
  const sections = new Map([
    ['guide', document.getElementById('guide')],
    ['about', document.getElementById('about')]
  ]);
  let systemTheme = 'light';
  let themePreference = 'system';

  function currentTheme() {
    return themePreference === 'system' ? systemTheme : themePreference;
  }

  function applyTheme() {
    const theme = currentTheme();
    document.body.classList.remove('theme-light', 'theme-cream', 'theme-dark');
    body.classList.toggle('theme-light', theme === 'light');
    body.classList.toggle('theme-cream', theme === 'cream');
    body.classList.toggle('theme-dark', theme === 'dark');
  }

  function selectSection(section, shouldFocus = false) {
    const next = sections.has(section) ? section : 'guide';
    for (const [name, element] of sections) element.hidden = name !== next;
    for (const [name, button] of navButtons) {
      const active = name === next;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    body.dataset.section = next;
    document.title = next === 'about' ? '关于 Markdown阅读器' : 'Markdown阅读器帮助';
    if (shouldFocus) navButtons.get(next).focus();
    else document.querySelector('.help-main').scrollTop = 0;
  }

  function applyState(state) {
    if (!state) return;
    if (state.systemTheme === 'light' || state.systemTheme === 'dark') systemTheme = state.systemTheme;
    if (['system', 'light', 'cream', 'dark'].includes(state.themePreference)) {
      themePreference = state.themePreference;
    }
    if (state.version) {
      document.getElementById('help-version').textContent = `v${state.version}`;
      document.getElementById('about-version').textContent = state.version;
    }
    applyTheme();
  }

  for (const [name, button] of navButtons) {
    button.addEventListener('click', () => selectSection(name));
  }

  document.getElementById('open-source-link').addEventListener('click', async (event) => {
    event.preventDefault();
    await window.api.openExternal(event.currentTarget.href);
  });

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    selectSection('guide');
  });

  window.addEventListener('help:showSection', (event) => selectSection(event.detail?.section));
  window.api.onHelpStateChanged(applyState);
  window.api.onSystemThemeChanged((theme) => {
    if (theme === 'light' || theme === 'dark') {
      systemTheme = theme;
      applyTheme();
    }
  });

  window.helpApi = {
    selectSection,
    getState: () => ({
      themePreference,
      systemTheme,
      renderedTheme: currentTheme(),
      activeSection: body.dataset.section,
      title: document.title
    })
  };

  selectSection('guide');
  window.api.getHelpState().then(applyState).catch(() => applyTheme());
})();
