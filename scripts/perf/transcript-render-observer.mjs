/** DOM evidence for the render window; no text, paths, or message payloads are retained. */
export function installTranscriptRenderObserver(target = globalThis) {
  let active = false;
  let startedAt = 0;
  let seenNodes = new WeakSet();
  let messageMounts = 0;
  let userMounts = 0;
  const ids = new Set();
  const users = new Set();
  const timeline = [];
  let lastSignature = '';
  const sample = () => {
    const scroll = target.document.querySelector('.chat-scroll');
    const messages = [...(scroll?.querySelectorAll('[data-message-id]') ?? [])];
    const userNodes = messages.filter((node) => node.matches('.oc-user-shell-hover-scope') || node.querySelector('.oc-user-shell-hover-scope'));
    const rows = scroll?.querySelectorAll('[data-turn-entry]').length ?? 0;
    const virtualRows = scroll?.querySelectorAll('[data-turn-entry][data-index]').length ?? 0;
    if (active) {
      const userSet = new Set(userNodes);
      for (const node of messages) {
        ids.add(node.dataset.messageId);
        if (userSet.has(node)) users.add(node.dataset.messageId);
        if (!seenNodes.has(node)) {
          seenNodes.add(node);
          messageMounts += 1;
          if (userSet.has(node)) userMounts += 1;
        }
      }
    }
    const state = { rows, messages: messages.length, users: userNodes.length, virtualRows, virtualized: virtualRows > 0 };
    const signature = JSON.stringify([state, messages.map((node) => node.dataset.messageId)]);
    if (active && signature !== lastSignature) {
      timeline.push({ at: Math.round(target.performance.now() - startedAt), ...state });
      lastSignature = signature;
    }
    return state;
  };
  const observer = new target.MutationObserver((records) => {
    if (active && records.some((record) => record.type === 'childList' || record.attributeName === 'data-index')) sample();
  });
  observer.observe(target.document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-index'] });
  target.__transcriptRenderObserver = {
    start() {
      startedAt = target.performance.now();
      seenNodes = new WeakSet();
      messageMounts = 0; userMounts = 0;
      ids.clear(); users.clear(); timeline.length = 0; lastSignature = '';
      active = true;
      return { epoch: target.performance.timeOrigin + startedAt, initial: sample() };
    },
    stop() {
      const final = sample();
      active = false;
      return { final, messageMounts, userMounts, uniqueMessages: ids.size, uniqueUsers: users.size, timeline };
    },
  };
}
