import { describe, expect, test } from 'vitest';
import { getDefaultTheme } from '@/lib/theme/themes';
import { renderMermaidDiagram } from './mermaidRender';
import { decorateMarkdown, type DecorateContext } from './decorate';
import { createMermaidViewerRegistry, getMermaidViewerController } from './mermaidViewer';

const theme = getDefaultTheme(false);
const context: DecorateContext = {
  labels: { copy: 'Copy', copied: 'Copied', enableCodeWrap: 'Wrap', disableCodeWrap: 'Unwrap', copyDiagram: 'Copy source', downloadDiagram: 'Download', zoomInDiagram: 'Zoom in', zoomOutDiagram: 'Zoom out', resetDiagramView: 'Fit', previewLabel: 'Preview', previewTitle: 'Preview' },
  mermaidControls: { copy: true, download: true, showPanZoomControls: true },
  codeBlockLineWrap: false,
  renderMermaid: (source) => renderMermaidDiagram(source, theme),
  imageTransportIdentity: 'test', imageEffectiveDirectory: '/workspace', imagePreviewEnabled: false,
};

const decorate = (source: string, count = 1) => {
  const root = document.createElement('div');
  for (let index = 0; index < count; index++) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.className = 'language-mermaid';
    code.textContent = source;
    pre.append(code);
    root.append(pre);
  }
  decorateMarkdown(root, context);
  return root;
};

describe('Pele Mermaid integration', () => {
  test.each([
    'flowchart LR\n subgraph 工作流程\n A[开始] --> B[中文长标签处理步骤]\n end\n B --> C[完成]',
    'sequenceDiagram\n Alice->>Bob: 你好\n Bob-->>Alice: 收到',
    'classDiagram\n Animal <|-- Duck',
    'stateDiagram-v2\n [*] --> Ready\n Ready --> [*]',
    'erDiagram\n CUSTOMER ||--o{ ORDER : places',
    'pie\n "已完成" : 42\n "待办" : 12',
    'gantt\n dateFormat YYYY-MM-DD\n section 开发\n 任务 :2026-01-01, 2d',
    'mindmap\n root((项目))\n  开发\n  测试',
  ])('renders real diagram syntax: %s', (source) => {
    const svg = renderMermaidDiagram(source, theme).svg;
    expect(svg).toContain('class="pele ');
    expect(svg).toContain('viewBox=');
    expect(svg).not.toContain('<foreignObject');
  });

  test('reuses stable stream results and invalidates colors even with the same theme ID', () => {
    const source = 'flowchart LR\n Start --> Finish';
    const first = renderMermaidDiagram(source, theme);
    for (let frame = 0; frame < 80; frame++) expect(renderMermaidDiagram(source, theme)).toBe(first);
    const dark = getDefaultTheme(true);
    const changed = renderMermaidDiagram(source, { ...dark, metadata: theme.metadata });
    expect(changed).not.toBe(first);
    const host = document.createElement('div');
    host.innerHTML = changed.svg!;
    expect(host.querySelector('svg')?.style.getPropertyValue('--pele-fg')).toBe(dark.colors.surface.foreground);
  });

  test('keeps source on invalid/oversized input and recovers when streaming completes', () => {
    const source = 'flowchart LR\n A[unfinished';
    const root = decorate(source);
    expect(root.querySelector('[data-mermaid-render="source"]')?.textContent).toContain(source);
    expect(root.querySelector('svg.pele')).toBeNull();
    expect(renderMermaidDiagram(`${source}] --> B`, theme).svg).toContain('pele-flowchart');
    expect(renderMermaidDiagram('x'.repeat(50_001), theme)).toEqual({});
  });

  test('does not activate diagram links, HTML or remote images', () => {
    const root = decorate('flowchart LR\n A["<img src=x onerror=alert(1)>"] --> B\n click A "https://example.test"');
    expect(root.querySelector('svg')).not.toBeNull();
    expect(root.querySelector('a, image, img, script, foreignObject, [onerror]')).toBeNull();
    const image = decorate('flowchart LR\n A@{ img: "https://example.test/image.png", label: "Image" }');
    expect(image.querySelector('svg')).not.toBeNull();
    expect(image.querySelector('image, img')).toBeNull();
  });

  test('preserves controls, unique accessibility IDs and the unzoomed self-contained download', () => {
    const root = decorate('flowchart LR\n accTitle: 流程\n accDescr: 工作流程\n A --> B', 2);
    const svgs = Array.from(root.querySelectorAll('svg.pele'));
    expect(svgs).toHaveLength(2);
    expect(svgs[0].getAttribute('aria-labelledby')).not.toBe(svgs[1].getAttribute('aria-labelledby'));
    const registry = createMermaidViewerRegistry(root);
    try {
      const block = root.querySelector('[data-markdown="mermaid-block"]')!;
      const original = block.querySelector('[data-md-original-svg]')!.getAttribute('data-md-original-svg')!;
      expect(original).toContain('--pele-fg:');
      expect(block.querySelector('[data-md-action="mermaid-download"]')).not.toBeNull();
      expect(block.querySelector('[data-md-action="mermaid-copy"]')?.getAttribute('data-md-source')).toContain('accTitle: 流程');
      expect(getMermaidViewerController(block)).not.toBeNull();
      getMermaidViewerController(block)!.zoomIn();
      expect(block.querySelector('[data-md-original-svg]')!.getAttribute('data-md-original-svg')).toBe(original);
    } finally { registry.cleanup(); }
  });
});
