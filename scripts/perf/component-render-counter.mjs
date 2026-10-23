/** Install before React DOM. Counts calls at the instrumented render entry, including retries. */
export function installComponentRenderCounter(target = globalThis) {
  let enabled = false;
  let missingFiber = 0;
  const counts = new Map();
  let hydrationInputs = new WeakMap();
  const hydration = { calls: 0, first: 0, enabledChanges: 0, childrenChanges: 0, unchanged: 0, childProps: {}, owners: {} };
  const renderers = new Map();
  const previous = target.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const hook = previous ?? {
    supportsFiber: true,
    renderers,
    onCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  };
  const inject = hook.inject;
  hook.inject = function (renderer) {
    const id = inject ? inject.call(this, renderer) : renderers.size + 1;
    renderers.set(id, renderer);
    return id;
  };
  target.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  const nameOf = (type) => type?.displayName || type?.name || type?.render?.displayName || type?.render?.name || type?.type?.displayName || type?.type?.name;
  const snapshot = () => {
    const areas = { sidebar: 0, transcript: 0, other: 0 };
    const components = [...counts.values()].map((entry) => ({ ...entry }));
    for (const entry of components) areas[entry.area] += entry.count;
    components.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { areas, components, missingFiber, hydration: { ...hydration } };
  };
  const counter = {
    start() {
      counts.clear(); missingFiber = 0; enabled = true;
      hydrationInputs = new WeakMap();
      Object.assign(hydration, { calls: 0, first: 0, enabledChanges: 0, childrenChanges: 0, unchanged: 0, childProps: {}, owners: {} });
    },
    stop() { enabled = false; return snapshot(); },
    snapshot,
    record(component, props) {
      if (!enabled) return;
      let fiber;
      for (const renderer of renderers.values()) {
        fiber = renderer.getCurrentFiber?.();
        if (fiber) break;
      }
      if (!fiber) { missingFiber += 1; return; }
      let area = 'other';
      for (let owner = fiber; owner; owner = owner.return) {
        const name = nameOf(owner.type);
        if (name === 'SessionSidebar' || name === 'Sidebar') { area = 'sidebar'; break; }
        if (name === 'MessageList' || name === 'ChatViewport' || name === 'ChatInput') { area = 'transcript'; break; }
      }
      const name = nameOf(component) || nameOf(fiber.type) || 'Anonymous';
      if (name === 'MarkdownHydrationProvider' && props) {
        hydration.calls += 1;
        const owner = nameOf(fiber.return?.type) || 'host';
        hydration.owners[owner] = (hydration.owners[owner] || 0) + 1;
        const old = hydrationInputs.get(fiber) ?? hydrationInputs.get(fiber.alternate) ?? fiber.alternate?.memoizedProps;
        if (!old) hydration.first += 1;
        else {
          if (old.enabled !== props.enabled) hydration.enabledChanges += 1;
          if (old.children !== props.children) hydration.childrenChanges += 1;
          if (old.enabled === props.enabled && old.children === props.children) hydration.unchanged += 1;
          const before = old.children?.props ?? {};
          const after = props.children?.props ?? {};
          for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (!Object.is(before[key], after[key])) hydration.childProps[key] = (hydration.childProps[key] || 0) + 1;
          }
        }
        hydrationInputs.set(fiber, props);
        if (fiber.alternate) hydrationInputs.set(fiber.alternate, props);
      }
      const key = `${area}:${name}`;
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { area, name, count: 1 });
    },
  };
  target.__componentRenderCounter = counter;
  return counter;
}

/** Test-only response transform. It never modifies the installed React package. */
export function instrumentComponentRenderEntries(source) {
  let functions = 0;
  let classes = 0;
  const instrumented = source
    .replace(/return Component\(props, secondArg\);/g, (call) => {
      functions += 1;
      return `globalThis.__componentRenderCounter?.record(Component, props); ${call}`;
    })
    .replace(/return instance\.render\(\);/g, (call) => {
      classes += 1;
      return `globalThis.__componentRenderCounter?.record(instance.constructor); ${call}`;
    });
  return { source: instrumented, functions, classes };
}
