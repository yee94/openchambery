# GUI plugin window host

本模块承载 OpenCode GUI 插件的**窗口兼容子集**，本地 Electron 窗口另接原生 `main + IPC`。使用官方 `@opencode/plugin` **2.2.0** 契约，读取 npm 包 `./gui-experimental` 指向的预构建单文件 CommonJS；插件不需要 Yuri 专用入口，也不改写第三方 bundle。

## 所有权与运行时

- `bundle.ts` 提供允许的共享模块并求值标准 CJS。SDK、Solid、Solid store/web 与 Effect 使用宿主同一实例，不能把它们重新打进插件。
- `host.ts` 负责插件 owner/context、注册表、Contract、生命周期、窗口贡献、会话与布局桥接；`GuiPluginsProvider.tsx` 管理加载与启停，`react.ts` 提供轻量 React context，`components/gui-plugins` 负责界面和 Solid 容器。
- `files.ts` 负责会话工作区文件读取与变更观察；`storage.ts` 和 `preferences.ts` 负责插件持久状态及 GUI 启用偏好。
- `file-icons.ts` 负责窗口级文件扩展名图标索引、SVG 资源校验和独立订阅，不依赖 host snapshot。
- Web、Electron、VS Code 聊天窗口、hosted/mobile 使用同一个窗口 host。嵌入会话和独立 Agent Manager 不重复加载宿主。只有新版 Electron 的本地实例主 frame 可以申请 native lease；其他运行时、远程/Relay 实例及旧 shell 保持 `app.platform: web`、`desktop: undefined`。获得 lease 后为 `app.platform: desktop`，提供 `desktop.os`（其他 desktop 方法仍明确 unsupported）。若部署的 CSP 禁止 CJS 求值，插件状态显示求值失败，不能绕过 CSP。
- `native.ts` 负责窗口 IPC codec、响应式 state/live、事件与取消；`native-types.ts` 定义 preload 消息契约。`main-modules.mjs` 仅导出 main 进程使用的固定 ABI 共享模块映射，由 Electron 打包；原生求值、可信代码获取、调用授权与生命周期归 `packages/electron/gui-plugin-host.mjs`，不能导入 renderer bundle。
- `view-export.ts` 将当前客户端容器的两个 GSAPI 发布为宿主保留的 `yuri.exportPDF`、`yuri.exportLongImage` Contract。实现与跨端传输归 `lib/view-export`；通过 `RuntimeAPIs.viewExport` 注入，不改 `ctx.client`、官方 OpenAPI 或插件 main/IPC。
- `toast.ts` 实现官方窗口 `ctx.toast` 的纯文本子集；Provider 注入现有全局 Sonner，不创建插件容器、远端调用或 OS 通知。
- `save.ts` 实现官方 `ctx.system.save` 的客户端文件保存：Capacitor iOS/Android 复用 `YuriMedia.saveFile` 系统文件选择器，按 UTF-8 编码，限制 32 MiB，确认保存后返回 true、取消返回 false、失败拒绝；缺少原生实现明确 unsupported。Web/hosted mobile/Electron/VS Code 保留浏览器下载，不访问连接 Host 的文件路径。这不开放插件 main/IPC，也不依赖 LAN/Relay。

官方 npm SDK 2.2.0 没有公开 `gui/host` 导出。Yuri 的受控依赖 patch 只开放 `gui/yuri-host` 内部 context，让 host 与官方 `usePlugin` / `bindPlugin` 共用真实 `PluginContext`、`PanelContext` 和 lifetime。它是**宿主实现细节**，第三方插件始终只 import 官方公开 SDK。升级 SDK 必须重新验证 patch 与单实例 Solid 语义。

GUI 的 client/schema 使用固定 2.2.0 npm alias，与应用现有会话 SDK 分离；`lib/opencode/gui.ts` 保留官方请求、runtime auth、Relay 与取消信号，并拒绝旧 runtime generation 的调用。GUI bundle 的窄传输优化由 Yuri Web/VS Code 代理拥有，不改变官方 SDK 解码后的契约。

Provider 的会话目录来自 `useCurrentSessionEntity(sessionID)` 的匹配会话元数据（live 优先、global active 补充），不读取全局目录选择。冷加载或切换到尚未解析的会话时传入空 session，等待现有同步管线补齐身份；不复用上个会话目录，也不新增独立 lookup。全局项目选择变化不得重绑定当前 host session，真实会话目录迁移则更新文件作用域。

## 首批兼容范围

支持下面的窗口能力子集，不等于官方 Desktop API 全兼容：

| 能力 | 首批边界 |
| --- | --- |
| Command | 命令面板与插件管理页执行；hidden 命令可通过 `ctx.commands.run` 调用。首批不注册快捷键或 slash autocomplete |
| LinkHandler | 匹配、存在性与打开；交给会话文件/layout 管理 |
| Panel | `list/render`、标签与 session side/mobile 面板；保持 session/tab getter 响应性 |
| Style | 生命周期内注入并清理 CSS |
| SettingsPage | 独立设置页；宿主设置页的 `page/section` 注入不支持 |
| MenuItem | 仅 `session.panel`，不支持 server 菜单 |
| Registry / Contract | 窗口注册、提供、消费与撤销；跨插件组件用 `bindPlugin` |
| `yuri.file-icon` | 使用官方自定义 Registry 声明文件类型图标，按扩展名供文件树和标签页消费 |
| i18n / store | 声明式翻译、schema codec、持久状态和重载保留的 memory，按 transport/plugin 边界隔离；暂不支持 `from` 迁移和跨窗口实时同步 |
| sessions / files / layout | 已实现的当前会话、文件和面板操作；不推定所有 Host API 成员可用 |
| RPC | 通过当前连接服务的官方 client 调用服务端插件契约 |
| toast | 官方 `ctx.toast.show`，当前客户端的全局提示；支持纯文本、default/success/error/loading、duration/persistent 和 dismiss，icon/actions 明确 unsupported |

本地 Electron 支持 `main`、`ctx.main(Ipc)`、`ctx.use(Ipc)`、schema 编解码、每窗口 state/events、调用取消及 `os` 限制；其他运行时仍拒绝 native IPC、main-only 和带 `os` 限制的定义。未支持 `WebContentsView`/embeds、server sources、slots、原生菜单及其他未实现 Host API。访问未支持能力必须产生可见错误，不能用空对象或成功 no-op 冒充支持。

原生主进程自行从进程内后端的权威 OpenCode client 读取全局 inventory/bundle；窗口只能提交 id/revision，不能提交代码、options、服务地址或凭证。revision 必须匹配，窗口随后运行 main 返回的同一 bundle。插件 main 每个 revision 在应用内共享一个实例；每窗口激活有独立 lease，停用/卸载/切服务释放本窗口 lease，最后一个 lease 释放时撤销 IPC、abort 调用并清理 main。导航/销毁由 main 兜底撤销；replacement 会撤销旧 revision 的全部 lease。每次 native 操作验证主 frame、精确本地来源及主进程记录的本地实例身份，远程页面和预览 iframe 无权调用。

代码来源还必须由本机 OpenCode 生命周期证明为 managed child 或官方 shared service，且 endpoint 是 loopback；外接服务、SSH 转发即使是 localhost 也不取得本机 native 执行权。同源 `/api/preview/*`、`/api/fs/*` 页面不是应用文档，不能调用 native GUI。

远端 GUI 的 `setup`、LinkHandler、Panel 和格式预览继续可用。带本地 preload 的文档在加载 window-only bundle **之前**，必须等待 main 确认 `window-only` 限权：撤销本窗口 native leases/调用，并让本机文件、Shell、设置等特权 desktop IPC gate 拒绝后续请求。限权持续至跨文档导航提交，切会话、hash/path 同文档导航和重新申请 lease 均不能恢复权限；切回 native 能力须重新加载应用文档。图片缓存、虚拟资源流与预览 gateway 属于独立的前端展示能力，不受插件原生降权影响；只允许经过来源、应用路由及当前主 frame 校验的客户端应用文档调用，继续执行资源归属和容量限制，不开放本机路径、凭证或插件 main。图片和 `.eficy` 等前端格式预览必须保持可用；真正的远程页面和预览 iframe 不因此取得本地桥接能力。真正的远程页面没有本地 GUI bridge，保持 window-only。窗口插件仍不是独立 JS 沙箱；不能在同一文档混合远端窗口代码与本机原生插件权限。独立的本地可信插件访问远端数据通道尚未开放，不能通过移除 Relay 判断来实现。

### 原生拒绝错误契约

错误目录为 `native-errors.json`。main 的 IPC 返回 `{ ok: true, value }` 或 `{ ok: false, error: { code, message } }`；preload 只转发可序列化结果，`requestNativeGui` 在窗口重建 `GuiPluginError`，保证 `error.code` 不被 Electron/contextBridge 丢掉。日志记录同一 code，不记录调用参数、schema 原值、上游响应或凭证。未知异常归 `GUI_PLUGIN_FAILED`。窗口 host 的未捕获原生错误还在 snapshot 保留 `errorCode`。

| code | 消费方式 |
| --- | --- |
| `GUI_PLUGIN_UNTRUSTED_SOURCE` / `GUI_PLUGIN_FORBIDDEN` | 不自动重试原生调用，使用窗口/服务端方案 |
| `GUI_PLUGIN_DOCUMENT_RESTRICTED` | 本文档保持 window-only；恢复 native 须重载 |
| `GUI_PLUGIN_UNSUPPORTED` | 当前运行时无此能力；保留预览，隐藏原生动作或提供服务端动作 |
| `GUI_PLUGIN_LEASE_EXPIRED` / `GUI_PLUGIN_REVISION_MISMATCH` | 丢弃旧 client，由宿主重新激活/刷新 |
| `GUI_PLUGIN_UNAVAILABLE` | 服务/提供者未就绪，可在恢复后重试 |
| `GUI_PLUGIN_INVALID_REQUEST` / `GUI_PLUGIN_UNKNOWN_METHOD` / `GUI_PLUGIN_INVALID_INPUT` / `GUI_PLUGIN_INVALID_OUTPUT` | 契约错误，修正请求或插件实现 |
| `GUI_PLUGIN_ABORTED` | 用户取消或生命周期结束，停止本次操作 |
| `GUI_PLUGIN_FAILED` | 未分类执行失败，显示失败并保留用户操作上下文 |

插件不需要 import Yuri 模块，直接检查标准 `ctx.main(...)` 调用的异常属性：

```ts
try {
  await exporter.pdf(input)
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'GUI_PLUGIN_UNSUPPORTED' || code === 'GUI_PLUGIN_DOCUMENT_RESTRICTED') {
    // Keep the report visible and offer the plugin's server-side export, if available.
    return
  }
  if (code === 'GUI_PLUGIN_ABORTED') return
  throw error
}
```

原生 acquire 的读取/求值失败保留已有实例；main setup 失败清理已注册的资源并向插件管理器报错。异步结果经过 document/lease 与 runtime transport 检查，旧实例不能覆盖新实例。main cleanup 支持异步且等待最多 3 秒；插件直接创建的 BrowserWindow、Node 资源仍需用 `ctx.onCleanup` 或返回 cleanup 管理。

PDF/长图现在另有两个独立的容器 GSAPI，使用官方 `Contract.define` / `ctx.use` 获取 `yuri.exportPDF` 与 `yuri.exportLongImage`，不增加 `ctx` 字段，不合并为 `format` 参数。两个能力分别探测和激活；pending/未支持/失败时不展示对应动作。`yuri` 及其子 namespace 为宿主保留，普通插件不能覆盖；错误 token kind 也不能绕过保留契约。

这两个能力属于**当前客户端设备**：新版 Electron、iOS、Android 可以在连接本地、远端或 Relay 时使用。它们只接收有界的静态导出快照，经过容器渲染与系统保存，不执行插件 main、不接收宿主文件路径，且不恢复 window-only 文档的其他原生权限。普通浏览器、hosted mobile、VS Code 与缺少原生实现的旧壳明确不支持。完整输入、进度、取消和平台契约见 [`../view-export/DOCUMENTATION.md`](../view-export/DOCUMENTATION.md)。插件原有标准 main/IPC 仍按前述严格权限规则工作。

宿主按插件生命周期绑定导出任务，卸载/替换/切服务会取消；面板调用者通过 `options.signal` 绑定自身视图生命周期。能力探测在首次使用时进行，每个 host 只探测一次，无轮询，后续无关 render/session 更新不重新探测。探测失败或运行时明确返回 `EXPORT_UNSUPPORTED` 时，对应能力保持 inactive；内容校验、渲染和保存错误继续允许重试，不导致报告预览失败。宿主不注入 Eficy 按钮，入口与进度交互仍由独立插件拥有。

`FileViewer` 注册明确报 unsupported；自定义后缀使用 `LinkHandler + Panel`。文件树结构扩展、composer、宿主设置分区、原生文件动作和完整 Desktop tabs/layout 语义不在首批范围。文件预览按 `PanelTab.file` 的规范化完整路径匹配，直接挂载到已有文件标签页/手机文件详情中，支持切回源码；只有没有内联文件视图承载的独立面板和设置页使用 Dialog/手机 Sheet，不复刻拖拽分屏和最近关闭恢复。

可见文件视图在调用 LinkHandler 前通过 `registerFileView` 申请引用计数的展示 lease；snapshot 暴露 `file`、`inline` 和 `sessionKey`，根面板不会重复挂载 inline 内容。关闭/切换文件释放 lease，并隐藏旧 active panel，避免它转成弹窗。文件标签页以内联 owner 的可见性观察文件，不依赖另一插件面板是否激活；切到源码时卸载 Solid 内容。

插件主动导航统一使用官方 `ctx.links.open({ href, base, session })`：本地文件先通过 Provider 的文件导航回调进入现有文件标签页，再由 `GuiFileLinkBridge` 注册展示 lease 并调用底层 `host.openLink` 分派 handler；底层分派不再次导航。`base` 是来源文件所在目录，相对路径复用共享路径解析；文件标签页的目录作用域仍来自当前 mounted session 的权威元数据。显式传入非当前 session/server 的引用返回 false，避免把旧会话路径套入当前目录。`file://` 的中文/空格编码、Windows drive 与 UNC 通过消息文件解析器归一化；HTTP/mailto 等非文件链接不进入文件导航。官方 open 保持同步 boolean 接受语义，异步导航失败归属发起插件。

插件 setup、render、异步动作失败应归属对应插件，不阻断其他插件。原生模块占位仅用于让跨进程 CJS 顶层声明可求值，不代表原生能力已实现，也不是代码沙箱。

## 预览操作插槽

官方 SDK 2.2.0 的四个 `Slot` 是窗口/会话级贡献；`session.panel.end` 没有具体预览实例和截图区域。`preview-actions.ts` 因此提供标准 `Contract.define<PreviewActionsAPI, 'yuri.previewActions'>('yuri.previewActions')` / `ctx.use`，不扩展官方 `PanelProps`、不改 SDK。

v1 API 为 `register({ element, capture, render }): () => void`：

- 只能在所属面板的 Solid render/effect owner 中注册。`element` 是当前预览区域（iframe 亦可）；`capture({ signal?, onProgress? })` 返回 Promise `{ html, width, height }`。进度支持 `preparing/capturing/rendering/encoding/saving` 和可选 `completed/total`。
- `render(surface)` 返回插件拥有的 HTMLElement 操作组，采用正常流布局。`surface` 包含该 `element`、生命周期 `signal` 和 `snapshot(options?)`。点击调用 `snapshot` 时才执行 capture；注册不缓存 HTML 或尺寸。iframe 的隔离通信和序列化由插件负责。
- 宿主私有 Solid context 持有本次 mount 的内容容器、操作 target 和插件身份；不按 active tab、路径或全局 DOM 查实例。同一 tab 的两份 mount 也互相隔离。capture 前后验证 region 仍属于内容容器；外部工具栏不进入截图区域。
- 撤销函数幂等；Solid owner 清理、panel unmount、源码切换、插件停用/替换、会话或 runtime 销毁会移除按钮并 abort。快照 await 前后检查取消；插件须把 `surface.signal` 与操作 signal 合并传给后续导出请求，并清理 UI 监听。
- 契约属于当前客户端，不依赖 native lease、服务端或 Relay，普通插件不能覆盖保留 token。PDF/长图仍分别消费原有两个 GSAPI。

独立 Eficy 注册一个下载菜单，宿主将它和源码按钮集中排版。已发布 `@eficy/opencode2-plugin@0.4.2` 未注册时宿主不额外生成下载按钮；新插件在未提供契约的旧宿主保留原有内联入口，只走一种路径。普通 browser 支持插槽，但无导出 GSAPI 时下载入口隐藏。

`host.test.ts` 覆盖真实 SDK 的同 tab 双 mount 隔离、最新内容、卸载和保留契约；React integration 覆盖集中排版、source/文件切换清理。菜单层叠与尺寸仍需浏览器验收。

Chromium 集成夹具已组合真实 Host、React bridge、MobileResizableSheet、独立 modal 和 Eficy CJS/iframe：390px 移动标题行与 PC 浮动区按钮无重叠，菜单能覆盖预览；点击快照保留最新输入且不含工具栏，源码切换清除动作并取消任务，无原生能力时下载入口隐藏。保存端为受控客户端适配器，不代表真实 Relay 网络或 Electron/iOS/Android 系统保存验收。

## 全局 toast

[官方 V2 GUI Toasts](https://opencode.ai/v2/docs/build/plugins/gui#toasts) 和当前 SDK 2.2.0 已定义 `ctx.toast`，因此不新增 `yuri.toast` Contract，也不借用导出契约。

```ts
// Plugin.setup(ctx) 或 usePlugin() 返回的同一个官方 context：
try {
    await saveReport();
} catch (error) {
    ctx.toast.show({
        title: ctx.t('report.saveFailed'),
        description: error instanceof Error ? error.message : String(error),
        variant: 'error',
    });
}

const pending = ctx.toast.show({ title: ctx.t('report.saving'), variant: 'loading', persistent: true });
try { await saveReport(); } finally { pending.dismiss(); }
```

`show({ title: string, description?: string, variant?: 'default' | 'success' | 'error' | 'loading', duration?: number, persistent?: boolean })` 返回 `{ dismiss(): void }`。默认 5000ms，duration 为有限非负毫秒，persistent 忽略超时。相同插件仍显示的相同提示复用 toast，其他插件互不覆盖。内容只以字符串渲染，不接受 HTML/React 节点或透传任意 Sonner options；`icon/actions` 当前明确抛 `GUI_PLUGIN_UNSUPPORTED`，不静默忽略。非法输入抛 `GUI_PLUGIN_INVALID_INPUT`；注入不可用时明确 unsupported。

提示属于插件生命周期，组件卸载不关闭它；插件停用、替换、失败、切服务或 host dispose 会关闭已有提示并撤销旧 show 方法。卸载后调用旧 show 返回无副作用的 dismiss handle。普通插件不能占用 `yuri` namespace。所有共享 UI 端（web、desktop、hosted/Capacitor mobile、VS Code）使用同一窗口提示实现，远端/Relay 不影响能力；`ctx.attention.notify` 系统通知不在本次范围。Host 测试/嵌入通过 `toast` option 注入 `import { toast } from 'sonner'`，不依赖 native lease。

移动端沿用 MobileApp 的 safe-area top-center 全局 Toaster，与文件 Sheet 分离；Sheet 的 inert/aria-hidden 只作用于自身窗口，提示不随下层文件面板隐藏。`toast.test.ts` 覆盖生命周期、跨插件隔离、去重、错误输入、保留 namespace 和 sink 失败隔离；浏览器层叠/可读性需要真实 Sheet 验收，不能由这些单元测试推定。

## 文件类型图标注册

官方 SDK 2.2.0 没有 `FileIcon` 内置注册表。插件通过公开的 `Registry.define<T>('yuri.file-icon')` 声明 Yuri 消费的自定义贡献，仍使用同一个标准 `./gui-experimental` 包，无单独入口；其他宿主没有该 registry consumer 时可以忽略它。

```ts
import { Registry } from '@opencode/plugin/gui';

type FileIcon = { id: string; extensions: readonly string[]; svg: string; lightSvg?: string };
const FileIcon = Registry.define<FileIcon>('yuri.file-icon');
// 在 Plugin.setup(ctx) 中：
ctx.add(FileIcon, {
    id: 'preview', extensions: ['eficy'],
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 2h12v12H2z" fill="#7c8cff"/></svg>',
});
```

后缀忽略大小写和开头一个 `.`，按文件名最后一段后缀精确匹配；允许 1–64 字符的字母、数字、`_+-`（首字符为字母或数字）。显式 `extension` 优先，目录永不覆盖，未知类型返回 undefined 交给既有 FileTypeIcon fallback。深色默认使用 `svg`，浅色优先 `lightSvg`，缺省沿用 `svg`。

每个 SVG 必须是带 SVG namespace 的完整 XML 根元素，UTF-8 不超过 16 KiB。支持静态几何、分组、defs、渐变、clipPath、mask、use 和标题描述；拒绝脚本、事件属性、内联 style、外部引用、DTD/处理指令及非 SVG 形状。引用仅接受本图 `#id`。宿主编码为稳定 `data:image/svg+xml,` 资源供 `img` 使用，不向宿主注入 SVG markup，不接收远程 URL。

每项 id 非空且不超过 128 字符，同插件 id 唯一；每项 1–64 后缀、每插件最多 64 项、每窗口最多 512 项及 8 MiB 原始 SVG（深浅资源分别计入）。批量替换先验证再提交；图标校验或 accessor 求值失败只撤销所属插件的图标，回退其他提供者或默认图标，插件保持 active、预览和命令继续可用。图标 accessor 在自身 memo 求值边界捕获异常，保留响应式恢复能力；非图标贡献异常仍按原有插件失败语义处理。图标诊断独立保存，通过 snapshot 的插件 error 展示（其他插件诊断优先）；后续有效响应式注册恢复图标时只清除图标诊断，不清除其他错误。停用、卸载、重载、失败和 host dispose 都撤销图标。多个插件冲突时，最近首次注册非空图标的插件覆盖，普通响应式替换保持其优先级；卸载恢复较早提供者，重载或清空后重新注册获得新的顺序。同一插件多个图标匹配时后面的贡献覆盖。

`host.fileIcons` 是稳定实例，只暴露图标变化给其 `subscribe`；React 消费必须使用独立稳定 context 和叶子订阅，不能让每个文件图标订阅宽 `useGuiPlugins` context。图标派生仅跟踪自身贡献，不跟踪 host session/layout/snapshot。相同内容替换复用已校验编码资源，最终可见图标不变则零通知；索引与编码缓存随窗口和插件生命周期释放。测试覆盖 50 次无关会话/布局/插件更新的零解析、零编码、零通知。

## Inventory、服务端与开关

GUI inventory 采用**当前连接服务的全局插件列表**。不把项目 plugins 当成窗口 GUI 代码来源；不能把列表请求失败视为空列表成功。服务切换必须清理旧贡献、client、监听与作用域状态。

启动不依赖 GUI inventory、client、host 或插件代码。应用通过 `ready` 提供主界面就绪条件：桌面/Web 等初始 splash 撤除且配置初始化完成，移动端等已连接的主界面配置初始化完成。Provider 保留 children，双 rAF 后再启用 inventory Query；显式文件需求也不能绕过这个首屏绘制门槛。移动 HTML 自带 120×120 Logo，位于 React root 内，在应用模块尚未执行时可见，首次 React commit 自然替换，不使用定时移除。

存在 enabled 且服务端 active 的 GUI 时，通过 `requestIdleCallback`（最长等待 2 秒；不支持时延后 1 秒）启动预加载，不再等第一次点击。`useGuiPlugins()` 保留 `requested` 与幂等 `requestLoad()`；文件预览、命令面板或插件管理器的显式需求只跳过空闲等待。宿主动态导入前再让出绘制机会；`scheduling.ts` 串行调度已取得 bundle 的同步安装，每个插件独立跨双 rAF/任务边界，不把网络/IPC 等待加入串行队列。加载当前服务 inventory 中所有 enabled 且 active 的 `features.gui` 插件，不扫描历史项目，不按文件后缀推定能力；禁用项不下载。关闭入口保留需求、host 和已安装实例，重开复用同一 Query/cache；成功空 inventory 仍撤销 host。空闲、绘制和安装任务随停用、transport 切换或卸载取消，并在执行前再次核对 transport；inventory 在动态导入前后及响应后检查 generation。

GUI inventory、代码下载、缓存版本校验和安装全部后台静默执行，不显示全局 Dialog、手机 Sheet 或加载 toast，不提供“后台继续”入口。下载进度不另设全局计数或展示计时器；网络取消和迟到隔离仍由 Query/client 的生命周期负责。

inventory、host、bundle 失败由 Provider 的 `LoadErrors` 使用现有 toast 明确反馈，同一 runtime 的持续错误去重；setup/render 错误仍由 Surface 按所属插件报告。懒加载 Surface 保留局部 ErrorBoundary，chunk/render 失败不能替换主界面。插件加载不参与任何应用 startup gate，文件预览继续使用自己的局部 loading。

这是共享 Solid/DOM 主线程宿主的协作调度，不是 Worker 并行执行：单个第三方 CJS 求值或同步 setup 仍可产生长任务，无法被调度器抢占。保证的是主界面先完成绘制、不同插件之间让出绘制、异步下载互不阻塞；不承诺任意第三方同步代码的硬 CPU 时限。

需求一直保留至 transport 改变或 Provider 卸载。Provider 通过 `useSyncExternalStore` 直接订阅 runtime endpoint 事件，不依赖父组件或会话状态重绘来发现切换。切换清零 `requested`、取消旧 client 并销毁 host，迟到 inventory/bundle 不得进入新 host；新实例没有 GUI 时保持空宿主。仍挂载的入口观察 `requested` 并重新调用 `requestLoad()`。未请求时 `refresh()` 只刷新列表和偏好；已请求时可重试 host、bundle 与失败 setup，成功插件依靠原 host 的 revision 去重保持挂载。

`loading` 覆盖 inventory pending、偏好未解析，以及已请求后的 host/bundle 获取与同步安装等待，失败结束该阶段等待。全局错误通过 `error` 暴露，bundle 错误保留在 `inventory[].error`，setup/render 失败由 `snapshot.plugins` 表达。各插件独立安装和失败；入口应在 host/snapshot 就绪变化时尝试链接，不以全部插件的 `loading` 结束作为成功插件可用的门槛。

Inventory 和 bundle 都由 TanStack Query 持有，键为 `[transport, 'plugins', 'gui', null, ...]`，复用既有 `plugin.updated`/配置更新/重连失效管线，无另起轮询。加载 bundle 失败保留上次实例；成功空列表或服务端明确 failed 撤销对应实例。bundle revision 变化清理并替换，保持标签；相同 revision 的 active 实例不重启，failed 实例可手动刷新重试。GUI 开关先写入实例作用域存储，成功后才更新界面。

### 持久代码与校验

端侧只持久化 GUI 代码和 revision 校验 token，不持久化插件 options。持久键按缓存 schema、GUI ABI、稳定 runtime 身份和插件 ID 隔离；transport/generation 只用于取消和迟到结果隔离，不作为磁盘分区，不在日常切换服务时删除缓存。代码使用 `runtimeFileStore` 的完整 Blob 事务及共享容量淘汰（单项 32 MiB、总计 256 MiB/128 项）；缓存不可用、损坏或淘汰时降级为完整网络读取。

revision 更新原位覆盖同 key。GUI 写入通过 `runtimeFileStore.write` 的可选第五参 `replaceTag`，使用不含 schema/ABI 的稳定分组 `JSON.stringify(['gui-code', runtime, pluginId])`：同一个 readwrite 事务写入新代码并删除同 tag 的其他 key，升级 schema/ABI 后也只保留该组一份代码；写入或清理失败全部回滚，保留旧代码。清理不匹配其他插件、其他 runtime 或图片；共享容量淘汰规则仍生效。已有同 key 未标记记录在下次写入时补 tag，无历史已发布 schema 的推测迁移。

精确 GUI GET 通过 `X-Yuri-Gui-Revision` 发送已有 token。Yuri 代理每次读取上游当前 bundle，以 revision 的 SHA-256 生成响应 token；匹配时返回 HTTP 200、`X-Yuri-Gui-Code: cached` 及空 `code`，保留本次权威 revision/options。客户端在 SDK 解码前补回持久代码。未匹配、无缓存或旧 host 则完整下载。请求失败不能用磁盘代码冒充新鲜成功，冷启动必须校验后才执行；已运行实例在刷新失败时继续保留。响应使用 `private, no-store`，不把 options 留在浏览器 HTTP 缓存中。

因此缓存未被淘汰且 revision 未变时，Yuri→客户端不重复传输代码；Yuri→OpenCode 仍须获取完整 bundle。npm 版本不能替代 revision，配置变化和本地插件修改由上游 revision 覆盖。bundle 请求最多并发两个；这限制网络工作量，不能为任意第三方同步 setup 提供硬 CPU 时限。每个插件独立就绪并 apply，不能等待全部插件完成才允许预览。iframe 的执行堆、组件初始化和 HTTPS 依赖由插件及浏览器 HTTP 缓存拥有，不属于此代码缓存。

服务端 `.` 与 GUI `./gui-experimental` 是同包的两个独立部分。技能由服务端 `ctx.skill.transform` 注册，工具由 `ctx.tool.transform` 注册；GUI 开关只影响窗口贡献。远程服务也必须安装 server part，本地 GUI 不能代替远端 skill/tool 注册。

## 文件与 Solid 生命周期

SDK 2.2.0 的文件接口是 `ctx.screen.current()?.file` 或面板的 `props.screen.file`。`sync(path)` 读文件并请求观察变更，`get(path)` 返回响应式状态，`unwatch(path)` 结束观察；不存在独立公开 `file.watch` 方法。宿主内部 watcher 需按 owner/session 正确引用计数和清理。

文件预览上限为 UTF-8 128 KiB，单文件模型最多 64 个缓存/观察项；超限显式报错。只有持有 lease 的文件以 2 秒前台 stat Query 观察变化；API owner 与宿主面板 lease 独立。stat/读取失败保留已有内容并标记错误，删除与恢复不会伪装为空成功。存储单项编码上限 2 MiB，失败写入不改变已显示值。

最后一个文件 lease 释放后，再次观察已加载文件会强制重读一次源码，不能把恢复监听时的首个 stat 当作缓存仍然新鲜的证据。宿主与插件 API 共用该重读，同一轮监听新增消费者不重复读取；同内容保留原状态引用，读取失败保留旧内容并暴露错误，显式 force sync 可重试。

响应式订阅按规范化路径及 file/missing/selection/scroll 字段隔离；没有消费者时释放订阅信号。已加载内容刷新不切换 loading，同内容、同错误、同选区和同滚动位置不通知，保留原 FileState/content 引用。并发 force 请求合并为当前读取加一次补读，继续使用 epoch 防止失效请求覆盖新状态。文件内容更新不通过 React 全局 snapshot 发布。

挂载 snapshot 的 panel/settings 提供明确 `pluginId`；仅所属插件 revision 或会话变化使对应 Solid 内容重挂。链接匹配仍跟踪全插件 readiness，以发现新增 handler。重复打开/隐藏/关闭及仍有其他消费者的文件 lease 释放不重新派生/通知；真实布局变化才传播，显式 focus 行为保留。

宿主性能回归以 64 文件的独立订阅为尺度：单文件更新不得唤醒其他文件，50 次无关插件更新不得重挂当前 DOM，同内容保存不通知消费者。浏览器验收分开记录保存→显示的轮询延迟、读取完成→DOM 更新耗时、空白帧、节点替换及滚动/选区稳定性；2 秒轮询不是亚秒实时性承诺，第三方插件自己的 render 实现由其独立项目验收。

布局/文件 lease 的同步变更复用已由 Solid 派生发布的 snapshot，只有尚未发布时才补发；空 host、失败插件和清理仍同步发布权威状态，不把通知延后到 microtask。挂载视图的 `props.tab` 通过 owner 内 memo 选择当前 tab：普通数据属性完全相同的 plain object 保持引用，避免全局 views 版本变化唤醒无关插件 effect；含 getter/setter 的替代对象不做值相等复用，防止保留旧闭包。focus/close 的瞬时 props 不创建该 memo。`GuiPluginHost.perf-evidence.test.tsx` 使用真实 Provider/Markdown/文件桥与可计数 CJS 夹具，守护流式更新零插件调用、关闭多文件零无关文件 effect、同内容 stat 更新零 effect；这不是完整 Eficy runtime 或真实浏览器延迟证据。

插件在 render/effect 内读取 `props.session`、`props.tab`，不能在初始化时解构并冻结它们。挂载贡献必须提供真实 SDK context 和共享 Solid owner；`usePlugin()` 在外部抛错，`bindPlugin()` 将跨插件组件固定到提供方 context。停用、卸载、切会话和切服务后，旧请求不得覆盖新文件，旧 owner 必须撤销注册与观察。

## 验证

使用本目录 focused Vitest 测试检查 host、bundle、files、preferences 和 storage。生产集成必须再验证真实 React/Solid 挂载、CSP、服务连接与文件事件；静态类型通过不代表所有平台可用。

`native.test.ts` 检查 IPC codec、快照/事件顺序、取消与 lease 清理；Electron 的 `gui-plugin-host.test.mjs` 覆盖多窗口共享 main、窗口隔离、非法来源、revision/读取失败、部分 setup 清理与导航取消。`scripts/gui-plugin-evidence.test.mjs` 用真实 Electron、正式 preload、窗口 host 和标准 CJS 插件，在 loopback Vite HMR 与 `yuri-ui://app` bundled 页面生成有效 PDF；服务端 inventory/bundle 是受控夹具，不代表真实 Eficy 导出 UI、签名安装包或 Windows/Linux 验收。

`packages/ui/vitest.config.ts` 内联 Solid 和插件 SDK，使 happy-dom 测试与浏览器使用同一 owner graph；不需要额外 NODE_OPTIONS。`host.test.ts`、`files.test.ts` 验证注册、文件刷新、错误恢复、会话隔离和清理。`react.test.tsx` 验证空闲前 50 次 rerender 零 host import/零 bundle、空闲预加载后点击复用、空闲取消与迟到隔离、并发需求合并、关闭重开复用、禁用/无 GUI、慢 bundle loading、失败重试及 transport 迟到隔离；另覆盖全局目录切换零会话同步、冷加载元数据、真实目录迁移、切会话等待与旧会话迟到更新隔离。

真实 Chromium 已验证生产 host 与完整 Provider/管理器/文件桥/React modal 加载同一 CJS；桌面关闭和重新启用、移动 viewport + touch 下共享 Sheet 均可渲染。文件边界和服务响应使用验收夹具，此证据不等于 live OpenCode AI 调用、原生 Electron/iOS/Android 或 VS Code 实机验收。

Yuri 只维护通用插件宿主与最小契约测试夹具，不内置示例插件源码、运行时或发布产物。`GuiPluginLazyLoading.test.tsx` 用最小标准 CJS 夹具串联真实 Provider、Host、文件桥和文本预览，并覆盖插件先就绪再打开真实 `MobileResizableSheet`、覆盖/恢复窗口、源码选择保留和关闭重开；不能只用裸文件桥或模拟 mobile viewport 代替窗口栈激活回归。插件功能与打包验证属于插件独立仓库。

Eficy 已独立发布为 [`@eficy/opencode2-plugin`](https://www.npmjs.com/package/@eficy/opencode2-plugin)，源码和运行时验收位于 [独立仓库](https://github.com/yee94/opencode-eficy)。远端安装后由标准 inventory/bundle 链路发现，不需要 Yuri 特例或本地源码目录。
