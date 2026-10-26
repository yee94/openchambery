const search = document.querySelector('.docs-search');
const input = document.querySelector('#docs-search');
const results = document.querySelector('#docs-results');
const navigation = document.querySelector('.docs-nav-body>nav');
const menu = document.querySelector('.docs-menu');
const mobile = window.matchMedia('(max-width: 900px)');
const syncMenu = () => { if (menu) menu.open = !mobile.matches; };
syncMenu();
mobile.addEventListener('change', syncMenu);

if (search && input && results && navigation) {
  search.hidden = false;
  const entries = [...results.querySelectorAll('[data-search]')];
  const empty = results.querySelector('.docs-empty');
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    results.hidden = !query;
    navigation.hidden = Boolean(query);
    let matches = 0;
    for (const entry of entries) {
      entry.hidden = !entry.dataset.search.includes(query);
      if (!entry.hidden) matches++;
    }
    empty.hidden = matches !== 0;
  });
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    input.value = '';
    results.hidden = true;
    navigation.hidden = false;
  });
}

const sidebar = document.querySelector('.docs-sidebar');
if (sidebar && navigation) {
  const storageKey = `yuri:docs-navigation:${document.documentElement.lang}`;
  const sections = [...navigation.querySelectorAll('details.docs-section')];
  const sectionKey = (section) => section.querySelector('a')?.getAttribute('href');
  if (!mobile.matches) {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(storageKey));
      if (saved && Number.isFinite(saved.scrollTop) && saved.scrollTop >= 0) {
        for (const section of sections) {
          const open = saved.sections?.[sectionKey(section)];
          if (typeof open === 'boolean') section.open = open;
        }
        sidebar.scrollTop = saved.scrollTop;
      }
    } catch {
      // Remembering navigation is optional when session storage is unavailable.
    }
  }
  window.addEventListener('pagehide', () => {
    // Mobile uses document scrolling; filtered results have different geometry.
    if (mobile.matches || navigation.hidden) return;
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify({
        scrollTop: sidebar.scrollTop,
        sections: Object.fromEntries(sections.map((section) => [sectionKey(section), section.open])),
      }));
    } catch {
      // Storage restrictions must not prevent ordinary article navigation.
    }
  });
}
