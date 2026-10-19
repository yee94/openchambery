import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

vi.mock('@/contexts/useThemeSystem', () => ({
  useOptionalThemeSystem: () => null,
}));

vi.mock('@/hooks/useEffectiveDirectory', () => ({
  useEffectiveDirectory: () => '/tmp/project',
}));

vi.mock('@/hooks/useRuntimeAPIs', () => ({
  useRuntimeAPIs: () => ({
    editor: undefined,
    runtime: { isVSCode: false },
  }),
}));

vi.mock('@/stores/useUIStore', () => {
  const state = {
    codeBlockLineWrap: false,
    setCodeBlockLineWrap: () => undefined,
    openContextPreview: () => undefined,
  };
  return {
    useUIStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  };
});

vi.mock('@/lib/platform', () => ({
  getClientPlatform: () => 'web' as const,
}));

vi.mock('@/lib/runtimeSurface', () => ({
  isMobileSurfaceRuntime: () => false,
}));

import { MarkstreamRenderer } from './MarkstreamRendererImpl';

const FENCE = ['```typescript', 'const openChamber = 1', 'console.log(openChamber)', '```'].join('\n');
const FENCE_STREAM_TAIL = ['```typescript', 'const openChamber = 1', 'console.log(openChamber)', 'const next = 2', '```'].join('\n');
const FENCE_B = ['```typescript', 'const otherMessage = 9', '```'].join('\n');
const FENCE_UNCLOSED = ['```typescript', 'const openChamber = 1  '].join('\n');
const FENCE_TILDE_WITH_BACKTICKS = ['~~~~markdown', 'docs use ```code``` fences', '~~~~'].join('\n');
const TWO_SAME_LANG = [
  '```typescript',
  'const first = 1',
  '```',
  '',
  '```typescript',
  'const second = 2',
  '```',
].join('\n');
// Real chat regression: ```text ASCII trees went blank because markstream-react
// looks up language overrides in the same map as the AST `text` node key.
const TEXT_ASCII_TREE_A = [
  '```text',
  'Trace / 一次小微请求',
  '|',
  '+-- ServerRun A',
  '|   +-- LLM #1',
  '|   +-- invokeMethod [toolCall_1]',
  '|   +-- Subagent / dispatching-hint',
  '|   |   +-- LLM',
  '|   +-- Think',
  '|   |',
  '|   |   [toolCall_1 结果回填，复用 Run A]',
  '|   |',
  '|   +-- LLM #2',
  '|   +-- invokeMethod [toolCall_2]',
  '|   +-- Abort [连接关闭，记录一次]',
  '|',
  '+-- ClientRun / toolCall_1',
  '|   +-- client/tools_call',
  '|   +-- tool_call_routed',
  '|   +-- 终态：ERROR / timeout.client',
  '|',
  '+-- ClientRun / toolCall_2',
  '    +-- 终态：cancelled / 结束等待',
  '```',
].join('\n');
const TEXT_ASCII_TREE_B = [
  '```text',
  'Trace / 一轮用户请求',
  '|',
  '+-- ServerRun A [首次 HTTP]',
  '|   +-- LLM',
  '|',
  '+-- ServerRun B [回填 HTTP，续跑]',
  '|   +-- LLM',
  '|',
  '+-- ServerRun C',
  '|   +-- LLM',
  '|',
  '+-- ClientRun',
  '    +-- 终态',
  '```',
].join('\n');
const TWO_TEXT_ASCII_TREES = `${TEXT_ASCII_TREE_A}\n\n${TEXT_ASCII_TREE_B}`;
const TEXT_ASCII_TREE_UNCLOSED = [
  '```text',
  'Trace / 一次小微请求',
  '|',
  '+-- ServerRun A',
  '|   +-- LLM #1',
].join('\n');

describe('MarkstreamRenderer fenced code blocks (OpenChamber chrome)', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.innerHTML = '';
  });

  const render = async (props: Partial<React.ComponentProps<typeof MarkstreamRenderer>> & { content: string }) => {
    await act(async () => {
      root.render(
        React.createElement(MarkstreamRenderer, {
          messageId: 'msg-code-regression',
          isAnimated: false,
          skipFadeIn: true,
          enableFileReferences: false,
          ...props,
        }),
      );
    });
    // Allow nested MarkdownRenderer layout + async morph commit.
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const flush = async (ms = 40) => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  };

  const codeText = () => container.querySelector('[data-component="markdown-code"]')?.textContent ?? '';
  const allCodeText = () =>
    Array.from(container.querySelectorAll('[data-component="markdown-code"]'))
      .map((node) => node.textContent ?? '')
      .join('\n');
  const codeHostIds = () =>
    Array.from(container.querySelectorAll('[data-oc-markstream-code-id]'))
      .map((node) => node.getAttribute('data-oc-markstream-code-id') ?? '');

  /** Nested MarkdownRendererImpl morph + worker highlight can lag large fences. */
  const waitForCodeText = async (
    predicate: (text: string) => boolean,
    { timeoutMs = 1500, stepMs = 50 }: { timeoutMs?: number; stepMs?: number } = {},
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate(codeText())) return codeText();
      await flush(stepMs);
    }
    return codeText();
  };

  test.each([false, true])('keeps dollar currency in prose (streaming=%s)', async (isStreaming) => {
    const paragraphs = [
      '你说得对。实时汇率大约是 6.69，不是我上次推出来的 8.4。$495 就是 ¥3312，Magpie 缓存里的汇率也是 6.69274。',
      '上次把 Usage 页的 ¥4446 除错了分母。那个 ¥4446 是按 6.69 乘出来的，背后大约是 $664，不是 Sessions 统计里的 $530。Sessions 那条把 gpt-6-astra 超过 27.2 万的阶梯剥掉了，按基础价只剩 $530，乘 6.69 只有 ¥3545，不是你看到的 4000 多。',
      '所以同样用现在的汇率，Runmark 对齐到北京时间今天是 $495 / ¥3312，Magpie Usage 页是 $664 / ¥4446。差的大约 $169 / ¥1100 是真差距：Magpie 从会话文件多算了 Runmark 没入库的调用，而且按每轮上下文把长上下文的 cache 算成 $2/M 而不是 $1/M。不是汇率把数字撑大的。',
    ];
    await render({ content: paragraphs.join('\n\n'), isStreaming });
    await flush(200);
    for (const paragraph of paragraphs) expect(container.textContent).toContain(paragraph);
    expect(container.querySelector('.katex, .math-inline')).toBeNull();
  });

  test('keeps currency literal when later code spans contain dollar templates', async () => {
    const paragraphs = [
      '不是插件丢的，是插件故意不报，Magpie 把同一批调用重复计了。',
      '差的那 623 条 astra 里，607 条（$165.46 / ¥1107）ID 都带 `_数字` 后缀。OpenCode fork 时会把父会话已完成的历史原样复制到新会话，只把消息 ID 改成 `${forkEventID}_${seq}`，token 和完成时间都不变（`opencode/packages/core/src/session/projector.ts:218`）。插件在 fork 边界后只报新调用（`plugin-opencode/src/opencode2-events.ts:236`），因为原调用在父会话里已经报过一次，今天对上的 1830 条就是证据，金额和 Runmark 完全一致的 $464.92。我也按 seq+token+完成时间回对过，这些副本在父会话里都有一模一样的原消息。',
      'Magpie 读 DB 时没做这层排除。OpenCode 自己的统计是排除 fork 前消息的（`opencode/packages/core/src/session/stats.ts:100`），Magpie 的 `internal/sessions/opencode.go:512` 把 fork 会话里的消息全算了。今天还是链式 fork：`ses_eb008…` 01:12 fork 出 `ses_eb000…`，12:56 又 fork 出 `ses_ead7…`，同一批历史能被计两到三次。几个会话的切换点也正好卡在 fork 创建时间，比如 `ses_ead452…` 13:55 建会话，13:57 之后的就全对上了。',
      '插件真有问题的是剩下 16 条（$1.78）：`session.step.failed` 那条分支把 token 硬编码成 0（`opencode2-events.ts:291`），失败/中断那轮上游其实带了 tokens 和 cost，被扔掉了。金额小，要修就修这里。Magpie 那边要对齐 OpenCode 自己的口径，给 fork 会话加上 `time_created >= session.time_created` 的过滤。',
    ];
    await render({ content: paragraphs.join('\n\n') });
    await flush(200);
    for (const paragraph of paragraphs) expect(container.textContent).toContain(paragraph.replaceAll('`', ''));
    expect(container.querySelector('.katex, .math-inline')).toBeNull();
  });

  test.each(['$I_m$', '$2\\pi$', '$3x$', '$$E=mc^2$$', '\\(x+1\\)'])('preserves explicit math %s beside currency', async (formula) => {
    await render({ content: `Cost $50, formula ${formula}.` });
    await flush(200);
    expect(container.textContent).toContain('Cost $50, formula');
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  test.each(['$$\nx+1\n$$', '\\[\nx+1\n\\]'])('preserves block math %s', async (formula) => {
    await render({ content: `Cost $50.\n\n${formula}` });
    await flush(200);
    expect(container.textContent).toContain('Cost $50.');
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  test('preserves escaped dollars and code spans', async () => {
    await render({ content: 'Price \\$50 and `$I_m$` with **bold**.' });
    await flush(200);
    expect(container.textContent).toContain('Price $50 and $I_m$ with bold.');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('.katex')).toBeNull();
  });

  test('keeps incomplete inline math literal until its closing delimiter arrives', async () => {
    await render({ content: 'Price $50, formula $x+1', isStreaming: true });
    await flush(200);
    expect(container.textContent).toContain('Price $50, formula $x+1');
    expect(container.querySelector('.katex')).toBeNull();
    await render({ content: 'Price $50, formula $x+1$', isStreaming: false });
    await flush(200);
    expect(container.textContent).toContain('Price $50, formula');
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  test.each(['d2', 'infographic'])('%s fences stay OpenChamber code cards, not library diagram shells', async (language) => {
    const fence = ['```' + language, 'x -> y', '```'].join('\n');
    await render({ content: fence });
    await flush(200);

    expect(container.querySelector('[data-markdown="mermaid-block"]')).toBeNull();
    expect(container.querySelector('[data-component="markdown-code"]')).toBeTruthy();
    expect(codeText()).toContain('x -> y');
  });

  test('renders mermaid fences through OpenChamber diagram decorate, not the library source card', async () => {
    const diagram = ['```mermaid', 'flowchart LR', 'A["用户输入"] --> B{"held?"}', '```'].join('\n');
    await render({ content: diagram });
    await flush(200);

    const block = container.querySelector('[data-markdown="mermaid-block"]');
    expect(block).toBeTruthy();
    expect(block?.getAttribute('data-md-source')).toContain('flowchart LR');
    expect(block?.getAttribute('data-mermaid-render')).toBe('svg');
    expect(block?.querySelector('svg.pele-flowchart')).not.toBeNull();
    expect(container.querySelector('[data-component="markdown-code"]')).toBeNull();
  });

  test('renders Pele chart types through the same Markdown path', async () => {
    await render({ content: '```mermaid\npie\n "完成" : 42\n "待办" : 12\n```' });
    await flush(200);
    expect(container.querySelector('[data-markdown="mermaid-block"] svg.pele-pie')).not.toBeNull();
  });

  test('uses OpenChamber markdown-code chrome, not markstream default toolbar, and keeps source text', async () => {
    await render({ content: `Before\n\n${FENCE}\n\nAfter` });
    await flush(120);

    const host = container.querySelector('[data-oc-markdown-engine="markstream"]');
    expect(host).toBeTruthy();
    expect(container.querySelector('[data-oc-markstream-code="markdown-impl"]')).toBeTruthy();

    const ocCode = container.querySelector('[data-component="markdown-code"]');
    expect(ocCode).toBeTruthy();
    expect(codeText()).toContain('const openChamber = 1');
    expect(codeText()).toContain('console.log(openChamber)');

    // Library default CodeBlockNode chrome (large multi-control toolbar).
    expect(container.querySelector('.code-block-header')).toBeNull();
    expect(container.querySelector('.code-block-actions')).toBeNull();
    expect(container.querySelector('[class*="code-block-toolbar"]')).toBeNull();
  });

  test('survives unmount and remount without blanking the fence body', async () => {
    await render({ content: FENCE });
    await flush(120);
    expect(codeText()).toContain('openChamber');

    await act(async () => {
      root.render(null);
    });
    await flush(10);
    expect(container.querySelector('[data-component="markdown-code"]')).toBeNull();

    await render({ content: FENCE, messageId: 'msg-code-regression-remount' });
    await flush(120);

    const remounted = container.querySelector('[data-component="markdown-code"]');
    expect(remounted).toBeTruthy();
    expect(codeText()).toContain('const openChamber = 1');
    expect(codeText()).toContain('console.log(openChamber)');
    expect(codeText()).not.toMatch(/^\s*$/);
  });

  test('A→B→A with the same messageId/part returns the cached fence body', async () => {
    const partA = { id: 'part-stable-a', type: 'text', text: FENCE } as const;
    await render({
      content: FENCE,
      messageId: 'msg-code-stable',
      part: partA as never,
    });
    await flush(120);
    expect(codeText()).toContain('const openChamber = 1');
    const hostIdA = codeHostIds()[0];
    expect(hostIdA).toContain('msg-code-stable');
    expect(hostIdA).toContain('part-part-stable-a');

    await render({
      content: FENCE_B,
      messageId: 'msg-code-other',
      part: { id: 'part-other', type: 'text', text: FENCE_B } as never,
    });
    await flush(120);
    expect(codeText()).toContain('const otherMessage = 9');
    expect(codeText()).not.toContain('const openChamber = 1');

    await render({
      content: FENCE,
      messageId: 'msg-code-stable',
      part: partA as never,
    });
    await flush(120);
    expect(codeText()).toContain('const openChamber = 1');
    expect(codeText()).toContain('console.log(openChamber)');
    expect(codeText()).not.toMatch(/^\s*$/);
    expect(codeHostIds()[0]).toBe(hostIdA);
  });

  test('stream updates grow the fence body through the OpenChamber renderer', async () => {
    await render({ content: FENCE, isStreaming: true });
    await flush(120);
    expect(codeText()).toContain('openChamber');

    await render({ content: FENCE_STREAM_TAIL, isStreaming: true });
    await flush(120);
    expect(codeText()).toContain('const next = 2');

    await render({ content: FENCE_STREAM_TAIL, isStreaming: false });
    await flush(120);
    expect(codeText()).toContain('const next = 2');
    expect(codeText()).toContain('console.log(openChamber)');
  });

  test('unclosed streaming fence keeps body text through close', async () => {
    await render({ content: FENCE_UNCLOSED, isStreaming: true });
    await flush(120);
    expect(codeText()).toContain('const openChamber = 1');

    await render({ content: FENCE, isStreaming: false });
    await flush(120);
    expect(codeText()).toContain('const openChamber = 1');
    expect(codeText()).toContain('console.log(openChamber)');
  });

  test('tilde fence with embedded triple backticks keeps the body', async () => {
    await render({ content: FENCE_TILDE_WITH_BACKTICKS });
    await flush(120);
    expect(codeText()).toContain('docs use ```code``` fences');
  });

  test('two same-language fences get distinct host cache ids and both bodies', async () => {
    await render({ content: TWO_SAME_LANG, messageId: 'msg-multi-fence' });
    await flush(160);

    const ids = codeHostIds();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('msg-multi-fence:'))).toBe(true);

    const text = allCodeText();
    expect(text).toContain('const first = 1');
    expect(text).toContain('const second = 2');
  });

  test('```text ASCII tree keeps spaces, pipes, Chinese, and OpenChamber chrome', async () => {
    await render({ content: TEXT_ASCII_TREE_A, messageId: 'msg-text-ascii' });
    await flush(200);

    expect(container.querySelector('[data-oc-markstream-code="markdown-impl"]')).toBeTruthy();
    expect(container.querySelector('[data-component="markdown-code"]')).toBeTruthy();
    expect(container.querySelector('.code-block-header')).toBeNull();

    const text = codeText();
    expect(text).toContain('Trace / 一次小微请求');
    expect(text).toContain('+-- ServerRun A');
    expect(text).toContain('|   +-- LLM #1');
    expect(text).toContain('[toolCall_1 结果回填，复用 Run A]');
    expect(text).toContain('终态：ERROR / timeout.client');
    expect(text).toContain('终态：cancelled / 结束等待');
    // Leading indent spaces on tree branches must survive (not collapse to empty).
    expect(text).toMatch(/\|\s{3}\+-- LLM #1/);
    expect(text).not.toMatch(/^\s*$/);
  });

  test('two ```text ASCII trees keep both bodies with distinct host ids', async () => {
    await render({ content: TWO_TEXT_ASCII_TREES, messageId: 'msg-dual-text-ascii' });
    await flush(240);

    const ids = codeHostIds();
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);

    const text = allCodeText();
    expect(text).toContain('Trace / 一次小微请求');
    expect(text).toContain('Trace / 一轮用户请求');
    expect(text).toContain('ServerRun B [回填 HTTP，续跑]');
    expect(text).toContain('+-- ClientRun / toolCall_2');
    expect(text).toContain('+-- ServerRun C');
  });

  test('streaming ```text fence keeps body through close', async () => {
    await render({ content: TEXT_ASCII_TREE_UNCLOSED, isStreaming: true, messageId: 'msg-text-stream' });
    let text = await waitForCodeText((value) => value.includes('+-- ServerRun A'));
    expect(text).toContain('Trace / 一次小微请求');
    expect(text).toContain('+-- ServerRun A');

    await render({ content: TEXT_ASCII_TREE_A, isStreaming: true, messageId: 'msg-text-stream' });
    // The open fence now advances incrementally even without a worker; wait
    // for the final line asserted below, not an earlier partially revealed row.
    text = await waitForCodeText((value) => value.includes('终态：cancelled / 结束等待'));
    expect(text).toContain('+-- ClientRun / toolCall_2');
    expect(text).toContain('终态：cancelled / 结束等待');

    await render({ content: TEXT_ASCII_TREE_A, isStreaming: false, messageId: 'msg-text-stream' });
    const settled = await waitForCodeText((value) => (
      value.includes('终态：cancelled / 结束等待')
      && /\|\s{3}\+-- LLM #2/.test(value)
    ));
    expect(settled).toContain('Trace / 一次小微请求');
    expect(settled).toContain('|   |   [toolCall_1 结果回填，复用 Run A]');
    expect(settled).toContain('终态：cancelled / 结束等待');
    expect(settled).toMatch(/\|\s{3}\+-- LLM #2/);
  });
});
