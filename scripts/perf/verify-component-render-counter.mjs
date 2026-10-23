import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { installComponentRenderCounter, instrumentComponentRenderEntries } from './component-render-counter.mjs';

const win = new Window();
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? win : win[key] });
}
const counter = installComponentRenderCounter();
const require = createRequire(import.meta.url);
const Module = require('node:module');
const original = Module._extensions['.js'];
let instrumentedEntries = 0;
Module._extensions['.js'] = (module, filename) => {
  if (!filename.endsWith('/react-dom-client.development.js')) return original(module, filename);
  const result = instrumentComponentRenderEntries(readFileSync(filename, 'utf8'));
  assert.equal(result.functions, 1);
  assert.equal(result.classes, 1);
  instrumentedEntries += 2;
  module._compile(result.source, filename);
};
const React = require('react');
const { createRoot } = require('react-dom/client');
const { flushSync } = require('react-dom');
Module._extensions['.js'] = original;
assert.equal(instrumentedEntries, 2);
const results = [];
for (const nested of [false, true]) {
  let sidebar = 0;
  let child = 0;
  let bump;
  function SidebarChild({ value }) { child++; return React.createElement('span', null, value); }
  const Sidebar = React.memo(function Sidebar() {
    sidebar++;
    const [value, setValue] = React.useState(0);
    bump = () => setValue((previous) => previous + 1);
    return nested ? React.createElement(SidebarChild, { value }) : React.createElement('span', null, value);
  });
  function App({ value }) { return React.createElement('div', null, React.createElement(Sidebar), value); }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(React.createElement(App, { value: 0 })));
  flushSync(() => bump());
  for (const mode of ['bailout', 'update']) {
    const before = sidebar + child;
    counter.start();
    for (let i = 1; i <= 50; i++) flushSync(() => mode === 'bailout' ? root.render(React.createElement(App, { value: i })) : bump());
    const measured = counter.stop();
    const actual = sidebar + child - before;
    assert.equal(measured.areas.sidebar, actual);
    assert.equal(measured.missingFiber, 0);
    assert.equal(actual, mode === 'bailout' ? 0 : nested ? 100 : 50);
    results.push({ nested, mode, actual, measured: measured.areas.sidebar });
  }
  flushSync(() => root.unmount());
  host.remove();
}
let actual = 0;
const TranscriptChild = React.forwardRef(function TranscriptChild() { actual++; return null; });
class OtherClass extends React.Component { render() { actual++; return null; } }
function MessageList() { actual++; return React.createElement(TranscriptChild); }
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
counter.start();
flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(MessageList), React.createElement(OtherClass))));
const strict = counter.stop();
assert.equal(strict.areas.transcript, 4);
assert.equal(strict.areas.other, 2);
assert.equal(strict.areas.transcript + strict.areas.other, actual);
assert.equal(strict.missingFiber, 0);
results.push({ mode: 'strict-forwardRef-class', actual, measured: strict.areas.transcript + strict.areas.other });
flushSync(() => root.unmount());
host.remove();
await win.happyDOM.close();
console.log(JSON.stringify(results));
