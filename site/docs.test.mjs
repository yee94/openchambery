import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Window } from 'happy-dom';

const renderer = fileURLToPath(new URL('./src/build-docs.mjs', import.meta.url));
function evaluate(expression) {
  return execFileSync('bun', ['--eval', `import { parsePage, renderContent } from ${JSON.stringify(renderer)}; console.log(JSON.stringify(${expression}));`], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('handbook publication contracts', () => {
  it('uses the active language for legacy documentation links and keeps download links on the site', () => {
    const body = '# Title\n\n[Other](/voice/) [Download](/#downloads)';
    const html = JSON.parse(evaluate(`renderContent(${JSON.stringify(body)}, 'zh-cn', new Set(['/voice/']))`));
    expect(html).toContain('href="/docs/voice/"');
    expect(html).toContain('href="/#downloads"');
    expect(html).not.toContain('<h1');
  });

  it('renders tables, code, Unicode anchors and native disclosures without executing MDX', () => {
    const body = '\n# Title\n\n## 手机输入\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```html\n<script>example</script>\n```\n\n<details>\n<summary>More</summary>\n\nContent\n\n</details>\n\n## 手机输入';
    const html = JSON.parse(evaluate(`renderContent(${JSON.stringify(body)}, 'en', new Set())`));
    expect(html).toContain('<table>');
    expect(html).toContain('<h2 id="手机输入">');
    expect(html).toContain('<h2 id="手机输入-1">');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<details>');
    expect(html).not.toContain('<h1');
  });

  it('fails a build for an unknown internal target instead of publishing a broken link', () => {
    expect(() => evaluate(`renderContent('[Missing](/missing/)', 'en', new Set())`)).toThrow('Unknown documentation link');
  });

  it('keeps redirects as metadata and rejects executable MDX', () => {
    const source = '---\ntitle: Old\ndescription: Moved\nredirect: /projects/\n---\nSee projects.';
    const page = JSON.parse(evaluate(`parsePage(${JSON.stringify(source)}, 'old.mdx')`));
    expect(page.redirect).toBe('/projects/');
    const executable = '---\ntitle: Unsafe\ndescription: Example\n---\nimport Widget from "widget";';
    expect(() => evaluate(`parsePage(${JSON.stringify(executable)}, 'unsafe.mdx')`)).toThrow('executable MDX');
  });
});

describe('handbook navigation continuity', () => {
  const script = readFileSync(new URL('./assets/docs.js', import.meta.url), 'utf8');
  function openPage(previous, { mobile = false, blocked = false } = {}) {
    const window = new Window({ url: 'https://docs.example/docs/' });
    window.happyDOM.setWindowSize({ width: mobile ? 390 : 1440, height: 900 });
    window.document.documentElement.lang = 'zh-CN';
    window.document.body.innerHTML = `<aside class="docs-sidebar"><details class="docs-menu" open><summary>Browse</summary>
      <div class="docs-nav-body"><div class="docs-search" hidden><input id="docs-search"><div id="docs-results" hidden><p class="docs-empty" hidden></p></div></div>
      <nav><a href="/docs/magpie/">Magpie</a><details class="docs-section"><summary>Advanced</summary><a href="/docs/environment/">Environment</a></details></nav></div></details></aside>`;
    if (previous) {
      for (let i = 0; i < previous.sessionStorage.length; i++) {
        const key = previous.sessionStorage.key(i);
        window.sessionStorage.setItem(key, previous.sessionStorage.getItem(key));
      }
    }
    if (blocked) Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('Storage blocked'); } });
    runInNewContext(script, { window, document: window.document });
    return window;
  }

  it('keeps sidebar position and expanded groups when another article loads', () => {
    const first = openPage();
    first.document.querySelector('.docs-section').open = true;
    first.document.querySelector('.docs-sidebar').scrollTop = 480;
    first.dispatchEvent(new first.Event('pagehide'));
    const next = openPage(first);
    expect(next.document.querySelector('.docs-sidebar').scrollTop).toBe(480);
    expect(next.document.querySelector('.docs-section').open).toBe(true);
    next.document.querySelector('.docs-section').open = false;
    next.document.querySelector('.docs-sidebar').scrollTop = 120;
    next.dispatchEvent(new next.Event('pagehide'));
    const third = openPage(next);
    expect(third.document.querySelector('.docs-sidebar').scrollTop).toBe(120);
    expect(third.document.querySelector('.docs-section').open).toBe(false);
  });

  it('does not replace desktop position with the mobile page scroll', () => {
    const desktop = openPage();
    desktop.document.querySelector('.docs-sidebar').scrollTop = 480;
    desktop.dispatchEvent(new desktop.Event('pagehide'));
    const phone = openPage(desktop, { mobile: true });
    expect(phone.document.querySelector('.docs-menu').open).toBe(false);
    phone.dispatchEvent(new phone.Event('pagehide'));
    expect(openPage(phone).document.querySelector('.docs-sidebar').scrollTop).toBe(480);
  });

  it('keeps navigation and filtering usable when storage is blocked or malformed', () => {
    const blocked = openPage(null, { blocked: true });
    expect(blocked.document.querySelector('.docs-search').hidden).toBe(false);
    expect(() => blocked.dispatchEvent(new blocked.Event('pagehide'))).not.toThrow();
    const first = openPage();
    first.dispatchEvent(new first.Event('pagehide'));
    for (let i = 0; i < first.sessionStorage.length; i++) first.sessionStorage.setItem(first.sessionStorage.key(i), '{invalid');
    expect(openPage(first).document.querySelector('.docs-menu').open).toBe(true);
  });
});
