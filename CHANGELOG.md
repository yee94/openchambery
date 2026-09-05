# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.19.6] - 2026-09-05

汇总 1.19.5-beta.1 ~ 1.19.6-beta.2（1.19.5 正式版发布中断：macOS 签名 keychain 失败，Draft 未转正；npm 已有同名版本，顺延为 1.19.6）。

### 移动端

- iOS Live Activity 改成「N working」多会话列表，不跟原生界面开关绑定，每一行可以点进对应会话；任意一端在前台也会照样推送手机通知。
- 手机文件里的 HTML 预览支持全屏和查看源码，半浮层贴齐物理底边、跟手更稳，滚到顶部再下拉不再抖动。
- 输入框 `/`、`@`、`#` 补全面板改成和上下文弹层一致的毛玻璃，点选后不再留下常亮高亮。
- 关闭原生体验时，计划任务编辑不再当成二级页盖住底部 Tab；保存按钮会抬到 Tab 上方，可以正常保存。

### 会话

- 电脑端和 VS Code 侧栏顶部也会列出进行中、未读会话，和手机首页的「置顶/进行中」一致；置顶/进行中会话 hover 会显示正确的项目和分支。
- 手动拖过的项目顺序不会再被发消息顶到最前冲掉。
- 聊天列表默认改回 TanStack 虚拟化。
- 打开会话或跳到最新时，消息列表等高亮完成后再显示，减少上下跳动。
- 流式回复里还没写完的代码块会边生成边着色，不用等围栏闭合。
- 探索和运行类中间过程收成同一组「运行了」折叠（进行中「运行中」，英文 Used / Running）。搜索、读取、编辑、命令连在一起就全部收起，只有正文、技能、任务或提问会拆开；摘要合并次数，编辑仍显示绿增红删行数。
- 聊天里的 HTML 文件路径可以像 Markdown 一样点开预览，路径划线更稳、高亮后不会闪一下消失；图片路径点开走全局图片预览；Relay 下打开 HTML 预览不再白屏。

### 远程实例（SSH + Relay）

- 被连接的服务器可直接创建配对码、查看全部已配对设备并删除，和 SSH 连接的表现一致。
- 一台设备可同时挂多个 Relay 域名，配对时可选择不同的 relay 端点，客户端按域名识别为多个可自定义命名的实例。

## [1.19.6-beta.2] - 2026-09-05

### 会话

- 统一过程折叠标题改成「运行了」（进行中「运行中」），英文 Used / Running，不再用「探索 / Explored」。

## [1.19.6-beta.1] - 2026-09-05

### 会话

- 探索和运行类中间过程收成同一组「探索」折叠。搜索、读取、编辑、命令连在一起就全部收起，只有正文、技能、任务或提问会拆开；摘要合并次数，编辑仍显示绿增红删行数。

## [1.19.5] - 2026-09-05

1.19.5 正式版发布中断（macOS 签名失败，GitHub Draft 未转正）；用户可见改动已并入 1.19.6。npm 上仍保留同名包。

## [1.19.5-beta.14] - 2026-09-05

### 移动端

- HTML 预览半浮层贴齐物理底边，源码与默认模式仍保留安全区留白。
- HTML 页面滚到顶部后，下拉、回拉和松手时半浮层跟手更稳定。
- 手机斜杠 / @ / # 补全面板底色更通透，保留毛玻璃效果。

## [1.19.5-beta.13] - 2026-09-05

### 移动端

- 手机斜杠 / @ / # 补全面板改成和右上角上下文弹层一样的毛玻璃。

## [1.19.5-beta.12] - 2026-09-05

### 移动端

- HTML 预览底部大白边去掉。
- 滚到顶再下拉半浮层时不再抖动。

## [1.19.5-beta.11] - 2026-09-05

### 移动端

- iOS Live Activity 每一行可以点进对应会话。
- 手机文件里的 HTML 预览支持全屏和查看源码。

## [1.19.5-beta.10] - 2026-09-05

### 会话

- 聊天文件路径划线更稳，高亮后不会闪一下消失。
- 图片路径点开走全局图片预览。
- Relay 下打开 HTML 预览不再白屏。

## [1.19.5-beta.9] - 2026-09-05

### 移动端

- iOS Live Activity 改成「N working」多会话列表，不跟原生界面开关绑定。
- 任意一端在前台也会照样推送手机通知。
- 斜杠补全弹出层阴影和底色在会话切换层里更稳定。

### 会话

- 聊天里的 HTML 文件路径可以像 Markdown 一样点开预览。

## [1.19.5-beta.8] - 2026-09-04

### 会话

- 连续的编辑、命令和其他运行类工具会收成「运行了」一组，进行中显示「运行中」，摘要带次数和绿增红删行数。

## [1.19.5-beta.7] - 2026-09-04

### 会话

- 聊天列表默认改回 TanStack 虚拟化。需要 LegendList 时在控制台执行 `localStorage.setItem('oc:legend-timeline', '1')` 并刷新。

## [1.19.5-beta.6] - 2026-09-04

### 会话

- 打开会话或跳到最新时，消息列表等高亮完成后再显示，减少上下跳动。
- 流式回复里还没写完的代码块会边生成边着色，不用等围栏闭合。

## [1.19.5-beta.5] - 2026-09-04

### 远程实例（SSH + Relay）

- **被连接的服务器可直接创建配对码：** 通过 Relay 连接的桌面设备可以在远程服务器上创建配对码、查看全部已配对设备并删除，和 SSH 连接的表现一致；手机设备仍只能管理自己。
- **一台设备可同时挂多个 Relay 域名：** 配对时可选择不同的 relay 端点，客户端按域名识别为两个可自定义命名的实例；新增域名只追加、不断开旧域名上已配对的设备。

## [1.19.5-beta.4] - 2026-09-04

### 会话

- 手动拖过的项目顺序不会再被发消息顶到最前冲掉。

## [1.19.5-beta.3] - 2026-09-04

### 会话

- 电脑端置顶/进行中会话 hover 会显示正确的项目和分支。

## [1.19.5-beta.2] - 2026-09-04

### 会话

- 电脑端和 VS Code 侧栏顶部也会列出进行中、未读会话，和手机首页的「置顶/进行中」一致。

### 移动端

- 输入框 `/`、`@`、`#` 补全面板改成玻璃底，点选后不再留下一块常亮高亮。

## [1.19.5-beta.1] - 2026-09-04

### 移动端

- 关闭原生体验时，计划任务编辑不再当成二级页盖住底部 Tab；保存按钮会抬到 Tab 上方，可以正常保存。

## [1.19.4] - 2026-09-03

汇总 1.19.3-beta.1 ~ 1.19.4-beta.1（1.19.3 正式版发布中断，npm 上已有同名版本，顺延为 1.19.4）。

### 移动端

- 会话搜索改为匹配已加载目录里的标题，不再只搜当前可见的几条；搜索结果关键字高亮，和电脑端一致。
- 首页置顶和进行中会话统一显示「项目 · 分支」副标题。
- 更新卡片重新显示更新内容，不再是空白。
- iOS Live Activity 支持系统计时，并在后台更新完成/错误状态。

### 定时任务

- 任务里打开的是该任务的历史记录，并带任务筛选，而不是直接打开最近一次会话。
- 任务一开始就会显示进行中，不用等会话挂上；在历史会话里接着做时，任务会先显示进行中，做完后再改成成功。

### 聊天

- 再次进入会话会滚到最新，不再停在上次发出的那条消息上。

## [1.19.4-beta.1] - 2026-09-03

### 其它

- 开启 1.19.4 预发布周期。

## [1.19.3] - 2026-09-03

汇总 1.19.3-beta.1 ~ 1.19.3-beta.9。

### 移动端

- 会话搜索改为匹配已加载目录里的标题，不再只搜当前可见的几条；搜索结果关键字高亮，和电脑端一致。
- 首页置顶和进行中会话统一显示「项目 · 分支」副标题。
- 更新卡片重新显示更新内容，不再是空白。
- iOS Live Activity 支持系统计时，并在后台更新完成/错误状态。

### 定时任务

- 任务里打开的是该任务的历史记录，并带任务筛选，而不是直接打开最近一次会话。
- 任务一开始就会显示进行中，不用等会话挂上；在历史会话里接着做时，任务会先显示进行中，做完后再改成成功。

### 聊天

- 再次进入会话会滚到最新，不再停在上次发出的那条消息上。

## [1.19.3-beta.9] - 2026-09-03

### 移动端

- 回退 iOS Live Activity 计时视图到能正常显示内容的实现，修复锁屏黑卡。

## [1.19.3-beta.8] - 2026-09-03

### 移动端

- 修复 iOS Live Activity 灵动岛布局变宽与计时不显示，恢复原始紧凑样式。

## [1.19.3-beta.7] - 2026-09-03

### 移动端

- 修复 iOS Live Activity 通知卡片渲染为空。

## [1.19.3-beta.6] - 2026-09-03

### 移动端

- iOS Live Activity 支持系统计时，并在后台更新完成/错误状态。

## [1.19.3-beta.5] - 2026-09-03

### 聊天

- 再次进入会话会滚到最新，不再停在上次发出的那条消息上。

## [1.19.3-beta.4] - 2026-09-03

### 移动端

- 首页置顶和进行中会话统一显示「项目 · 分支」副标题。

## [1.19.3-beta.3] - 2026-09-03

### 移动端

- 更新卡片重新显示更新内容，不再是空白。

### 定时任务

- 任务一开始就会显示进行中，不用等会话挂上。
- 在历史会话里接着做时，任务会先显示进行中，做完后再改成成功。

## [1.19.3-beta.2] - 2026-09-03

### 定时任务

- 任务里打开的是该任务的历史记录，并带任务筛选，而不是直接打开最近一次会话。

## [1.19.3-beta.1] - 2026-09-03

### 移动端

- 会话搜索改为匹配已加载目录里的标题，不再只搜当前可见的几条。
- 搜索结果关键字高亮，和电脑端一致。

## [1.19.2] - 2026-09-02

汇总 1.19.2-beta.1 ~ 1.19.2-beta.3。

### 定时任务

- 在历史记录会话里接着做完后，任务状态会改成成功。
- 任务里可以直接打开最近一次历史会话。
- 电脑上点击历史记录整行即可打开会话。

### 聊天

- 修复提问卡片自定义输入框删行时高度来回跳动。
- 上下文面板会话记录在时间线模式下由列表自己滚动。

### 移动端

- 首页置顶/进行中卡片里的未读会话改为与普通会话一致的样式，保留未读小蓝点。

### 其它

- 移除计划模式：`/plan-feature` 命令、计划视图、相关快捷键与路由入口。
- 移除项目笔记 / Todo 面板，以及选中文本“加入笔记”入口，精简右栏与设置项。

## [1.19.2-beta.3] - 2026-09-02

### 其它

- 移除计划模式：`/plan-feature` 命令、计划视图、相关快捷键与路由入口。
- 移除项目笔记 / Todo 面板，以及选中文本“加入笔记”入口，精简右栏与设置项。

## [1.19.2-beta.2] - 2026-09-02

### 移动端

- 首页置顶/进行中卡片里的未读会话改为与普通会话一致的样式，保留未读小蓝点。

## [1.19.2-beta.1] - 2026-09-02

### 定时任务

- 在历史记录会话里接着做完后，任务状态会改成成功。
- 任务里可以直接打开最近一次历史会话。
- 电脑上点击历史记录整行即可打开会话。

### 聊天

- 修复提问卡片自定义输入框删行时高度来回跳动。
- 上下文面板会话记录在时间线模式下由列表自己滚动。

## [1.19.1] - 2026-09-02

### 其它

- 修复应用内更新 OpenCode 时因缺少版本号而报 Bad Request。

## [1.19.0] - 2026-09-02

汇总 1.18.6-beta.1 ~ 1.19.0-beta.42。

### 聊天

- 新时间线引擎，打开会话直接落在最新消息。
- 发送后把这条消息停在上方，下方留给回复。
- 会话里的 subagent 可以直接打开。

### iPhone

- 原生液态玻璃输入框，支持附件、`/` 和 `@`。
- iOS 26 首页原生液态玻璃底栏。
- 任务进行中会在灵动岛和锁屏显示 Live Activity。
- 外观设置可开关原生体验，默认关闭。

### 移动端

- 首页置顶分组会列出进行中和未读会话。
- 按钮、卡片和菜单有按压缩放和轻触感。

### 其它

- 自托管 Relay 支持推送，并提供 `openchamber-push-relay`。
- 命令行也可安装为 `openchambery`。
- 凭证同步改成配置同步里的可选项。

## [1.19.0-beta.42] - 2026-09-02

### Added

- On iPhone, Appearance Settings can turn off the native composer, tab bar, and Live Activities so the app matches the Android web view.
- The phone homepage Pinned group also lists running and unread sessions.

### Changed

- The global CLI also installs as `openchambery`.
- Product README presents OpenChamberY and current mobile screens.

## [1.19.0-beta.41] - 2026-09-01

### Fixed

- Clicking a Write tool for a newly created file opens that file's diff instead of an empty last-turn changes view.
- Session lists treat archive membership as `time.archived`, so a session does not stay in the wrong Active / Archived bucket.

## [1.19.0-beta.40] - 2026-09-01

### Changed

- Phone buttons, cards, tags, and menus share a slight press scale, elastic settle, and pressed fill.
- The four items in the project-page plus menu now use pressed fill and a single light haptic.

### Fixed

- Beta OTA iOS detectability checks use the correct marketing-version profile.

## [1.19.0-beta.39] - 2026-09-01

### Fixed

- Phone session row actions keep a correct swipe-rail layout; leftover pinned icons are removed.

### Changed

- APNs titles follow the device language and re-register when the language changes.
- Push Relay batches deliveries, caps concurrency, reduces payload privacy exposure, and hardens collapse-id handling.
- Default iOS Bundle ID matches the shipping app identity.

## [1.19.0-beta.37] - 2026-09-01

### Fixed

- Opening the phone recent-sessions sheet keeps the last All / pinned / project tab instead of forcing the current project; only a removed-project filter is corrected.
- Chat composer model selection prefers the latest assistant execution in the transcript over older history or leftover session memory when switching chats.
- Phone homepage session rows no longer clip the swipe action rail under rounded group chrome.

### Changed

- iPhone native composer attach / send / stop taps use the shared light haptic path. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.
- Phone row action sheets fire a light haptic on tap even when press-scale feedback is off.
- Push delivery can register device tokens through the self-hosted relay and re-bind when the relay URL changes.

### Added

- `@openchambery/relay-server` exposes a push-relay package entry and `openchamber-push-relay` CLI; Relay-only releases use the `relay/v*` tag path without desktop or mobile installers.

## [1.19.0-beta.36] - 2026-08-31

### Changed

- On iPhone, Live Activity starts after 5 seconds of continuous work.

## [1.19.0-beta.35] - 2026-08-31

### Added

- On iPhone, active agent work appears as a Live Activity in the Dynamic Island and on the Lock Screen after 12 seconds, with task state, elapsed time, attention requests, completion or error state, and a shortcut back to the session. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

### Fixed

- Full and OTA-only release workflows now package Capgo bundles correctly from the Bun mobile workspace.

## [1.19.0-beta.34] - 2026-08-30

### Changed

- On the phone homepage, destructive actions like Remove sit in their own group below the other sheet actions, so they are harder to tap by accident.
- Homepage action-sheet rows are taller and easier to tap.

## [1.19.0-beta.33] - 2026-08-30

### Fixed

- Phone Settings selects (theme, language, and other dropdowns) open as a bottom sheet instead of a clipped popup.
- On iPhone, the `/` and `@` suggestion list can be scrolled with a pan; tapping a row still inserts. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.
- Editing a message on iPhone restores the full text in the native composer even if the input pill was collapsed.

## [1.19.0-beta.32] - 2026-08-30

### Fixed

- Typing in the iPhone native composer no longer slows down the longer you type or the more you use it: duplicate typing events and unchanged height reports are skipped, theme colors are resolved once instead of on every keystroke, and markdown highlight recalculation for the hidden web input is skipped while the native composer owns input. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

## [1.19.0-beta.31] - 2026-08-30

### Fixed

- Typing in the iPhone native composer no longer slows down the longer you type or the more you use it: duplicate typing events and unchanged height reports are skipped, theme colors are resolved once instead of on every keystroke, and markdown highlight recalculation for the hidden web input is skipped while the native composer owns input. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

## [1.19.0-beta.30] - 2026-08-30

### Fixed

- Opening chat on iPhone no longer stalls the first frame while the native composer glass overlay is created; the shell warms it while hidden on the homepage. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.
- Native composer chrome updates no longer repaint chip ranges on every send or scroll tick, which had made entering chat and controlling the input feel laggy.

### Changed

- `/` and `@` tokens in the iPhone native composer render as primary-colored labels with whole-token delete, without rasterized icon overlays, to keep typing smooth. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

## [1.19.0-beta.29] - 2026-08-30

### Fixed

- On iPhone, tapping the agent name next to the identicon also cycles the role, not only the avatar. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

## [1.19.0-beta.28] - 2026-08-30

### Changed

- The phone chat header fade is a bit less see-through so the title stays readable over scrolling messages.
- Phone chat keeps more empty space under the newest message so you can scroll it up off the composer.
- Ready Send and Stop on the iPhone native composer now match the web inverted disc. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

### Fixed

- On iPhone, the chat list now reserves the real native composer and queue height, so the last message is no longer clipped against the input when something is queued.
- After sending, scrolling the transcript no longer bounces or gets pulled back while a reply is streaming.
- Switching chats on iPhone updates the native input's model name and thinking strength, not only the icon. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

## [1.19.0-beta.27] - 2026-08-30

### Fixed

- Opening a chat no longer leaves the previous model's icon in the input while messages load, and Send uses the model you see.
- On iPhone, tapping a `/` or `@` suggestion now inserts the same way as the web composer: it replaces the token you were typing and moves the caret after it. File and agent `@` matches also follow the same ranking as web. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.
- The iPhone homepage dock uses the system tab bar for the selected liquid-glass lens (and light mode) instead of a nested glass pill that read as a black shadow.

## [1.19.0-beta.26] - 2026-08-30

### Added

- iPhone homepage tabs use a native liquid-glass dock on iOS 26. Older iOS, Android, and the web app keep the existing bar. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

## [1.19.0-beta.25] - 2026-08-30

### Added

- On iPhone, typing `/` or `@` in the native composer opens a liquid-glass suggestion list above the input — same width as the card, with a small gap, internal scroll, and room so it does not collide with the header. Search as you type; tap a row or press Return to insert. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

## [1.19.0-beta.24] - 2026-08-30

### Added

- iPhone chat now uses a native liquid-glass composer: tap + for photos or files, then remove attachments from the preview strip or by deleting the `[filename]` text. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

### Fixed

- On a new chat, project and branch pickers sit above the input, same as Changes and To-do.
- After sending, the reserved reply space is the middle of the screen (safe area and header counted, about 40% max). You can no longer scroll into empty space under the parked message.

### Changed

- Leaving chat hides the native composer immediately so it does not linger over Projects.
- Changes and the queue sit closer against the native composer pill.

## [1.19.0-beta.23] - 2026-08-30

### Changed

- Android type and spacing lift from the old ~0.9 density result to about 0.95 (still below 1). Typical phones already compute 0.9, so the value is multiplied rather than only raising the cap.

## [1.19.0-beta.22] - 2026-08-30

### Changed

- Android type and spacing return to the original physical-density scale (xdpi/ydpi toward 1/163 inch, capped at 0.9). Pinning Android to 1 or 10/9 skipped that shrink and made both type and gaps jump.

## [1.19.0-beta.21] - 2026-08-30

### Fixed

- After sending a message, the reserved space under the parked bubble is now the bottom of the chat. You can no longer scroll into the empty inset under it (which hid Changes and showed the scroll-to-bottom button). Tapping that button keeps the reserved space and returns to the parked message.

## [1.19.0-beta.20] - 2026-08-30

### Changed

- Android type and spacing drop back from the iOS-matched 10/9 trial to a pinned scale of 1, which is still larger than the old ~0.9 density result.

## [1.19.0-beta.19] - 2026-08-30

### Changed

- Android now uses the same 10/9 design-pt scale as iOS, so type and spacing can be compared side by side.

## [1.19.0-beta.18] - 2026-08-30

### Added

- iPhone chat now uses a native liquid-glass composer: tap + for photos or files, then remove attachments from the preview strip or by deleting the `[filename]` text. This is a native-shell update — TestFlight testers need this build; one-tap OTA is not enough.

### Changed

- Leaving chat hides the native composer immediately so it does not linger over Projects.

## [1.19.0-beta.17] - 2026-08-30

### Changed

- Mobile type and spacing are a bit larger. iOS uses a 10/9 design-pt scale; Android keeps its own physical density with a smaller 1.05 lift (typical ~0.9 becomes ~0.945) and a cap of 1, so it does not copy the iOS parameter.

## [1.19.0-beta.16] - 2026-08-30

### Fixed

- The thinking/composing status hint now disappears as soon as the turn is done (when Changes appears), instead of lingering and causing a height jump.

## [1.19.0-beta.15] - 2026-08-29

### Changed

- Projects home tap highlight is a bit stronger so press feedback stays visible without going back to a full hover slab.

## [1.19.0-beta.14] - 2026-08-29

### Added

- Sending a message on the new timeline now parks that message near the top of the transcript, with the sending or thinking status staying under the bubble. Space below is reserved for the reply (capped at about 60% of the viewport), and you can still scroll away and back.

### Changed

- Composer Send and Stop use a filled circular control so the stop square stays visible on WebKit.
- Long file paths in diffs and change lists keep the filename readable by truncating the middle.
- Stopping generation shows muted “Generation stopped” copy instead of an error banner.

### Removed

- Session recap is gone: the setting, transcript spacer, and server assist runtime. The small-model description now refers to session titles and summaries.

## [1.19.0-beta.13] - 2026-08-29

### Fixed

- Clicking scroll-to-bottom now actually jumps to the newest message on the new timeline. The control previously called a no-op writer that is disabled there.

## [1.19.0-beta.12] - 2026-08-29

### Fixed

- Services panel shortcuts now toggle closed when already on the requested tab, and switch tab when the panel is open on a different one. Desktop toggle opens instance; the usage shortcut opens usage.

## [1.19.0-beta.11] - 2026-08-29

### Fixed

- Opening a session that is still streaming now lands on its newest message instead of gliding partway and stopping mid-conversation with follow disengaged.

## [1.19.0-beta.10] - 2026-08-29

### Changed

- Credential sync is now an opt-in item of the config sync selection instead of a separate per-target authorization, removing the standalone grant step that previously gated `auth.json` transfers.

## [1.19.0-beta.9] - 2026-08-29

### Fixed

- Loading older history no longer jumps the transcript to the newest message. The at-end signal could stay stale after switching sessions, which made the load-older button skip releasing end pinning, and the list then treated the prepended history as a reason to scroll to the live edge.
- The read position is now captured when older history is requested rather than when it arrives, so end pinning is stood down before the new rows can move the viewport.

## [1.19.0-beta.8] - 2026-08-29

### 聊天

- **加载更早历史时，你正在看的那条消息一动不动：** 上一版让列表在插入历史后多补偿一段时间，但真正的问题不是补偿多久，而是列表**按哪一条消息**来对齐——它选的是「视口里最上面那条」。点「加载更多」时你正处在最顶端，于是新插进来的消息立刻变成了最上面那条，而它们刚落位时用的还是估算高度；列表于是死死盯住一条估算高度的消息，随着逐行实测，整段历史的误差全部累加到你的阅读位置上方，最后视口就停到了会话中间。现在改为显式记住你点击前正在看的那条消息（取数据之前就已记录），并一直把它钉在原来的屏幕位置上，直到新插入的这批内容彻底停止变化——这比固定时间窗更久，因为消息正文的排版会在稍后再变一次高度。位置校正走列表自己的滚动接口、且每次都是绝对目标，不再与列表内部的位置调整互相抢写。你一旦上滑或触屏，锚点立即让位给你。
- **加载过程中输入框不再闪出：** 上一版已让滚动容器在重新锚定期间对外声明状态，但这个声明是在画面绘制之后才挂上的，而列表在同一次提交里就已经调整了滚动位置——浏览器把那一帧的滚动事件抢在声明之前发了出去。就这一帧没被标记，却是一次很大的「离底距离」变化，被输入框读成了用户的主动下滑。现在声明改在绘制之前完成，并覆盖整个锚定过程。

包含 1.19.0-beta.1 ~ beta.7 的全部内容。本版本为预发布，仅用于测试；不含 iOS / TestFlight 更新。

## [1.19.0-beta.7] - 2026-08-29

### 聊天

- **滚动经过的消息不再卡在 loading 骨架：** 消息正文先以骨架挂载，等一次「水合」把它换成正式排版；而滚动中途换排版会顶动正在读的内容，所以只允许在滚动停下来之后换。但新引擎只有滚动事件这一个触发点，它调度的那一次水合就在同一帧里执行，永远不算「已停下」——于是快速滚动时越过预加载窗口的消息被跳过后再也没有第二次机会，只能退出重进对话才恢复。现在滚动停下来后会补一次水合，单次提交超过上限而剩下的部分也会继续排队补完。

包含 1.19.0-beta.1 ~ beta.6 的全部内容。本版本为预发布，仅用于测试；不含 iOS / TestFlight 更新。

## [1.19.0-beta.6] - 2026-08-29

### 聊天

- **加载更早历史时视口原地不动：** 上一版已经先释放端部跟随，但插入的历史是先按估算高度落位、随后才逐行实测，而新引擎当初关掉了列表默认的尺寸补偿，于是这些实测差值全部累加到阅读位置上方——加载完成的一瞬间视口被推到了别处。现在每次插入更早历史后会在一个短窗口内开启尺寸补偿，把这批新行的实测差值吸收掉；窗口之外，工具调用展开之类的原地增长照旧向下生长。
- **加载过程中输入框不再闪出：** 插入内容与列表的位置纠正落在不同帧，「离底距离」先跳远再跳回，回来那一帧和用户快速下滑无法区分，于是输入框在加载中途闪成展开态。现在滚动容器会在重新锚定期间对外声明状态，这些帧不再计入手势行程，输入框保持原样直到锚定结束。

包含 1.19.0-beta.1 ~ beta.5 的全部内容。本版本为预发布，仅用于测试；不含 iOS / TestFlight 更新。

## [1.19.0-beta.5] - 2026-08-29

### 聊天

- **加载更早历史不再把视图甩走：** 新引擎把「插入更早消息」当成一次内容增长，而此时端部跟随还开着，于是列表立刻把视口纠回最新消息处。现在点「加载更多」（以及滚动到顶部触发的加载）会先释放端部跟随再取数据，插入的历史落在阅读位置上方，读到哪儿还在哪儿。已经贴在底部时不做释放——那种情况下纠正本身就是空操作。
- **手动上滑后不会再被自动拉回底部：** 新引擎原本只按「离底距离」判断是否继续跟随，离底不足十分之一屏就照旧跟随，流式回复时轻轻上滑会被拽回去，而且无需下滑就会悄悄恢复跟随。现在上滑手势会粘性地交出跟随权，只有真正回到底部、点「回到底部」或切换会话才重新接管。

包含 1.19.0-beta.1 ~ beta.4 的全部内容。本版本为预发布，仅用于测试；不含 iOS / TestFlight 更新。

## [1.19.0-beta.4] - 2026-08-29

### 移动端

- **流式回复时输入框不再闪成收起态：** 新引擎在会话进行中用动画方式把视图滑回底部，收起判定只看「离底距离」，于是把这段动画误读成用户上滑。现在收起只由真实手势触发，内容增长和列表自身的回滑不再影响输入框的吸底展开；滑到真正底部仍会展开，抬手后的惯性滑动照旧生效。

包含 1.19.0-beta.1 ~ beta.3 的全部内容。本版本为预发布，仅用于测试；不含 iOS / TestFlight 更新。

## [1.19.0-beta.3] - 2026-08-29

### 移动端

- **顶部导航与输入框不再压住正文：** 新时间线引擎下聊天记录上下两侧的留白丢失，首条消息被顶部导航遮住、末条被输入框遮住。留白改为由列表实际测量的占位承担，安全区、导航高度、输入框高度等变量继续动态生效。
- **顺带修好三处新引擎下的静默失效：** 附件定位、展开/折叠工具调用后的滚动位置回补、以及聊天容器的兜底查询——它们都通过 `data-scrollbar="chat"` 找滚动容器，而新引擎下这个标记丢了；聊天滚动条样式同时恢复。

包含 1.19.0-beta.1 ~ beta.2 的全部内容。本版本为预发布，仅用于测试；不含 iOS / TestFlight 更新。

## [1.19.0-beta.2] - 2026-08-29

### 移动端

- **往下滚动时输入框会回来了：** 之前输入框收起后，只有滚到接近底部（离底 80px 内）才重新出现，从很上面往下滑要一路滑到底才看得到。现在只要往下滑动一小段就会唤出，唤出后在同一次下滑手势里保持展开，直到再次上滑才收起。离底 80px 内的按位置比例跟随、以及收起后的惯性沉降窗口保持原样；顶部橡皮筋回弹不再被误当成下滑意图。

包含 1.19.0-beta.1 的全部内容（Beta 新时间线引擎）。本版本为预发布，仅用于测试；不含 iOS / TestFlight 更新。

## [1.19.0-beta.1] - 2026-08-29

### 聊天（Beta 新时间线引擎）

- **进入会话不再闪动：** 聊天记录改由单一列表持有滚动位置（替换 TanStack 虚拟化 + 自动跟随钉底的组合），打开会话直接落在最新消息；迟到的异步内容增长由列表自身跟随，不再触发逐帧滚动校正。默认启用，可在 DevTools 控制台执行 `localStorage.setItem('oc:legend-timeline', '0')` 并刷新回退旧引擎。
- **新引擎下交互与流式正常：** 展开工具调用、切换活动密度等行内状态即时生效；流式回复按块即时上屏；Markdown 渐进加载只重绘真正变化的行。
- **加载更早历史与"回到底部"按钮改读列表真实位置：** 修复新引擎下滚动到顶部附近不再触发历史加载、按钮不再常隐的问题。
- 本版本为预发布，仅用于测试；不含 iOS / TestFlight 更新。

## [1.18.6-beta.2] - 2026-08-28

### 修复

- **预览 Changes 时不再被刷新拉回顶部：** 编辑或 git status 更新时不再把视图重新钉到文件头，也不再卸掉已渲染的 diff 再挂一次。

## [1.18.6-beta.1] - 2026-08-28

### 修复

- **助理聊天里的 subagent 可以打开了：** PC / iPad 点 task 行会在右侧 ContextPanel 打开子会话；手机和 VS Code 直接跳进该 subagent 会话。历史记录里的 subagent 同样可点。
- **`/fork` 后源会话不再卡住：** 一拿到新会话 id 就切路由，源会话可以马上继续操作；离开 fork 路径时不会把草稿写回源会话。
- **流式文字渐入更跟手：** 改用 `requestAnimationFrame` 按实际帧间隔揭示，避免定时器堆积导致的卡顿与追赶。

## [1.18.5] - 2026-08-27

汇总 1.18.4-beta.1 ~ beta.29。

### 聊天

- **回复完成信息即时显示：** TPS、时长与 token 统计不再滞后显示；结算事件丢失时自动从快照补齐并触发对账修复，等待回复期间也提前显示模型标识与思考档位徽章。
- **冷启动底部状态行不再闪动：** 多会话冷启动同步期间，连续工具调用的状态行不再整行反复出现消失、文案高频轮换；generic 状态文案切换进入 1200ms 显示队列，结束后平滑退场。
- **历史上翻滚动更稳：** 修复视口锚点补偿与用户滚动同帧竞态把刚滚上去的位置反向拉回的问题（补偿前先检测外部滚动写入，用户滚动优先）；上滑加载历史不再回跳、不再断触，长文阅读锚点在滚动期间持续有效。
- **会话历史不再偶发提前判定加载完毕：** 上游分页游标偶发缺失（满页无 `x-next-cursor`）时不再永久标记耗尽，改发可重试边界游标。
- **「正在处理」区域更稳定：** 处理中锁定展开避免过程行跳动；空的折叠区域不再占位；历史时间线不再覆盖实时尾部；处理中回合收紧底部间距。
- **`@` 文件引用更可靠：** 确认后才高亮并整段删除，源码优先排序，未匹配项不再混入结果。
- **`/new` 与队列行为修复：** `/new` 执行后不再残留输入框；停止生成后下一条排队消息保持「发送中」直到真正发出。
- **思考强度徽章实时显示：** 实时合并不再误删 `model` 字段，Xhigh 等档位随回复立即显示。

### 会话

- **`/fork` 全面修复：** idle 会话复制完整历史；进行中以最后一条用户消息为切点；状态缺失不再卡死；复用子 Agent 的提问不再双向等待挂起；fork 后首次对话的智能标题在事件丢失时惰性自愈。
- **置顶会话不再丢失：** 置顶关系迁入独立持久表，滑出摘要窗口仍保持置顶，历史数据自动迁移。
- **回顾摘要上下文瘦身：** 只取关键正文与最近输入，显著降低 token 消耗。
- **上一条 / 下一条覆盖置顶：** 快捷键按侧栏实际顺序（先置顶再项目）循环。

### 移动端

- **OTA 更新渠道开关：** 设置中可加入 Beta 更新渠道并一键回退稳定版；修复 iOS Beta 壳收不到 OTA 更新的问题。
- **半浮层与浮层交互修复：** 下滑关闭后不再闪全屏；操作行按压高亮铺满整行；划词菜单两列布局；选区气泡随滚动消失。
- **文件预览增强：** 外部修改后自动刷新；文本可选中并支持加入对话 / 新建会话 / 复制。
- **「全部 / 置顶」打开最近会话不再切走当前项目；** 会话列表弹窗默认当前项目且打开后可改筛选。
- **实例列表更统一：** 副标题统一显示「已连接 / 已保存」，纯中继实例同样可重命名。
- **附件弹窗与输入框细节：** 附件选择收成卡片组；Agent 名称垂直居中；DPI 字号缩放修复。

### 远程实例（SSH + Relay）

- **SSH 远程自托管 Relay：** managed SSH 启动的远程实例可直接作为 private relay host，手机等设备普通配对直连，不再经桌面中继；按远程 CLI 能力门控 `--relay-host`。
- **同步弹窗增强：** 可勾选提供商凭证，文件列表可滚动，修复 SSH 预览失败与远程清单 JSON 解析。
- **更细的远程启动错误分类：** CLI 缺失、npm registry 不可达、CLI 版本过旧各自给出排查指引。
- **修复 Relay 热切换误切直连：** 令牌被拒不再把请求全部变成 401。

### 性能

- **多设备 Relay 内存修复：** SSE 广播加入背压与每客户端缓冲上限，慢设备不再让主机内存持续上涨。
- **多会话并行更省电：** 事件处理改为增量索引与批量合并，多会话同时流式时显著降低 CPU。
- **流式渐入动效回退：** 出于性能考虑移除 beta.23 引入的流式动画与逐帧插值。

### 稳定性

- **子 Agent 会话渲染崩溃修复：** `useSyncExternalStore` 快照引用稳定契约修复，消除无限重渲染崩溃。
- **Electron 子 Agent 侧栏不再叠字：** 列宽变化时虚拟列表重新测量行高。
- **Git 更改列表顶部可全部还原。**
- **关于页「提交反馈」入口：** 一键跳转 GitHub Issues，窄屏不折行。

## [1.18.4-beta.29] - 2026-08-27

### 修复

- **历史上翻时滚动位置被持续拉回：** 桌面端向上滚动加载更早消息时，视口锚点保持器在 DOM 变化的微任务里用旧锚点补偿滚动位置，与用户滚动同帧竞态时会把刚滚上去的位置反向拉回，表现为「上面有内容却滚不动」。现在补偿前先检测外部滚动写入：检测到用户或虚拟化器改过滚动位置就先接受新位置再跳过本次补偿，用户滚动永远优先；纯内容变化的补偿行为不变。
- **会话历史偶发提前判定加载完毕：** 上游分页游标偶发缺失时（满页却无 `x-next-cursor` 的竞态），服务端会错误地把历史标记为已完整，客户端从此无法再向上加载（直到重新进入会话）。现在满页无游标视为可疑截断：不再永久标记耗尽，改发可重试的边界游标，客户端下次请求可继续向上翻页；短页无游标仍是权威的加载完毕。

## [1.18.4-beta.28] - 2026-08-27

### 修复

- **「全部 / 置顶」下打开最近会话不再切走当前项目：** 移动端最近会话面板在「全部」或「置顶」范围打开其他项目的会话时，当前项目会被静默切换到该会话所属项目。现在这两类跨项目范围仅导航到会话本身，不动当前项目；选择具体项目筛选时仍保持原有的项目跟随纠正。

### 移动端

- **划词菜单两列布局：** 选中文本后的操作菜单中「添加到对话」「新建会话」并排两列，「复制」独占整行，按钮宽度更均衡。

## [1.18.4-beta.27] - 2026-08-27

### 修复

- **半浮层下滑关闭后闪一下全屏：** 移动端可缩放浮层（会话列表、文件、变更、设置等）下滑关闭时，收起动画结束后会短暂重新展开到全屏再收起。原因是关闭动画结束后用 `requestAnimationFrame` 读尚未同步的受控 `open` 值做校正，按旧的 `true` 又把浮层拉了回来。现在 commit 关闭在动画落点即卸载，校正完全交由受控 `open` prop 驱动，不再与 React 的渲染时机抢跑。

## [1.18.4-beta.26] - 2026-08-27

### 修复

- **`/new` 命令文本残留输入框：** 输入框发送 `/new`（或命令菜单选中直接执行）后，新会话已建立但 `/new` 文本仍留在输入框。现在 `/new` 与 `/compact`、`/fork` 一致，执行前同步消费命令文本，切换会话时输入框已清空。

## [1.18.4-beta.25] - 2026-08-27

### 动效

- **回退流式输出动效：** 出于性能考虑，移除 beta.23 引入的流式渐入动画与逐帧文字插值，流式渲染恢复原有节奏。

## [1.18.4-beta.24] - 2026-08-27

### 修复

- **冷启动期间底部状态行反复闪动：** 清缓存冷启动（多会话同步消息进行中）时，连续工具调用的推理动画与「整理中」类状态行整行反复出现消失、文案高频轮换。现在冷启动 transcript 拼装期的工作中判定完全由权威会话状态驱动（pending 助手回退仅在已有完成消息时启用），generic 状态文案切换纳入 1200ms 显示队列、结束后延迟 600ms 平滑退场，状态行不再逐帧插拔底部布局。

## [1.18.4-beta.23] - 2026-08-26

### 会话

- **置顶会话不再因列表滚动同步而丢失：** 置顶状态迁入独立的 `session_pin` 持久表，会话索引快照新增权威 `pinnedSessionIds` 字段；即使置顶的会话已滑出「最近 20 条」摘要窗口，置顶关系依然保留并在侧栏正确置顶，历史数据自动迁移。

### 动效

- **流式回复渐入动画：** 流式输出过程中新增的 Markdown 块与工具卡片以柔和的淡入/模糊渐显呈现（可配置时长与错峰延迟），并尊重系统「减弱动态效果」设置；滚动加载的历史内容不再触发入场动画。

## [1.18.4-beta.22] - 2026-08-26

### Git

- **更改列表顶部可全部还原：** 全部还原从文件列表底部挪到更改区标题栏图标，放在分支按钮左侧；点按后仍先确认，再丢弃全部本地更改。

## [1.18.4-beta.21] - 2026-08-26

### 修复

- **紧急修复 beta.20 中子 Agent 会话导致的渲染崩溃：** beta.20 的子 Agent 提问归属修复在读取会话派发关系时未遵守 React `useSyncExternalStore` 的快照引用稳定契约——会话数据未变时每次读取都返回新数组，触发无限重渲染直至整页崩溃。现在按派发关系的语义内容缓存结果，数据不变即返回同一引用；回退了触发崩溃的窗口（如启动早期走 store 回退路径、transcript 投影被等价重建）也保持稳定。子 Agent 提问归属修复本身保持有效。

## [1.18.4-beta.20] - 2026-08-26

### 会话

- **修复 fork 会话复用子 Agent 后提问卡死：** 会话被 fork 后继续用 task_id 复用同一子 Agent 会话时，子 Agent 的归属仍指向 fork 前的旧会话，其运行中的提问永远浮不到当前会话，主会话与子 Agent 双向等待、任务永久挂起。现在阻塞请求（提问/权限）的收集范围在会话树之外补充读取运行中 task 的派发关系，子 Agent 的提问会重新出现在当前会话中，可直接回答；任务结束后不再纳入范围。

## [1.18.4-beta.19] - 2026-08-26

### 移动端

- **修复操作半浮层按压高亮缺口：** 项目、附件和存图操作行的点击背景铺满整行，不再被安卓滚动条槽或过大圆角切出缺口。
- **会话列表弹窗筛选在打开后可改：** 默认当前项目只在刚打开时生效，打开后点「全部」不会被立刻改回去。

## [1.18.4-beta.18] - 2026-08-26

### 会话

- **修复 fork 会话首次对话后不生成智能标题：** fork 会话的首次智能总结依赖 `session.created` 事件送达服务端，当 SSE 断连重连或 OpenCode 实例重启导致该事件丢失时，fork 后第一次新对话完成永远不会触发标题生成。现在 fork 后的第一条新消息会在既有会话读取中惰性补注册待刷新条目（fork 标题 + 消息晚于 fork 创建 + 活动时间未推进过 fork 时间），断连场景也能自愈；正常路径与后续对话行为不变。

## [1.18.4-beta.17] - 2026-08-26

### 移动端

- **选区气泡随滚动消失：** 聊天消息、文件预览、Changes 与编辑器里的选区操作栏/气泡在内容滚动时自动消失，重新选中会再次弹出。
- **Button 链接触控目标对齐：** 以链接形态渲染的共享按钮（如反馈入口）与原生按钮保持相同的 36px 触控目标下限，并排显示不再高低不齐。

## [1.18.4-beta.16] - 2026-08-26

### 性能

- **多设备 Relay 内存修复：** SSE 事件广播加入背压与每客户端缓冲上限，慢设备或半开连接不再让主机端内存持续上涨，异常连接会被自动清理。
- **多会话并行更省电：** 客户端事件处理改为增量索引与批量合并，多个进行中会话同时流式输出时显著降低 CPU 占用，多设备订阅同一主机时改善最明显。

### 移动端

- **选区操作栏组件收敛：** 文件预览的文本选区操作栏复用聊天区共享组件，行为不变。

## [1.18.4-beta.15] - 2026-08-26

### 移动端

- **文件只读预览自动刷新：** 打开文件时监听外部变更，文件被外部修改（大小或 mtime 变化）后自动重新拉取内容，无需手动刷新。
- **文件预览文本可选：** 只读预览里选中文本会弹出操作栏，支持加入对话 / 新建会话 / 复制，与聊天区一致。
- **DPI 字体缩放修复：** 建立会话中、空态、时间线、分页标题等几处文案改用语义字号，随物理 DPI 缩放；收起态输入预览与输入框字号对齐。
- **会话列表弹窗默认当前项目：** recent-sessions 打开时默认聚焦当前项目，不再停留在历史选择。
- **文件树展开限制深度：** 展开全部不再无限递归加载嵌套目录，限制在 10 层内。

### 远程实例

- **修复 Relay 热切换误切直连：** 只有探测返回明确可用（ok / update-recommended）才会把桌面从正常 E2EE relay 切到直连；可达但令牌被拒（auth）不再把请求全部变成 401。

### 聊天

- **Diff 选区操作栏修复：** 选区操作栏不再因指针手势误触发或误关闭，移除了已废弃的「添加到笔记」入口。

### 其它

- **代码高亮布尔值着色更完整：** 语法高亮把 undefined / null / NaN / Infinity 也归入布尔着色。

## [1.18.4-beta.14] - 2026-08-25

### 远程实例

- **同步弹窗可勾选提供商凭证：** SSH / Direct / Relay 都可直接勾选 `auth.json`，勾选时自动授权本次凭据同步，不再因缺少入口而无法勾选。
- **同步文件列表可滚动：** 预览列表独立限高滚动，条目较多时不再被裁切。
- **修复 SSH 同步预览失败：** 预览结果不再丢掉 `plan` 字段，弹窗不再误报「当前窗口无法同步」。
- **修复远程清单 JSON 解析：** 远程 inventory 路径值正确转义，拉取对比不再因 JSON 损坏失败。

## [1.18.4] - 2026-08-25

### 远程实例（SSH + Relay）

- **SSH 远程自托管 Relay：** managed SSH 启动的远程实例可直接作为 private relay host，手机等设备用普通配对直连远程，不再经桌面中继。
- **更细的远程启动错误分类：** CLI 缺失、npm registry 不可达、CLI 版本过旧各自给出对应排查指引。

### 聊天

- **`@` 文件引用更可靠：** 确认后才高亮并整段删除，源码优先排序，未匹配项不再混入结果。
- **回复完成信息即时显示：** TPS、时长与 token 统计不再滞后显示，等待回复期间也提前显示模型标识。
- **「正在处理」区域更稳定：** 处理中锁定展开避免过程行跳动，历史时间线不再覆盖实时尾部。
- **上滑加载历史更顺滑：** 落地补偿不再断触或回跳，长文阅读锚点保持有效。

### 会话

- **`/fork` 修复：** idle 会话复制完整历史，进行中会话以最后一条用户消息为切点，不再卡死或切错位置。
- **回顾摘要上下文瘦身：** 摘要只取关键正文与最近输入，显著降低 token 消耗。

### 移动端

- **OTA 更新渠道开关：** 设置中可加入 Beta 更新渠道并一键回退稳定版；修复 iOS Beta 壳收不到 OTA 更新的问题。
- **实例列表更统一：** 副标题统一显示连接状态，纯中继实例同样可重命名。

### 项目

- **添加项目后直接开新会话：** 快速添加成功后立即打开新会话草稿，新项目置顶显示。

### 设置

- **关于页新增「提交反馈」：** 一键跳转 GitHub Issues，按钮窄屏不再折行。

## [1.18.4-beta.13] - 2026-08-25

### 会话

- **回顾摘要上下文瘦身：** 生成会话回顾时，AI 侧只取最后一条回复的最后一段正文（更早段落与工具输出不再进入摘要），用户侧只取最近 3 条真实输入；斜杠命令附加的隐藏指令也不再计入摘要上下文，显著降低摘要调用的 token 消耗。

## [1.18.4-beta.12] - 2026-08-25

### 聊天

- **`@` 引用确认后再高亮：** 输入中的 `@yi.ts` 只是查询文本，Backspace 按字符删除；空格/回车选中或粘贴路径引用后才高亮并整段删除。
- **文件引用排序：** 源码优先于 test；带 `.ts` 等后缀按文件搜；以 `/` 结尾按目录搜。未匹配项不再混进结果。
- **打开会话不再被点选手势带离底部：** 移动端进入会话后短暂保持钉住最新消息，避免列表点击的残留触摸把时间线拽到中间。

### 会话

- **`/fork` 不再从上一轮切开：** idle 会话（含 `/session/status` 省略导致的状态缺失）复制完整历史；进行中的 fork 以「最后一条用户消息之后」为排他切点，保留该轮用户消息、排除未完成的助手回复。

## [1.18.4-beta.11] - 2026-08-25

### 移动端

- **切换实例列表副标题统一：** 不再显示实例地址（IP）或「中继」标记——当前连接的实例显示「已连接」，其余显示「已保存」。
- **所有已保存实例均可重命名：** 纯中继（relay）方式添加的实例同样显示编辑按钮，可修改名称；编辑这类实例时隐藏服务器 URL 输入框，仅保留名称与令牌。
- **「已保存的连接」列表副标题统一：** 欢迎页连接列表同样不再显示地址或中继字样。

### 聊天

- **修复历史记录帧溢出：** 历史时间线帧改用 `minHeight` + 尾部内边距预留未渲染区；当可见行高于缓存尺寸时帧会撑开，避免覆盖下方实时尾部，后出现的内容不再画在前一回合之上。

## [1.18.4-beta.10] - 2026-08-25

### 设置

- **关于页按钮同行显示：**「提交反馈」与「检查更新」按钮固定单行排列，窄屏不再折行。

## [1.18.4-beta.9] - 2026-08-25

### 移动端

- **修复 iOS Beta 壳收不到 OTA 更新：** 门禁语义修正——仅当 stable 渠道时，「builtin 壳 + 剥离版号 ≥ active」才判定为「壳已内嵌该 web 版本」；beta 渠道下 iOS 剥离营销版号（如 `1.18.4`）不再被误判为已内嵌 `1.18.4-beta.N`，旧壳可正常收到 beta OTA 更新。

### 设置

- **关于页新增「提交反馈」：** 「检查更新」按钮左侧新增反馈入口，点击跳转 GitHub Issues 页面（移动端与桌面布局均已添加）。

## [1.18.4-beta.8] - 2026-08-25

### 移动端

- **修复 iOS Beta 壳收不到 OTA 更新：** 门禁语义修正——仅当 stable 渠道时，「builtin 壳 + 剥离版号 ≥ active」才判定为「壳已内嵌该 web 版本」；beta 渠道下 iOS 剥离营销版号（如 `1.18.4`）不再被误判为已内嵌 `1.18.4-beta.N`，旧壳可正常收到 beta OTA 更新。
- **OTA 更新渠道开关：** 设置 → 关于新增「加入 Beta 更新渠道」开关（仅原生 App）。开启后无论安装包烘焙的渠道是什么，OTA 一律检查 beta；关闭后改为检查稳定版。开关默认跟随安装包渠道，不影响现有用户。
- **Beta 一键回退稳定版：** 关闭开关时立即按稳定版重新检查更新；若当前运行的是 Beta 版本且存在可回退的稳定版，弹确认框说明目标版本，确认后走正常 OTA 下载/重启流程回退到稳定版最新版本，取消则保留 Beta 渠道并恢复检查。
- **布局分隔线统一 hairline 令牌：** 侧栏、页头等布局分隔线统一改用 `--layout-chrome-divider`（0.5px + 30% 不透明度）令牌，各面板视觉上更接近同一表面。

## [1.18.4-beta.7] - 2026-08-25

### 远程实例（SSH + Private Relay）

- **SSH 远程自行托管 Relay：** managed SSH 启动的 `openchamber serve` 以 `OPENCHAMBER_RUNTIME=ssh-remote` 运行，并带 `--relay-host`；remote 进程本身成为 private relay host（与 desktop 同级），手机 / 另一台电脑用普通 pairing 直连该 remote，不再经桌面中继。
- **按远程 CLI 能力门控 `--relay-host`：** 连上远程后先探测 CLI 是否支持 `--relay-host`，旧版本会自动省略该 flag，避免「新桌面配旧远程」时命令直接失败。
- **复用旧 web serve 时自动重启为 relay host：** 已在跑、但 runtime 不是 `ssh-remote`/`desktop` 的 managed 实例会先停再按新命令拉起，避免「连上了却 relayAvailable=false」。
- **更细的启动错误分类：** 远程 CLI 缺失、npm registry 不可达、CLI 版本过旧不再都归入「安装失败」，各自给出对应的排查指引。
- **桌面 SSH host 挂上 relay 描述符：** 连接成功后把 remote 的 `serverId` / `hostEncPubJwk` 写进该 host，SSH 隧道断开后桌面可走 relay 回连；手机配对仍在该 remote 的「添加设备」里生成普通 pairing。
- **SSH 默认开启 remote relay host：** 新建/已有 managed 实例默认 `relayHost: true`（可显式关掉）；连接时带 `--relay-host`，并在连上后写入 relay 描述符。
- **移除 desktop 中继 SSH 路径：** 删除 `x-openchamber-target-port` 路由、`/api/openchamber/ssh-host-token`、`sshTarget` / `viaSshRelay` / pairing `sshHostId`。桌面本机仍可通过 SSH local-forward（apiUrl + clientToken）访问该实例。

## [1.18.4-beta.6] - 2026-08-25

### 聊天

- **Electron 打开子 Agent 侧栏不再叠字：** 主会话列宽被挤窄后，虚拟列表会按新列宽重新测量行高，消息、徽章和时间戳不再互相叠在一起。
- **停止后队列头不再提前消失：** 中止当前回合后，下一条排队消息会保持「发送中」直到真正发出，不再从队列里提前藏掉。

### 会话

- **上一条 / 下一条覆盖置顶：** 快捷键按侧栏实际顺序走，先置顶再项目列表，并在两端循环。

## [1.18.4-beta.5] - 2026-08-25

### 聊天

- **思考强度徽章实时显示：** 修复实时消息合并时把 `model` 对象当作字符串字段误删的问题，发送时选择的思考档位（如 Xhigh）随回复立即显示在消息头，不再需要冷加载后才出现。

### 移动端

- **上滑加载历史不再断触：** 触摸滚动进行中遇到历史加载落地时，不再同步写入滚动位置打断手势（WKWebView 会断触直到抬手重按）；补偿改为抬手后按手势锚点相对恢复，手势期间继续滚动则放弃补偿。

### 会话

- **fork 不再因状态缺失卡死：** 会话状态条目缺失时按活跃处理，fork 定位到最后一条用户消息，不再在 fork 点守卫处死等。

## [1.18.4-beta.4] - 2026-08-25

### 移动端

- **附件选择弹窗更协调：** 紧凑底栏贴内容高度，标题区不再头重；「附加照片 / 附加文件」收成一组卡片，点击有按压缩放和高亮。
- **输入框 Agent 名称垂直居中：** 展开后的 Agent 名称与模型芯片同一行高，不再偏上。

## [1.18.4-beta.3] - 2026-08-25

### 聊天

- **回复完成后立即显示 TPS 与时长：** 实时流结束时若「会话进行中」状态滞后翻转，不再压住最后一条回复的完成信息（TPS、耗时）等待后续刷新，避免最长一分多钟才显示。
- **丢失的 token 统计自动补齐：** 结算事件丢失导致 token 数缺失时，空闲期合并会从快照补齐正数 token，同时会用一次对账页修复尾部回复的完成时间与 token，TPS 不再长期空白。
- **等待回复时提前显示模型标识：** 发送消息后、助手首行出现前的空窗期，立即按发送时选定的模型 / Agent 显示助手消息头，不再空白一截。
- **处理中的最后一回合收紧底部间距：** 进行中的回合底部改为紧凑间距，回合结束后恢复与下一回合之间的正常间距，上下消息不再忽远忽近。

### 滚动 / 历史加载

- **上滑加载历史不再回跳：** 加载进行中若用户继续快速滚动，落地时不再把视口拉回加载前位置；以用户当前位置为锚做相对补偿。
- **历史阅读锚点在滚动期间保持有效：** 加载落地后内容水合 / 材料化仍在改变高度，视口锚点在校正期内随用户滚动续期，长文阅读不再因定时器到期突跳。

## [1.18.4-beta.2] - 2026-08-25

### 聊天

- **空的「正在处理」不再占位：** 对话刚开始、折叠区域里还没有任何工具/推理内容时，不再显示空的「正在处理」标题；有内容后再出现。
- **上翻历史更稳：** 桌面端「加载更早消息」改为悬浮提示，不再顶开布局；加载窗口内用视口锚点校正材料化/水合带来的跳动。

## [1.18.4-beta.1] - 2026-08-25

### 聊天

- **「正在处理」区域处理中锁定展开：** 整理后显示模式下，对话进行中的「正在处理」折叠区域不再显示缩进与左侧竖线，也不允许折叠，避免过程行左右跳动；回合完成后恢复缩进竖线并允许折叠。

### 项目

- **添加项目后直接开新会话：** 在目录浏览对话框中添加（快速添加）项目成功后，立即为该项目打开新会话草稿，桌面与移动端一致。
- **新项目置顶：** 新添加的项目出现在项目列表最前面，手动排序同步前置。

## [1.18.3] - 2026-08-24

### 移动端

- **应用内热更新：** 无需重装即可在后台接收界面更新，支持自动检测新版本、更新通知与更新说明展示。
- **输入框体验升级：** 上滑聊天时输入框自动收起为紧凑条，键盘自动避让，交互更跟手流畅。
- **界面密度自适应：** 支持按偏好缩放字号与间距，适配不同屏幕显示大小。
- **外测 iOS 版本：** 正式版同步发布到 TestFlight 外测。

### 远程实例（SSH）

- **开箱即用：** 连接远程机器后自动完成环境初始化，无需手动配置即可开始工作。

### 聊天

- **更稳定的连接：** 切换后台再回来时，正在进行的对话状态能正确恢复。
- **更好的同步提示：** 消息同步中会给出清晰提示，避免误以为卡住。

### Git / 变更

- **新增文件可查看内容：** Changes 中打开新增文件即可查看完整内容，不再显示空白。

## [1.18.3-beta.16] - 2026-08-24

### Desktop / SSH

- **托管 SSH Bootstrap 优先偶数 LTS 并自动修好 native binding：** 远程选 Node 不再只取版本号最高（fnm 的 23 会压过 DevCloud 的 22.19），改为偶数 LTS（22/24）优先、同级再看是否带 sibling `npm`。`better-sqlite3` 探测失败后会清掉半成品 `build/node_gyp_bins`、补 python/gcc、rebuild 重试，仍失败再按当前桌面版本 `npm install -g` 重装。全新远程机不必再因 node-gyp ENOENT 卡在 `requires_user_action`。
- **托管 SSH 启动失败在桌面端给出可操作指引：** 连接弹窗、Toast 和「远程实例」详情不再把整段 npm/gyp 日志丢给用户。桌面会按原因分类（缺 Node 22+、native binding、SSH 认证/不可达等），显示对应修复步骤，并提供打开远程实例设置、切回本地、重试。

## [1.18.3-beta.15] - 2026-08-24

### 移动端

- **输入框缩略态切换手势只在松手后吸附：** 此前滚动拖动中进度一过阈值、或缓慢拖动时滚动事件间隔超过静止判定窗口，就会在手指未松开时反复触发吸附动画，缩略药丸与展开卡片来回闪动。现在跟随区间覆盖完整行程（拖动中不再停留在两层都不可见的交接点），手指按住期间只跟手、不提交；松手（或滚动静止）后按进度阈值一次性完成吸附，全程跟手到达端点时自然落位。

## [1.18.3-beta.14] - 2026-08-24

### 聊天

- **输入框发送与停止按钮宽度占位对齐：** 触控设备上发送按钮不再被抬到 36px，与停止按钮共用同一套 compact 尺寸豁免，空闲纸飞机与进行中停止方块切换时右下角占位不再跳动。

## [1.18.3-beta.13] - 2026-08-24

### Git / Changes

- **新增文件在 Changes / Diff 中显示内容：** 新增（A / 未跟踪）文件打开后不再空白（只剩 +0/-0 与 Stage / Discard 浮层）。此前预取写入的双空 `{original:'', modified:''}` 缓存被当成"已加载"的完整 diff，跳过按需拉取、渲染 0 行；现在双空非二进制的缓存视为未加载，会正常拉取并展示全部新增行，双空坏结果也不再进缓存（真 0 字节文件显示空 diff 且不重复拉取）。VS Code 运行时同步修复：新增 / 未跟踪文件的 `modified` 从工作区（暂存新增从 index）读取，不再因 `git show` 失败回落双空。

## [1.18.3-beta.12] - 2026-08-24

### 聊天

- **进入会话恢复模型 / Agent 选择加服务端实体兜底：** 此前恢复级联只有 transcript 历史（最后一条 user 消息推导）→ 本地 selection-store 记忆（localStorage，上限 150 条，延迟落盘可丢）两级，偶发同时失效时静默不恢复，选择器显示目录默认模型 / Agent（移动端进会话偶发"被重置"）。现加第三级 SDK session 实体（`Session.agent` / `Session.model`，服务端维护、启动即加载、随 `session.updated` 刷新），同样经 catalog 校验，校验失败仍回落默认，不污染选择。

## [1.18.3-beta.11] - 2026-08-24

### 聊天

- **只读子代理提示栏 Agent / 模型名垂直居中：** meta 行去掉偏大的固定行高，改用 `leading-none`，与 14px 头像/模型图标通过 `items-center` 对齐，避免名称视觉偏上。

## [1.18.3-beta.10] - 2026-08-24

### 移动端

- **切后台重连后恢复运行中状态显示：** 重连补偿完成后对当前会话确认一次权威 session status；transcript 尾部仍是未完成 assistant（turn 未 settle）时，active-membership 缺席不再把 busy 权威降级成 idle，streaming / 发送中状态不再丢失（此前需杀掉 APP 冷启动才恢复）。同一会话短窗口内重复 `resetRequired` 降级为非破坏性 ensure tail，不再反复清空 transcript 与 streaming 证据。
- **移动端输入器 swap 状态随作用域切换清理：** 会话切换 / 关闭 swap 时清掉残留的 swap CSS 变量与 phase；非 overlay 的输入器 foot（草稿 / 空会话 / 历史错误页）固定 expanded、不参与 swap，避免上一会话泄漏的 swap 状态让 "Tap to type" 药丸挡住真实输入框。收回桌面端输入器 chrome 的 focus 透明度强调逻辑。

## [1.18.3-beta.9] - 2026-08-24

### 移动端

- **收回 beta.8 对非 text 预设的改动：** 只保留 Tailwind `text-xs`…`text-9xl`（含 `text-xl`）走 `--dpt`。语义 token、leading、组件字号、`typography-small` 恢复原样。

## [1.18.3-beta.8] - 2026-08-24

### 移动端

- **字号预设全部在样式集接 `--dpt`：** 语义 token（`--text-markdown` / `--text-ui-label` 等）、移动端标题/meta、设置 section title、表单 helper、Tailwind `leading-3`…`leading-10` 都改成 `calc(N * var(--dpt))`。补上从未定义的 `typography-small`。iOS standalone 不再用 rem 钉死 typography 类。

## [1.18.3-beta.7] - 2026-08-24

### 移动端

- **Tailwind `text-sm` / `text-base` 等字号走 `--dpt`：** 在 `@theme inline` 里把 `text-xs`…`text-9xl` 写成 `calc(N * var(--dpt))`，和 spacing 的 `--padding-scale` 同一套。任意值 `text-[13px]` 仍由 PostCSS 改写 `font-size`。

## [1.18.3-beta.6] - 2026-08-24

### 移动端

- **更新弹窗确认按钮接入共享 Button：** 「一键更新 / 立即更新 / 下载中」原先是手写 `text-sm` 原生 button，不走 `--text-ui-label`。改为共享 `Button`（与重启、稍后、删除确认等同一套 `typography-ui-label` × `--dpt`）。标题去掉 `text-base` 覆盖，跟 DialogTitle 语义字号。

## [1.18.3-beta.5] - 2026-08-24

### 移动端

- **加载更早消息按钮与查看上下文弹层随密度缩放：** 去掉移动端对 `typography-*` 的 `font-size: unset !important`。该类本就走 `--text-*` / `--dpt`；unset 后按钮（`typography-ui-label`）和上下文弹层标签回落到根节点 16px，正文缩小后割裂。

## [1.18.3-beta.4] - 2026-08-24

### 移动端

- **更新资格改为按 Web 版本号判断：** 端内「一键 OTA / 需重装」不再比较 CI 构建号（两条发布线的构建号各自计数，手动构建的新壳会被误判过旧而强制重装），改用构建时烘焙的 Web 版本号做门槛。含原生变更的版本发布时会记录版本下限 `minShellReleaseVersion`，旧壳照常收到重装提示；纯 Web 的 beta 依旧不抬门槛。
- **移动端附件菜单迁移到可调高度面板：** 附件展开菜单与安卓照片/文件选择改用统一的 `MobileResizableSheet`，行按钮加大触控目标，与其余移动端面板保持一致。

## [1.18.3-beta.3] - 2026-08-24

### 聊天

- **「正在同步消息」提示覆盖后台追赶并消除闪动：** iOS 切后台再切回等断线恢复期间，即使页面已有内容也会真实显示同步提示（重连补偿、恢复拉取、失联会话补齐均有信号）；例行核对（会话切换热重验证、空闲补全）保持静默不扰民。显示层加滞回防抖：持续 250ms 以上的同步才出现，结束后保留 1 秒宽限，接力的多轮恢复合并为一次连续显示，不再连闪五六次。
- **队列中止改为等待服务端空闲：** 停止排队消息时不再固定等 2 秒窗口，而是跟随服务器空闲状态，避免过早/过晚中止。

## [1.18.3-beta.2] - 2026-08-24

### 聊天

- **停止按钮改回实心方块：** 去掉白底圆试验样式；浅色模式黑方块、暗色模式白方块，移动端恢复原有尺寸。
- **问题卡键盘避让：** iOS 非输入框字段聚焦时用 `--oc-kb-scroll-inset` 给聊天列表加底 padding；输入框焦点仍走整页上顶，并清掉该 inset，避免双重抬升。

## [1.18.3-beta.1] - 2026-08-24

### 聊天

- **移动端输入框改为交替吸附：** 上滑时完整输入卡下沉、80% 半透明细条升起；前半段跟手，走完半程自动吸到终态，未走完则弹回。去掉 CSS scroll timeline 与永久 latch，重复展开/收起不再卡死。
- **缩略态细条内嵌「回到底部」：** 放在输入区右侧纯图标（无圆底），有中止按钮时排在中止左侧；完整态仍保持原脚部间距。
- **缩略态附件图标左侧留白加大**，避免贴边。

## [1.18.2-beta.72] - 2026-08-23

### 聊天

- **移动端输入框滚动收起改为纯 CSS scroll timeline 驱动：** 移除 scroll 监听、rAF、`useEffect` 与 `ResizeObserver` 动画/测量，进度由命名 `--oc-chat-bottom` 时间轴 + `animation-range: calc(100% - 100px) 100%` 提供，只在支持 scroll-driven animation 的引擎（iOS 26+ / Android WebView 115+）启用收起，旧版保持完整展开；底部预留恒定，队列 / changes / todo 由 reveal 区连续收进，输入卡全程完整可见，终态为居中 80% 半透明单行条，键盘/聚焦/听写锁定完整工具栏。移除 `compensateMobileComposerDistance` 几何反馈补偿及相关测试。

## [1.18.2-beta.71] - 2026-08-23

### 聊天

- **移动端输入框滚动渐进收起正式版：** 上翻消息时输入框在离底部 0–100px 内跟手收起（无 React 滚动重渲，几何反馈已补偿）；队列 / changes / todo 保持原有样式，只作为整体从输入框上方收进；终态为居中 80% 半透明悬浮条（正文从两侧和底下透出，减少透明度模式下保持实色）。收起态第一次点击仅恢复全宽不弹键盘，第二次点击才聚焦；键盘开启或失焦保持全展开，下一次上滚再恢复收起。changes / todo 的弹出层在展开态不受裁切影响。

## [1.18.2-beta.70] - 2026-08-23

### 聊天

- **iOS 键盘改为整页上顶：** 去掉 transform FLIP。键盘出现时立刻缩短 shell，header 钉住，聊天列表跟着上移；顶起范围是整块输入框（附件/模型/发送和底部空隙），不是只露出光标。安卓仍走原来的 FLIP。
- **移动端输入框随上滑收成紧凑条：** 聊天上滑前 100px 连续把输入框收成居中紧凑行（附件 + 单行 + 停止）；点按或聚焦钉回完整工具栏，键盘打开时保持完整高度。

## [1.18.2-beta.69] - 2026-08-23

### 移动端

- **修复 iOS TestFlight 检测不到 Beta OTA：** Capgo 内置包会把 `CFBundleShortVersionString`（正式版号 `1.18.2`）当成当前 Web 包版本上报；semver 认为正式版比任何 `1.18.2-beta.N` 都新，检查接口就返回「已是最新」。Beta 渠道现在只按运行中的 Web 包版本检查，服务端也不再把这个剥离后的营销版本当成正式版地板。安卓不受影响（`versionName` 本身带 `-beta.N`）。

## [1.18.2-beta.68] - 2026-08-23

### 移动端

- **撤回「Web 包」显示项：** 关于页恢复单行客户端版本（界面版本 + 构建号），移除 beta.66 引入的独立「Web 包」行与「已是最新」提示中的版本描述。

## [1.18.2-beta.67] - 2026-08-23

### 聊天

- **移动端键盘收起后页面不再滞留「抬起」状态：** WKWebView 收起键盘时会用自带的回滚动画慢慢放平为露出光标而平移的页面，观感为键盘已完全收起、输入区却还悬着；现在在收起同帧与键盘结束各做一次窗口零位校正，让页面与键盘同步落地（对齐 PWA 已有的收起 snap 逻辑）。

## [1.18.2-beta.66] - 2026-08-23

### 移动端

- **关于页恢复双版本显示：** Capacitor 壳内「客户端版本」行改为显示原生壳身份（营销版本 + 构建号，如 `1.18.2 (392)`），其下新增「Web 包」行显示运行中的 OTA 界面版本；检查更新提示已是最新时，toast 会附带当前界面版本。修复 TestFlight 更新原生壳后无法判断 OTA 是否生效的问题——纯 web 的 beta 更新不改变构建号，只前进「Web 包」版本。
- **补发 iOS 原生壳 build 392：** 内嵌 beta.66 界面包，供 TestFlight 用户覆盖安装（上一个可装壳为 391 / beta.61）。

## [1.18.2-beta.65] - 2026-08-23

### 调试

- **（临时调试构建）移动端输入框常驻完整展开 + 完整工具栏：** 禁用胶囊收起路径，完整工具栏（附件、Agent、模型选择、目标、发送）随输入框默认渲染显示，不依赖键盘/焦点状态，用于真机排查渲染/显示问题；非调试行为将在后续版本恢复。

## [1.18.2-beta.64] - 2026-08-23

### 聊天

- **修复重启后思考强度被重置成默认：** 打开应用时从服务端回拉的收藏/最近列表若缺少思考强度（旧版本客户端或旧服务端数据写入），不再覆盖掉本地已记录的强度；本地记录会随偏好同步推回服务端自愈。配合 beta.62 的选择器修复，收藏/最近列表的思考强度记录在重启与多端同步后稳定保留。

## [1.18.2-beta.63] - 2026-08-23

### 调试

- **（临时调试构建）移动端输入框常驻完整展开态：** 禁用胶囊收起路径，输入框在收起场景下也完整渲染显示，用于真机排查渲染/显示问题；非调试行为将在后续版本恢复。

## [1.18.2-beta.62] - 2026-08-23

### 聊天

- **模型变体选项解析收口：** 当前选中模型完全信任选择 catalog（含 `variantsReady === false` 时等待为空）；非当前模型不再错误地借用 catalog，改从 provider 列表解析，收藏/最近使用里记住的变体仍能正确显示与应用。同时修正了回调依赖列表。

### 发布

- **TestFlight 规则改为跟随原生变更：** 纯 web 的 beta（`mode: ota`）不再上传 TestFlight；含原生壳变更的 beta 与正式版仍上传（beta 仅内测）。修复了 CI 在 tag 检出时把发布 tag 自身当作 diff 基线、导致「原生变更」判定从未真正生效的缺陷——端内「一键更新 vs 跳转重装」的 `minNativeBuild` 抬升现在两端一致地只在原生变更时发生。

## [1.18.2-beta.61] - 2026-08-23

### 聊天

- **收藏 / 最近使用记住思考强度：** 选择模型时把当时生效的思考强度一并记进收藏与最近条目，点击条目一键切回该模型与强度；收藏条目随每次选择更新为最新强度且不打乱顺序。列表行（桌面下拉、移动端面板、agent 设置页）在未选中时也直接显示记录的强度，已失效的档位自动回退默认。

### 诊断

- **新增 perf 性能探针：** 诊断开关开启时按 30s 窗口记录 FPS 采样、长任务、事件循环滞后与触感计数，随现有 client-diagnostics 导出，探针回调不影响调用路径。

## [1.18.2-beta.60] - 2026-08-23

### 移动端

- **半浮层标题栏 action 不再单独占一行：** 文件预览的复制内容 / 复制路径、目录选择器的「显示隐藏」都收到 close 左侧同一行，不再在标题下再起一行图标。

## [1.18.2-beta.59] - 2026-08-23

### 移动端

- **键盘收起即时归位，不再有约 500ms 迟滞感：** 收起的 200ms 补间会排在繁忙主线程帧（流式合并 + 渲染）后面，读起来像卡顿。现在 mover 同帧直接落位，键盘本体的 UIKit 淡出缝隙由 260ms 遮罩帘盖住。
- **原生壳内 composer 收起去掉隐藏动画：** 同样因补间排在忙帧后面造成迟滞，Capacitor 壳内 pill 与输入框同帧收起；浏览器 PWA 保留动画路径。

## [1.18.2-beta.58] - 2026-08-23

### 移动端

- **聊天正文模型名随密度缩放：** 消息头 `typography-ui-header` 被排版兼容块 `font-size: unset !important` 压掉后回落到根节点 16px，正文/chrome 已缩、模型名纹丝不动。从 unset 列表去掉该类，改走 `--text-ui-header`（移动端 `calc(14 * var(--dpt))`）。

## [1.18.2-beta.57] - 2026-08-23

### 移动端

- **助手停用页补回分享三步：** 保留精简标题与开启按钮，把「系统分享 / 快捷分享 / 选择助理」改成横向滑动卡片，去掉 Inbox Topic 长说明。

## [1.18.2-beta.56] - 2026-08-23

### 移动端

- **精简助手停用页：** 去掉分享教程、步骤卡和「当前实例」口吻，改成插画 + 一句说明 + 开启。

## [1.18.2-beta.55] - 2026-08-23

### 聊天

- **修复加附件 chip 后输入框字突然变大、光标错位：** 附件 citation 会打开高亮层（textarea 变透明、只画光标）。高亮层此前没命中真实的 `data-composer-highlight`，还被钉死成 16px，Android 上和已缩放的 textarea（约 14.4px）对不上。现在两层共用 `calc(16 * var(--dpt))`；收起态高亮垂直居中也跟 `--padding-scale` 走。
- **修复附件缩略图右侧出现滚动条：** 40px 预览图被通用 `.overflow-hidden → overflow-y: auto` 改成滚动容器，关闭按钮又被 36px 最小触控撑破。预览图标记为裁剪框并退出触控最小值。
- **流式输出时输入框仍能随内容长高：** 运行中不再跳过 ResizeObserver，只跳过同步强制测量；中途长高仍会发布舞台高度。

### 移动端

- **OTA 已装包上报发行版本号：** 已下载的 Capgo bundle 优先报 `version`（下载时的 releaseVersion），不再只报不透明 hex id，更新检查与 changelog 区间过滤才能对上当前包。

## [1.18.2-beta.54] - 2026-08-23

### 聊天

- **附件与 chip 尺寸补齐密度缩放：** 输入区附件图标（18px）、内联引用 chip 高度（26px）、附件文件名/路径截断宽度（200/220/140px）此前是任意 px 字面量，不随 `--dpt` 缩放；统一换算为 rem 令牌后走 `用户密度 × --dpt-n` 链。图片缩略图 chip（h-10）、队列 chip（h-7）与 chip 文字（text-[11px]→calc）已在链上无需改动。

## [1.18.2-beta.53] - 2026-08-23

### 移动端

- **标题文字不再上下截断：** 聊天页标题/副标题与消息头（模型名、变体后缀、agent 徽章）此前行高等于字号（`leading-none` / `line-height: font-size`），中文 ascender/descender 没有余量，密度缩放后上下被裁。现在标题行高 1.4 倍、消息头 1.25 倍——宁可容器长高，绝不裁字。

## [1.18.2-beta.52] - 2026-08-23

### 移动端

- **标题文字不再上下截断：** 聊天页标题/副标题与消息头（模型名、变体后缀、agent 徽章）此前行高等于字号（`leading-none` / `line-height: font-size`），中文 ascender/descender 没有余量，密度缩放后上下被裁。现在标题行高 1.4 倍、消息头 1.25 倍——宁可容器长高，绝不裁字。
- **首页 worktree 分支名与项目标题同字号：** 分支名改用 `oc-mobile-entity-title`（与项目名同一 `--oc-mobile-entity-title-size` / `--dpt` 链），不再用更小的 `typography-small`。

## [1.18.2-beta.51] - 2026-08-23

### 聊天

- **修复移动端输入框文字与 placeholder 不随密度缩放：** 排版兼容块的 `font-size: unset !important`（specificity 0,4,0）压过了输入框的 16px 缩放规则（0,3,1），导致带 `typography-markdown` 类的 textarea 回落到继承的根节点 16px 固定值——正文缩小、输入框纹丝不动。输入框规则改用 `:is()` 后代选择器提升到 (0,4,1)，Android 上输入框与 placeholder 随 `--dpt` 缩放（16×0.9=14.4px，仍比正文略大，保留 iOS 防 focus 缩放地板语义；iOS 不变）。

## [1.18.2-beta.50] - 2026-08-23

### 移动端

- **修复 Android 上 `--dpt` 被旧缓存悄悄抹回 1：** App 启动时原生计算会正确写入 `0.9`，但随后任何窗口尺寸变化（旋转、分屏、键盘）触发设备信息重算时，会从 localStorage 恢复旧版本物理计算写入的缓存值（如 `1.04`），把缩放整体顶回接近 100%，输入框、正文、图标全部"看起来没变化"。现在缓存恢复在 Android 上强制不超过 0.9 实验上限，旧缓存与空缓存都回落到 0.9。

## [1.18.2-beta.49] - 2026-08-23

### 移动端

- **首页 worktree 分支名不再压过项目标题：** 分支名从与项目名同级的 `typography-ui-label font-semibold` 降为 `typography-small font-medium`，项目名保持主标题层级。项目卡圆形图标容器与 ⋯ 按钮尺寸改为走 `--padding-scale`，与内部 glyph 一起随密度缩放。

## [1.18.2-beta.48] - 2026-08-23

### 移动端

- **内容驱动的容器高度随密度缩放：** 聊天页顶部标题栏、项目卡头部、会话行、设置行的最小高度此前是固定 rem（几何变量有意不缩），字号缩小后这些容器显得"限定死"偏高。现在它们走 `用户密度 × --dpt-n` 链一起缩放（会话行 0.9 时 41px、设置行 47px，均高于 36px 触控最小值）；返回按钮、底部 dock、表单控件等真触控目标保持固定。
- **消息头 agent 徽章对齐修复：** 徽章内 identicon 头像（内联 10px）与 9px 文字行高错位导致视觉截断；头像改走 `calc(px * var(--dpt-n))` 与文字同缩。活动行图标 `h-[14px]` 改为令牌类。

## [1.18.2-beta.47] - 2026-08-23

### 聊天

- **工具卡片角标字号补齐密度缩放：** 工具执行状态的三个角标用内联 `0.8rem` 压掉了 `typography-meta` 令牌，不随 `--dpt` 缩放；移除内联覆盖后与全局字号链一致。

## [1.18.2-beta.46] - 2026-08-23

### 移动端

- **输入区周边控件补齐密度缩放：** 修复手写 CSS 里的裸 rem 几何值（composer 动作/附件/模型按钮的宽高、各类手写 padding/gap/min-height）不随 `--dpt` 缩放的问题——构建期统一转成 `calc(Nrem * var(--padding-scale))`（用户密度 × 物理系数），与 Tailwind 间距同一管道。px 字面量（36px 触控最小值、键盘编排值、1px 边框）与几何变量（dock/表单控件高度）结构上不可能被转换，触控与键盘安全。输入区一行可容纳字数、队列 chip、附件与模型按钮在 Android 上与 iOS 密度对齐。

## [1.18.2-beta.45] - 2026-08-23

### 移动端

- **聊天页 header 标题与副标题行高随字号缩放：** 二级页/聊天页大标题（`.oc-mobile-detail-title`）与副标题的行高此前是固定 rem，字号缩小后行距不缩显得拥挤；现在行高与字号走同一 `--dpt` 链，Android 密度对齐覆盖到聊天 header。输入框文字 16px 规则在 beta.42 起已随 `--dpt` 缩放（iOS 保持 16px 防聚焦放大不变）。

## [1.18.2-beta.44] - 2026-08-23

### 聊天

- **移动端输入框键盘收起即时回落：** 修复下拉手势 / 键盘收起键 dismiss 后展开态要 1-2 秒才收成胶囊的问题；收起信号先于失焦提交，并对 WKWebView 的焦点还原做一次 80ms 确认兜底。
- **移动端聚焦后光标恢复显示：** 修复键盘已开时聚焦输入框（如从问题卡片切回）光标永久透明的问题；`caret-hold` 只在键盘真实升起期间生效，question 路径补齐清理。
- **移动端长会话输入框不再渐进变慢：** 键盘 FLIP 的固定 mover 改为常驻合成层提升，消除每次开合的 will-change 提升/回收 churn（iOS WebKit 惰性层回收是挂久变慢的来源）；展开手势动画移除不必要的 will-change 预热；听写收起与浮层键盘恢复的三个裸定时器补取消路径。
- **流式加载期间展开/收起更稳：** 消息行加布局 containment 限制重排范围；流式活跃时复用同源舞台高度缓存，不在交互边界强制全文档测量。

## [1.18.2-beta.43] - 2026-08-23

### 移动端

- **间距与图标密度全面对齐 iOS：** 所有 Tailwind 间距工具类（padding、gap、尺寸）现在通过 `--padding-scale = 用户密度 × --dpt-n` 全局叠加物理缩放——设置页、首页、项目页的内边距/行距/间距在 Android 上随 `--dpt` 一起缩放（约 −10%）。控件高度（dock、设置行最小高度、表单控件）、36px 触控最小值与键盘编排**有意保持固定**，避免触控热区缩小和键盘错位；iOS/桌面 `--dpt-n=1` 逐像素不变。

## [1.18.2-beta.42] - 2026-08-23

### 移动端

- **Android 密度对齐扩展到图标与页面标题：** 构建期字号转换新增 `--oc-*-title-size/-meta-size/-subtitle-size` 等排版变量（首页大标题、项目卡标题、二级页标题/副标题、设置分组标签与行说明、表单辅助文字），全部随 `--dpt` 物理系数缩放；布局几何变量（dock/头部高度、行最小高度）保持不动，键盘 inset 与触控热区不受影响。图标（svg）通过在 svg 子树叠加 `--dpt-n × 用户密度` 随密度缩放，全局间距不参与。iOS `--dpt=1` 行为不变。

## [1.18.2-beta.41] - 2026-08-23

### 移动端

- **置顶会话不再重复出现在项目列表：** 移动端首页改为与 PC 侧边栏共用同一套会话归属与置顶展示逻辑（`createSessionOwnershipIndex` / `derivePinnedSessions` / `omitPinnedSessions` 剔除）。置顶的会话只出现在顶部「置顶」卡，不再同时留在原项目/工作区列表；取消置顶后恢复原位。项目卡与会话计数同步排除置顶项，子目录会话的归属也与 PC 一致。

- **置顶卡样式与项目卡对齐：** 顶部「置顶」卡改用与项目卡完全相同的外壳（圆角、阴影、圆形玻璃图标、标题、会话数、展开箭头），不再出现直角背景与不一致的投影；置顶卡无更多操作按钮。

## [1.18.2-beta.40] - 2026-08-23

### 移动端

- **修复应用内字号设置绕过物理缩放：** 字号设置 ≠100% 时，移动端会把 `--text-*` 以纯 rem 内联值写回，压过样式表的 `calc(N * var(--dpt))`，导致 Android 整体字号缩放完全失效。现在内联覆盖同样走 `calc(px * var(--dpt))`：用户字号百分比与 `--dpt` 物理系数相乘叠加，任何字号设置下 Android 都保持与 iOS 的密度对齐；桌面端不受影响。

## [1.18.2-beta.39] - 2026-08-23

### 移动端

- **安卓检查更新不再被赶去 GitHub：** 纯 web 的 beta 不再抬高 Android `minNativeBuild`。已装 APK 继续应用内 OTA。只有协议返回 `install_native_required` 且带了 `installUrl` 时才打开外链。

## [1.18.2-beta.38] - 2026-08-23

### 移动端

- **OTA 更新卡片能显示 changelog：** iOS 上报的剥离版号 `1.18.2` 不再把所有 `1.18.2-beta.*` 更新说明滤掉。卡片按当前 web 版本取笔记。

## [1.18.2-beta.37] - 2026-08-23

### 移动端

- **iOS 不再对同一版本反复弹出「有可用更新」：** 壳里已经是 `1.18.2-beta.36` 时，检查更新不会再显示 `36 → 36` 并无限转圈。Capgo 报 builtin 时会带上当前 web 版本，同版本不再当成可安装 OTA。

- **键盘收起后输入框更稳：** 收起键盘时先收起输入栏再失焦，并补一次确认，减少 WKWebView 把焦点抢回去的情况。

## [1.18.2-beta.36] - 2026-08-23

### 聊天

- **sorted 去重逻辑加固：** 正文显示与 Activity 去重改为共用同一处流式状态推导，避免两处判断各自为政、将来漂移后文字再次重复或消失。行为与 beta.35 一致。

## [1.18.2-beta.35] - 2026-08-23

### 聊天

- **sorted 流式正文不再重复显示：** 修复 beta.34 引入的回归——流式中的正文段落同时出现在正文区和 Activity 里。现在同一段文字任意时刻只渲染一处：流式期间留在正文区，步骤结束后整理进 Activity。

## [1.18.2-beta.34] - 2026-08-23

### 更新卡片

- **OTA 更新卡片显示更新日志：** 关于页这次有可用更新时，卡片会展示自当前版本以来的 changelog（更新内容），不再是空白。

- **版本号独立成行、文字更小巧：** 版本号从标题同行拆到独立一行，字号缩小、等宽字体、弱化当前版本、突出最新版本，整体更精致。

- **changelog 排版优化：** 版本徽章 / 日期 / 行高 / 间距收紧，移动端滚动高度随视口自适应，长更新日志不再挤压卡片。下载进度条同步细化为轻量面板。

### 移动端

- **In-app OTA 可更新通知：** 应用内有可安装的 web bundle OTA 时，启动后弹出 toast 提示，可直接打开更新卡片下载。

- **设计点小数字号兼容：** postcss 字体缩放现在支持前导零小数（如 `.8125rem`），修复小字号在部分机型显示异常。

### 服务端

- **移动端 OTA check 返回 releaseNotes：** `/v1/mobile/update/check` 在应用更新时附带 changelog，供更新卡片展示。

## [1.18.2-beta.33] - 2026-08-23

### 会话列表

- **会话行按压只在按住时出现：** 去掉当前会话的持久选中底；松手或回到首页后不再像卡住一样亮着。「更多 / 更少」同样有按压背景。

### 聊天

- **队列芯片 Sending 覆盖遗留队列：** 本地队列在发送中也保持 Sending，超时后可重试，不再提前露出操作。
- **sorted 流式正文不再中途消失：** 同一轮里后续工具调用不会把已经流出的段落收回 Activity。
- **移动端消息头不再显示思考强度：** 该标记不在跨设备快照里，避免换机后徽章消失。

### 移动端

- **Android 设计点缩放暂封顶 0.9：** 作为可见性实验，避免部分机型字号偏大。

## [1.18.2-beta.32] - 2026-08-22

### 移动端

- **OTA 只升不降，原生发布同步热更包：** 刚装完的新壳不会再被旧 web bundle 打回去。`v*` 发布会同时写入同版本 OTA，解析器拒绝更旧的 `releaseVersion`。「关于」页区分原生安装与应用内一键更新，用户确认后重载，不再静默套用、也不再打开 zip。

### 聊天

- **空用户气泡不再闪一下：** 只有空白文本或还没带上地址的附件时，不再画出空气泡。
- **队列芯片发送中仍留在原位：** 点发送后显示 Sending，失败或超时再恢复操作，不再整颗芯片先消失。

### 会话列表

- **会话行按压态离开手指就清掉：** 分页行也有按压反馈；手指滑出或跳页后不再卡住高亮。

## [1.18.2-beta.31] - 2026-08-22

### 会话列表

- **折叠列表仍露出忙碌/当前会话：** Show more 边界外的 busy/retry 会话，以及当前正在查看的会话，会继续显示在侧栏与移动端会话列表中，避免跑丢活动任务。
- **置顶会话上提到项目首页顶部：** 移动端项目页把跨项目置顶会话收成独立分组，不再嵌在各项目卡片里。

### 移动端

- **Changes 文件行按压缩放更轻：** soft press 按面板宽度计算，最大约 1.5%，密集文件列表不再明显“缩一下”。
- **会话行选中/按压态改用 CSS 状态位：** active 与 pressed 背景由样式表统一处理，避免行高与触控反馈打架。
- **流式回复时展开输入框更顺：** 流式输出期间复用同草稿的 stage 高度缓存，减少强制布局带来的卡顿。

### Git / 配置

- **创建或删除 worktree 后立即失效列表缓存：** 避免并发刷新把旧 worktree 列表写回。
- **Provider 目录目录级隔离，空目录不再当成功快照：** 不同项目不再串 Provider 缓存；空结果不写入 store / 持久化。

## [1.18.2-beta.30] - 2026-08-22

### 移动端

- **OTA 更新通道国内入口就绪：** `openchamber.xiaobe.top` 现通过边缘反向代理实时跟随权威更新源——渠道清单 60 秒边缘缓存、更新包内容寻址永久缓存，国内设备检查更新与下载包全程走 EdgeOne CDN，发布后无需任何手动同步。
- **字体按物理尺寸渲染（pt 基准）：** 移动端引入 design-pt 缩放管线，字号以物理点为单位换算，不同屏幕密度下视觉大小一致。

## [1.18.2-beta.29] - 2026-08-22

### 移动端

- **新增移动端 OTA 热更新能力（beta + stable 双通道）：** App 内的 Web 层（界面、样式、文案、前端逻辑）今后可通过 `mobile-beta/v*` 标签在几分钟内静默推送到真机——启动时后台下载、退至后台后自动生效、启动失败自动回滚，无需重新安装。原生层改动（插件、权限等）仍走 TestFlight / APK 整包发布，CI 会自动判定并拦截发错通道的发布。正式通道同样支持 OTA，默认 10% 灰度起步，可从 beta 一键提升。「关于」页现在同时显示 App 版本与 Web Bundle 版本。
- **菜单项补上按压反馈与触觉：** Base UI 菜单项（如项目页右上菜单）现在与按钮一致，具备按压缩放和轻触觉反馈。
- **修正「新建项目」菜单图标：** 从「添加文件夹」换为标准「文件夹」图标。

## [1.18.2-beta.28] - 2026-08-22

### 移动端

- **恢复 Android 与 iOS 的整页密度对齐，并修好键盘高度：** 再次钉死系统「显示大小」（`densityDpi`）让整体视觉回到 iOS 密度；键盘 inset 改为按 WebView `devicePixelRatio` 换算 CSS 像素，不再用 Activity 密度，避免输入框对不齐键盘。

## [1.18.2-beta.27] - 2026-08-22

### 变更

- **新客户端连旧服时，turn 文件 diff 不再盖「加载差异失败」：** 旧 Host 的 `/changes` 可能回 200 但只有文件列表、没有单文件 `{ diff }`。客户端现在把它当成缺 L3，回退到官方 `session.diff`；已经画出来的 diff 也不会再被错误条挡住。

## [1.18.2-beta.26] - 2026-08-22

### 移动端

- **撤回 Android 显示大小钉死，修复键盘把输入框顶偏：** beta.24 把 `densityDpi` 钉到出厂密度后，原生键盘 inset 与 WebView CSS 像素不再同一套密度，输入框上弹对不齐键盘。现在只钉系统「字体大小」（`fontScale=1` + `textZoom(100)`），显示大小仍跟随系统，键盘几何恢复。

## [1.18.2-beta.25] - 2026-08-22

### 聊天

- **修复 Android 键盘弹出时输入框被挡住一部分：** 键盘实测高度到达时，若本次弹起用的预估高度明显不足（密度钉死或缓存比例偏差），立即以 60ms 短校正补升到实测高度，不再整个键盘会话被遮挡；关闭动画同步从正确位置收回。

## [1.18.2-beta.24] - 2026-08-22

### 移动端

- **彻底修复 Android 整体偏大（字体+显示大小双缩放）：** Android 系统的「字体大小」与「显示大小」会在 WebView 里叠乘放大（最多约 2 倍），beta.23 只抵消了前者。现在原生层同时钉死 `fontScale` 与 `densityDpi`（出厂密度），CSS px 与 iOS pt 1:1 对齐，并在 onResume 幂等兜底 `textZoom(100)`；应用内字号设置不受影响。

## [1.18.2-beta.23] - 2026-08-22

### 移动端

- **修复 Android 整体字号偏大：** Capacitor Android WebView 将文字缩放固定为 100%，不再跟随系统「字体大小」整体放大，视觉密度与 iOS 对齐；应用内字号设置仍可正常调节。

### 聊天

- **当前选中模型固定出现在最近列表顶部：** 模型选择器在「最近」分区把当前会话模型置顶（已在收藏中则不重复），避免当前模型被挤出可视区域。

### 助理

- **历史会话回复在绑定切换后仍保留：** 助理切到新会话后，旧会话已完成的回复继续出现在历史时间线；后台补齐分页在收到历史会话事件时重新打开，不再把已有临时镜像整段清掉。

## [1.18.2-beta.22] - 2026-08-22

### 移动端

- **助理引导与列表全面优化：** 未启用状态改用完整横版主视觉和纵向分享步骤，开启入口与说明在窄屏上保持清晰；已有助理改为更宽松的信息卡片，头像与名称对齐，区分 emoji 与生成头像的填充方式，并展示对话模式和最多三行提示词摘要。
- **修复输入焦点切换后光标持续隐藏：** iOS 键盘已打开时在不同输入框间切换，不再重复进入仅应覆盖键盘升起阶段的 caret hold；非 composer 输入也会在键盘稳定后清理动画与光标遮罩状态。

## [1.18.2-beta.21] - 2026-08-22

### 移动端

- **修复「切换实例」二级页丢失设置样式：** 二级页补上 Settings workspace 令牌与 detail card 外壳，实例列表卡片恢复分组背景、圆角与间距。
- **首页「扫一扫」改为全局扫码能力：** 不再先进入实例管理页再自动扫码；取消/失败/成功后都留在首页，失败用 toast 提示；实例页内扫码按钮仍可手动使用。
- **助手未启用引导页：** 移动端助手页在实例未开启助手时展示引导插图与分享示例步骤，并提供一键进入设置开启入口。

## [1.18.2-beta.20] - 2026-08-22

### 聊天

- **移动端输入框展开不再出现中间高度：** 修复展开动画期间视口被写成「无 footer 高度」再跳到全高的两段式问题；现在展开同步提交即进入完整状态，动画前一次性测量终态高度，动画期间视口高度冻结，图标与高度一步到位。

### 移动端

- **Changes 预览点击文件直达定位：** 移动端回合 Changes 预览点击单个文件后，turn Diff 打开时自动展开并滚动到该文件（与桌面行为一致），选中文件头随导航固定。

## [1.18.2-beta.19] - 2026-08-22

### 移动端

- **修复首页菜单「切换实例 / 扫一扫」的导航路径：** 实例管理改为从首页推入的二级页（带标题栏与返回），返回即回首页、重复进入正常，不再把根 tab 切到设置页；扫一扫进入二级页后直接拉起配对扫码，并与设置页内的实例列表共用同一套连接与扫码状态机，设置内入口、深链与 iPad 路径保持不变。
- **「新建项目」弹层换成通用手势半浮层：** 支持拖拽手柄 72%/98% 双高度吸附与下拉关闭，默认展开；首页菜单、新建会话草稿的项目选择器等入口统一继承，桌面端 Dialog 形态不变。同时补充受控 `open` 契约测试，防止手势收起后闪动回归。

### 设置

- **移动端设置导航补充 Summary AI 入口：** beta.18 新增的总结模型设置页在移动端设置列表中可见。

## [1.18.2-beta.18] - 2026-08-22

### AI 总结

- **总结模型开放全部已登录供应商：** 会话标题 / commit 信息等小模型总结不再限于四大直连供应商——任何在 OpenCode 里完成登录的 provider（codebuddy、cursor、grok-build、deepseek 等插件供应商）都可直接在设置 → Summary AI 中选用。非直连供应商的总结请求改经 OpenCode 运行时的一次性临时会话调度（临时目录 + 隐藏无工具 agent，认证、token 刷新与端点改写全部由 provider 运行时自行处理），用完即删；四大供应商与自定义 baseURL 模式保持原直连快速通道不变。
- **默认总结模型按小模型优先 + 价格排序：** 未显式指定总结模型时，默认解析改为关键词分档（gemini-flash / gpt-nano / claude-haiku 家族最高档，flash / mini / nano / haiku / lite 等次档），档内优先单价更低的新模型，便宜的小模型（如 DeepSeek 系列）会自然胜出。
- **总结用临时会话全程不可见：** 临时会话携带系统标记并即刻归档，不进入任何会话列表、项目首页、切换器、未读角标与 SQLite 索引，也不触发桌面通知、toast 与移动推送；会话标题自动生成同样跳过这些系统会话。

## [1.18.2-beta.17] - 2026-08-22

### 移动端

- **首页「项目」加号改为快捷菜单：** 点击加号后图标 45° 旋转为叉号并弹出下拉菜单，聚合四个入口——新建对话（跳转新会话草稿页）、新建项目（打开添加项目半浮层）、扫一扫（进入实例管理页并直接启动配对二维码扫描）、切换实例（跳转设置内实例管理页），每项带图标。扫一扫与切换实例仅在 Capacitor 环境显示（Web 手机壳只显示前两项）；扫码与实例管理页共用同一套扫描状态机，菜单文案覆盖全部语言。

## [1.18.2-beta.16] - 2026-08-22

### 会话

- **会话标题自动刷新收敛为稀疏策略：** 自动生成标题只在新会话首次进入空闲、以及 fork 会话首次发送新消息后触发；同一会话后续回合的空闲不再自动重写标题，避免长会话标题随最后一次收尾发言漂移（如被改成「commit and push」）。手动重命名、智能总结与强制刷新不受影响，用户改过的标题依旧永不被覆盖；该行为与 beta.15 更新的设置页描述一致，并补齐了刷新触发契约的完整服务端测试。

## [1.18.2-beta.15] - 2026-08-22

### 会话

- **置顶改为服务端全局同步：** 置顶状态从各设备浏览器本地存储迁移到 OpenChamber server（session-index SQLite `pinned_at`，目录重建时随行保留），PC 与移动端连接同一 server 后置顶集合实时互通（复用 session-index revision + SSE 变更推送，其他设备自动重取快照）。置顶/取消走乐观更新，失败回滚并提示。排序保持「置顶优先 + 创建时间倒序」，会话归档即自动取消置顶；本地置顶 store 与失效 ID 剪枝逻辑退役，旧本地数据不迁移、以服务端为准。external OpenCode 直连、VS Code 及连接非 OpenChamber server 的移动端不提供置顶（入口静默无效）。

## [1.18.2-beta.14] - 2026-08-22

### 会话

- **Changes 列表加载彻底移除异步兜底：** 回合预览与 Changes 面板完全依赖消息线上随带的轻量文件列表同步渲染，不再保留「列表缺失时异步拉取文件摘要」的兼容分支（新 Host 投影与旧 Host 经客户端净化后列表必在消息上，兜底无真实场景）。会话内任何与变更列表相关的请求不复存在；唯一的网络请求仍是展开具体文件时的单文件 patch 按需加载，内部查询层同步精简为仅单文件查询。

## [1.18.2-beta.13] - 2026-08-22

### 会话

- **Changes 文件列表恢复随消息同步携带：** 消息线上的变更摘要重新携带轻量文件列表（文件名 / 状态 / 增删行数，463 文件约 46KB），打开 Changes 或查看回合预览即时渲染、零额外请求与等待；此前 beta.7 的纯计数方案把文件列表也变成了按需异步，引入了不必要的转圈。patch 正文仍绝不随消息传输——展开具体文件时才拉取该文件的单文件 patch（原本 14MB 级传输的元凶始终是 patch 正文，列表本身不是问题）。列表接口仅保留为旧数据 / 异常标记的兜底，Web、桌面、VS Code 与 relay 链路一致。

## [1.18.2-beta.12] - 2026-08-22

### 聊天

- **移动端输入框展开后图标秒显：** 底部模型 / 附件 / 目标等控件原先在展开时才挂载，撞上键盘弹出要 ~500ms 才出现；现在手指按下胶囊即预热挂载完整工具栏（隐藏且不可聚焦），展开只是显示切换，收起后驻留复用，二次展开零成本；入场动画去掉延迟缩短为 120ms。

## [1.18.2-beta.11] - 2026-08-22

### 聊天

- **回合 Changes 预览恢复文件列表：** L1 仍只在消息线上保留变更数量；预览挂载时按需拉 L2 文件摘要，折叠态重新显示前 5 个文件名与 ± 行数，超出部分以「+N 个文件」进入完整 Diff。点击单文件打开该文件 turn diff，点击标题打开整回合 Diff；与 DiffView 共用查询缓存。
- **移动端模型选择器供应商字号再调小：** 收藏 / 最近分区的供应商标注改为 `10px`、更弱对比，进一步降低对模型名的干扰。
- **输入区非图片附件不再重复预览条：** composer 与草稿附件列表只保留图片缩略图；非图片附件走正文内联引用芯片，避免与芯片双份展示。

## [1.18.2-beta.10] - 2026-08-22

### 聊天

- **移动端模型选择器收藏 / 最近分区显示供应商：** 模型名上方增加供应商小字，同名模型（如不同供应商下的 glm-4.7）可直接区分；按供应商分组的列表不加，避免与分区头重复。

## [1.18.2-beta.9] - 2026-08-22

### 供应商

- **修正 OpenCode 与 DeepSeek 供应商图标：** OpenCode 改用官网 favicon 的方形 O 标（单色化并保留官方双色调层次，随主题黑白切换），DeepSeek 品牌标由官方蓝改为黑白单色，与其它供应商图标一致；`opencode-go` 别名供应商同样命中新图标。

## [1.18.2-beta.8] - 2026-08-22

### 聊天

- **移动端输入框高度自适应修复：** 高度计算改为先裁剪 overflow 再测量内容高度，展开 / 收起胶囊后残留的滚动视口不再污染测量；移动端 composer 裁剪壳不再出现双滚动条，提及或换行时输入卡片恢复自然增高而不是内部滚动。

### 消息队列

- **中止后的乐观行协调增强：** 服务端派发为队列消息分配了与本地乐观行不同的消息 ID 时，乐观行改为重绑定到权威 ID 继续跟踪，不再误判回滚；权威行判定改为基于真实（非乐观）消息 parts，纯乐观行不再被当作已确认。

### 诊断

- **transcript 诊断可定位重复 / 乐观行：** 诊断快照新增用户消息文本（上限 400 字符，疑似凭据内容脱敏；助手 / 系统正文依旧不采集），SSE part.delta 纯噪声批次不再记录。

### Git

- **移除旧 Host 渲染保护阈值：** beta.7 引入的 5000 文件客户端兜底删除，超大变更集降级回到只认服务端 `oversized` 声明的纯契约；新 Host 行为不变。

## [1.18.2-beta.7] - 2026-08-22

### 会话

- **大会话 Changes 改为分层按需加载：** 消息首包、实时事件与精确消息拉取不再携带回合变更的文件列表与 patch 正文，只保留变更数量标记；打开 Changes 时才拉取文件摘要列表，展开具体文件时才取该文件的单文件 patch。数百文件、约 14MB patch 的大会话首包体积恢复正常，Web、桌面、VS Code 与 relay 链路一致生效；连接旧版 Host 时自动回退官方 diff 接口，行为不回退。
- **聊天回合变更预览改为计数入口：** 回合底部只显示变更文件数，点击后在 Diff 面板按需加载文件列表与逐文件 patch，不再随消息流预取整回合 diff。

### Git

- **超大变更集降级兼容旧 Host：** 连接尚未下发 `oversized` 标记的旧版 Host 时，Web 运行时对异常庞大的未标记变更集（超过 5000 文件）也提供降级渲染入口，作为渲染保护的最后防线；新版 Host 的服务端声明始终优先，VS Code 本地 git 行为不变。

## [1.18.2-beta.6] - 2026-08-22

### 聊天

- **修复收起态输入框上方的空白：** beta.5 的展开动画视口在收起后仍保留展开态高度占位，胶囊输入框与会话列表之间出现一条空白；现在收起闲置时视口回落为胶囊自然高度，展开 / 收起动画本身不变（仍是纯 transform，不牵动列表布局）。

## [1.18.2-beta.5] - 2026-08-22

### 聊天

- **修复推理完成后 TPS 不显示：** settle 阶段携带 `time.completed` 的 `message.updated` 事件在实时链路（移动端 relay / WS）丢失时，回合时长与生成速度（tok/s）不再永久缺失。新增缺口自愈：检测到尾部助手消息带终态 finish 却缺完成时间戳时，通过权威 reconcile 刷新补齐——冷却窗口内的 materialization 入队与 materialize 完成后各复查一次，无需重启应用。
- **移动端胶囊输入框动画重构：** 展开 / 收起改为固定高度视口遮罩 + 纯 transform 动效，同一 textarea/DOM 跨两种形态保持连续，动画帧不再牵动会话列表布局。
- **附件选择后焦点回收：** 从文件 / 图片选择器返回后自动重新聚焦输入框并将光标置于末尾，不再停留在失焦状态。

## [1.18.2-beta.4] - 2026-08-21

### 配置同步

- **大配置传输不再放大内存：** relay 同步的 tar 包在桌面进程与界面之间改为二进制直传，替换原先逐字节展开的 JSON 数组；接近上限的大配置同步不再出现数倍内存峰值。
- **向导勾选随白名单自适应：** 同步范围勾选框的默认值改为由服务端白名单形状驱动，后续新增配置组 / 目录时不再出现默认勾选错位；白名单读取失败时明确禁用并提示，而非静默猜长度。
- **内部清理：** relay 同步模块合并重复的计划构建逻辑，移除无消费者的服务端定义与未启用的流式类型预留；行为与错误码不变。

## [1.18.2-beta.3] - 2026-08-21

### 配置同步

- **同步方向可选：** 同步向导先选方向——「本地 → 远端」或「远端 → 本地」；每次切换方向都会丢弃旧差异并重新计算，确认前不产生任何写入。拉取同样先展示远端清单与覆盖预览，再应用。
- **同步范围可勾选：** 向导按配置文件组（互斥组只保留赢家）、完整目录、Agent skills（`~/.agents`）与凭据逐项勾选，选择贯穿预览、删除计划与应用。
- **支持更多目标：** 除托管 SSH 实例外，可直连的 OpenChamber 实例与已配对的 relay 对端也能同步；直连与 relay 走服务端同步协议，relay 经端到端加密隧道并固定对端身份（`serverId` 变化即拒绝，不回落）。
- **凭据传输需要显式授权：** 能访问目标不再意味着能传 token。`auth.json` 默认跳过；必须在实例 / 主机设置等信任渠道授予「凭据同步」授权后才可勾选，预览与执行双层强制，授权可随时撤销。
- **分代备份与运行记录：** 每次同步按运行分代备份（保留近 5 代，失败保留现场），覆盖前远端 / 本地各自留档；每个目标保留最近 20 次同步结果，实例页可查看。
- **配置写入更稳：** 桌面端 settings 读写统一走串行链（含进程内 web server），并发更新不再互相覆盖。

## [1.18.2-beta.2] - 2026-08-21

### Git

- **超大变更集降级改为服务端驱动：** `/api/git/status` 响应新增 `oversized` 标记，服务端变更文件数超过其阈值（当前 2000）时置位并省略 `diffStats`（跳过两轮全树 `git diff --numstat` 与新文件行数统计，避免阻塞服务事件循环数秒）。客户端降级渲染只认该标记，不再持有本地阈值副本；服务端调整阈值时客户端零改动自动跟随。常规项目响应不变（`oversized: false`）。VS Code 运行时不计算 diffStats，不设置该标记。

## [1.18.2-beta.1] - 2026-08-21

### Git

- **超大变更集降级加载：** 变更文件超过 2000 个时，Git 面板不再自动渲染完整列表（全量排序、目录树与 diff 预取会阻塞界面数秒），改为显示已暂存 / 未暂存计数与「加载更改」入口，点击后再渲染；变更集回落到阈值以下时自动恢复正常。桌面端与移动端一致，聊天输入框的变更检测改为短路扫描，超大仓库下不再卡顿。

## [1.18.1] - 2026-08-21

### SSH 远程实例

- **全新远程机自动初始化：** 托管 SSH 会话现在会在命令级别发现 Node.js 22+、补全 bun / npm 全局 bin 路径，并自动安装与桌面端固定 OpenCode CLI 版本一致的 OpenCode。
- **原生数据库绑定自动修复：** OpenChamber 检测到 `better-sqlite3` 与选定 Node ABI 不匹配时会重建绑定，覆盖新开发机默认 Node / 编译工具链不兼容导致的启动失败。

## [1.18.0] - 2026-08-21

### 移动端

- **Android 回退扫码取消恢复：** bundled CameraX 扫码点击取消时优先恢复 WebView 页面可见性；取消按钮与原生扫码清理可处理 DOM 竞态，避免透明相机页停留为白屏。
- **全屏面板统一到手势窗口栈：** 文件 / 变更 / MCP / 设置 / 更新面板迁移到统一的可调窗口组件，手势下滑关闭后不再闪回，安全区布局每次打开重新计算。

### SSH 远程实例

- **配置同步到远程：** 远程实例页新增「同步配置」，把本地 OpenCode 配置（`~/.config/opencode`）、Agent skills（`~/.agents`）与 provider 凭据（`auth.json`）镜像到远程实例；三步流程（扫描本地 → 与远程对比 → 审阅变更），覆盖前在远程自动备份，symlink 目录按真实文件复制，会话数据与缓存不同步。
- **端口转发管理 UI：** 远程实例设置新增「端口转发」分组，可添加本地 / 远程两类转发、逐条启用开关、指定首选本地端口；SSH 重连自动重建。
- **Relay 广播仅限桌面：** dev / web / CLI 服务器不再宣称「Anywhere」可用，也不再打开 host-control socket 或探测 relay；修复开发服务器继承桌面环境变量后误连 relay 的问题。
- **配置同步文案统一：** 简体中文与繁体中文界面统一使用 Agent 名称。
- **托管 SSH 远程始终带 UI 密码：** 未配置密码时桌面端会发一次性内存密码，经隧道签发 SSH host token；无密码不再静默失败。
- **无 token 的就绪 SSH 主机可按需签发：** 手机 / 另一台电脑换 token 时，桌面可现场 mint 并写回，不再因 tokenless 返回 404。
- **SSH 配对失败不再降级成本机：** 扫码或导入链接拿不到 SSH token 时直接报错，不再误存成桌面连接。
- **设置页去掉 SSH 镜像重复行：** 本地 SSH 实例已在 SSH 列表里，链接列表不再再画一条。

### 聊天

- **/compact 不再占用输入框：** 压缩作为后台任务运行，发送后输入框立即空闲，可继续排队后续消息。
- **压缩后上下文用量不再虚高：** `/compact` 之后 token 环不再沿用压缩前的旧读数，直到新的助手消息发布用量。
- **Turn Changes 支持项目外文件：** 点击变更列表里位于项目外的文件改为打开文件预览（原先展示空的 turn-diff 面板），面板顶部附提示说明。
- **消息头思考强度更安静：** 非默认思考深度（如 Xhigh）比模型名小一号，并与模型名、Agent 徽章基线对齐。

### 服务器

- **消息队列不再被历史 scope 卡住：** 空的旧 scope 按 LRU 自动清理，不再触发 scope 上限校验失败。

### 诊断

- **子 Agent 任务行可导出诊断：** About → 客户端诊断开启后，任务行会记录 `feat: task`（子会话 id 是否到位、tool/status、是否仍在 loading、点击是打开/排队/能力关闭）。不含标题、prompt、agent 名；开关关闭时不写。用于定位「上面能点、下面点不动、底下转圈」。

### 会话列表

- **三处列表排序对齐：** 移动端项目首页、会话 sheet、正文半浮层与 PC 侧边栏统一按活动时间（`activityUpdatedAt → updated → created`）排序；半浮层 worktree 组顺序接入手动排序。
- **移动端菜单同构：** 项目 / 会话 / worktree 菜单抽成共享模型；首页接通「编辑项目」，半浮层补齐删除会话、编辑 / 关闭项目。
- **半浮层折叠可记住：** worktree 组展开状态持久化到实例隔离 store，关闭面板后再开仍保持。

### 模型与 Agent 目录

- **空目录不再永久卡住：** Provider / Agent 空列表不再被当成永久新鲜；打开模型或 Agent 选择器会后台强制刷新两边目录。
- **选择器误点修复：** 搜索框唤起键盘后，残留 click 不再关掉 sheet 或误选模型；遮罩点击同样要求 pointerdown 与 click 落在同一控件。

### 聊天与通知

- **桌面通知打开会话：** 若当前不在本机 runtime，先切回本机再打开目标会话。
- **子会话只读底栏不再闪：** 子 Agent 行从列表短暂消失时，仍保留「返回父会话」与 agent / model 信息。
- **子任务完成通知默认关闭：** 新安装默认不再为子任务完成弹通知。

## [1.17.1-beta.18] - 2026-08-21

### 移动端

- **Android 回退扫码取消恢复：** bundled CameraX 扫码点击取消时优先恢复 WebView 页面可见性；取消按钮与原生扫码清理可处理 DOM 竞态，避免透明相机页停留为白屏。

### SSH 远程实例

- **配置同步文案统一：** 简体中文与繁体中文界面统一使用 Agent 名称。

## [1.17.1-beta.17] - 2026-08-21

### SSH 远程实例

- **配置同步到远程：** 远程实例页新增「同步配置」，把本地 OpenCode 配置（`~/.config/opencode`）、Agent skills（`~/.agents`）与 provider 凭据（`auth.json`）镜像到远程实例；三步流程（扫描本地 → 与远程对比 → 审阅变更），覆盖前在远程自动备份，symlink 目录按真实文件复制，会话数据与缓存不同步。
- **端口转发管理 UI：** 远程实例设置新增「端口转发」分组，可添加本地 / 远程两类转发、逐条启用开关、指定首选本地端口；SSH 重连自动重建。
- **Relay 广播仅限桌面：** dev / web / CLI 服务器不再宣称「Anywhere」可用，也不再打开 host-control socket 或探测 relay；修复开发服务器继承桌面环境变量后误连 relay 的问题。

### 聊天

- **/compact 不再占用输入框：** 压缩作为后台任务运行，发送后输入框立即空闲，可继续排队后续消息。
- **压缩后上下文用量不再虚高：** `/compact` 之后 token 环不再沿用压缩前的旧读数，直到新的助手消息发布用量。
- **Turn Changes 支持项目外文件：** 点击变更列表里位于项目外的文件改为打开文件预览（原先展示空的 turn-diff 面板），面板顶部附提示说明。

### 移动端

- **全屏面板统一到手势窗口栈：** 文件 / 变更 / MCP / 设置 / 更新面板迁移到统一的可调窗口组件，手势下滑关闭后不再闪回，安全区布局每次打开重新计算。

### 服务器

- **消息队列不再被历史 scope 卡住：** 空的旧 scope 按 LRU 自动清理，不再触发 scope 上限校验失败。

## [1.17.1-beta.16] - 2026-08-21

### 聊天

- **消息头思考强度更安静：** 非默认思考深度（如 Xhigh）比模型名小一号，并与模型名、Agent 徽章基线对齐。

## [1.17.1-beta.15] - 2026-08-21

### 诊断

- **子 Agent 任务行可导出诊断：** About → 客户端诊断开启后，任务行会记录 `feat: task`（子会话 id 是否到位、tool/status、是否仍在 loading、点击是打开/排队/能力关闭）。不含标题、prompt、agent 名；开关关闭时不写。用于定位「上面能点、下面点不动、底下转圈」。

### SSH 远程实例

- **托管 SSH 远程始终带 UI 密码：** 未配置密码时桌面端会发一次性内存密码，经隧道签发 SSH host token；无密码不再静默失败。
- **无 token 的就绪 SSH 主机可按需签发：** 手机 / 另一台电脑换 token 时，桌面可现场 mint 并写回，不再因 tokenless 返回 404。
- **SSH 配对失败不再降级成本机：** 扫码或导入链接拿不到 SSH token 时直接报错，不再误存成桌面连接。
- **设置页去掉 SSH 镜像重复行：** 本地 SSH 实例已在 SSH 列表里，链接列表不再再画一条。

## [1.17.1-beta.14] - 2026-08-21

### 会话列表

- **三处列表排序对齐：** 移动端项目首页、会话 sheet、正文半浮层与 PC 侧边栏统一按活动时间（`activityUpdatedAt → updated → created`）排序；半浮层 worktree 组顺序接入手动排序。
- **移动端菜单同构：** 项目 / 会话 / worktree 菜单抽成共享模型；首页接通「编辑项目」，半浮层补齐删除会话、编辑 / 关闭项目。
- **半浮层折叠可记住：** worktree 组展开状态持久化到实例隔离 store，关闭面板后再开仍保持。

### 模型与 Agent 目录

- **空目录不再永久卡住：** Provider / Agent 空列表不再被当成永久新鲜；打开模型或 Agent 选择器会后台强制刷新两边目录。
- **选择器误点修复：** 搜索框唤起键盘后，残留 click 不再关掉 sheet 或误选模型；遮罩点击同样要求 pointerdown 与 click 落在同一控件。

### 聊天与通知

- **桌面通知打开会话：** 若当前不在本机 runtime，先切回本机再打开目标会话。
- **子会话只读底栏不再闪：** 子 Agent 行从列表短暂消失时，仍保留「返回父会话」与 agent / model 信息。
- **子任务完成通知默认关闭：** 新安装默认不再为子任务完成弹通知。

## [1.17.1-beta.13] - 2026-08-21

- **beta.12 完整重发：** beta.12 的 npm 包已发布，但桌面/移动构建产物因发布过程中 tag 修正未产出；本版本重新执行完整发布，内容与 beta.12 相同（详见下方 beta.12 变更记录）。

## [1.17.1-beta.12] - 2026-08-21

### 远程实例（SSH + Private Relay 打通）

- **手机经 Relay 访问 SSH 远程实例：** Relay 隧道分发器支持按请求头 `x-openchamber-target-port` 在已就绪的 SSH 会话端口间路由（HTTP 与 WebSocket），未命中路由表返回 503 不回退桌面数据；读取/缓存按目标端口隔离。
- **PC 端为 SSH 实例生成配对二维码：** 「添加设备」弹窗新增目标实例 tab（本机 + 已连接 SSH 实例），SSH 实例行新增「手机连接」按钮直接预选；多台手机可各自配对同一 SSH 实例（多对多）。
- **手机扫码直达 SSH 实例：** 扫码后存为一条普通连接（带 SSH 徽章，副标题注明「经桌面中继 · 需桌面在线」），连接时自动现查路由端口，SSH 重连换端口无需重新配对；SSH 不可达时降级存为桌面连接并提示。
- **另一台电脑导入 SSH 连接：** 桌面端「导入连接链接」支持带 SSH 目标的配对链接，存为带 `sshTarget` 的 relay host；启动恢复与切换同样走目标端口路由。
- **凭据链修复：** SSH 目标连接统一携带 `desktopClientToken`（现查端口用桌面凭据、业务请求用 SSH 实例凭据），修复此前现查端口会被 401 拒绝的问题。
- **token 下发绑定配对会话：** `POST /api/openchamber/ssh-host-token` 支持 `pairingId` 校验（仅已兑换且目标匹配的配对可换取 token），无绑定的旧调用放行并标记弃用。
- **LAN 直连转发原语：** SSH 实例支持 `0.0.0.0` 固定端口转发（`lanForward` 配置 + `desktop_ssh_ensure_lan_forward`），SSH 重连自动重建（UI 开关与二维码 LAN 候选后续版本接入）。

### SSH 连接可靠性

- **scp 风格地址支持：** `ssh root@host:36000` 形式自动拆分为 `-p 36000`；与显式 `-p` 冲突时报错，IPv6 裸地址不受影响；`-p` 写在目标之后（`ssh host -p 22`）也被接受。
- **远程安装幂等：** npm 全局安装追加 `--force`，修复残留 bin 链接导致的 EEXIST 安装失败（CLI `openchamber update` 同步修复）。
- **SSH 失败可诊断：** ControlMaster 提前退出时错误信息附带 stderr 尾部，不再只有一句 "exited before ready"。

## [1.17.1] - 2026-08-20

### 性能与可靠性

- **长会话打开不再卡死：** 冷启动时不再对已完整缓存的消息逐条后台复核，已完结且完整的片段直接信任本地缓存，仅真正缺失（精简摘要）或仍在流式中的消息才补全；此前数百条工具/推理片段的长会话会在打开瞬间并发拉取 500+ 条单消息请求，主线程饱和数分钟。
- **翻旧历史不再二次风暴：** 向上分页加载更早历史时，折叠且不可见的消息组不再后台自动补全；展开某个活动组时才按需拉取（单组内并发受限）。
- **补全请求全局限流：** 所有单消息精确补全（后台种子、展开活动组、编辑回流）共用同一调度器——并发不超过 4、同目标去重合并、用户展开操作优先于后台任务。
- **多会话流式卡顿修复（SSE 批量合并）：** 同一刷新帧内同一会话的多个 transcript SSE 事件只做一次全量重建与一次订阅通知；批内事件按顺序应用、保留中间快照，同帧内冗余事件折叠，多会话并发流式时主线程不再被打满。
- **助手 TPS / token 计数不再丢失：** 已累计的正向计数不会被流式期间落地的全零快照回退，直到下次全量权威刷新。
- **iOS 代码块空白修复：** iOS WebKit 隐藏 Markdown 代码行号栏，避免空行测量异常把代码块撑出大段空白；Android 保留行号。
- **代码行号测量加固：** Shiki 空行不再参与相邻行坐标差测量，避免退化布局坐标扩大行号高度。

### 移动端

- **Question 输入不被键盘挡住：** 自定义回答聚焦后聊天区给键盘留出滚动空间，输入框滚到键盘上方；底部 composer 不会跟着抬起。
- **输入框圆角修复：** 折叠/展开态统一同一圆角值，不再在 9999px 之间插值，消除 iOS WKWebView 切换时的脏角。
- **Subagent 变更文件可查看：** iPhone / iPad 的 turn 差异面板按所属子会话加载 diff。
- **Android 活动头滚动条修复：** Activity 标题行与 LatticeOrb 改用 `overflow-clip`，不再露出竖向滚动条。

### 消息与附件

- **程序化替换不再遗留失联附件：** 粘贴文本压缩、图片引用插入、文件路径提及等路径与手输一致，检测引用被替换掉的附件并自动移除。
- **主输入框 variant 记忆：** 历史消息没带 variant 时回退到会话记忆，换模型时保留当前/已记住的 variant。
- **后台子 Agent 完成通知：** 父会话里的 `<subagent>` 通知渲染为可点击卡片；后台任务在子会话 running 时保持忙碌态，idle 后自动收敛。
- **Subagent 变更文件可查看：** 子会话面板点击变更文件时用该子会话的 session/directory 加载 turn 差异，不再误用父会话。
- **工具 loading 点阵对齐：** 槽宽保持桌面 14px / 移动 16px，与 book / search 图标同一列。

### 状态呈现

- **状态行动画升级（M3 点阵）：** 运行状态的动态文案改为 aicss.dev Orbs M3「Unfolding」八点旋转点阵动画（`MorphOrb`），动态文案为单一 shimmer 动画。
- **状态行动态计时（多端一致）：** 状态行显示本轮已进行时长（如 `1m20s`），web / 桌面 / VS Code / 移动端消费同一事件流；运行中的活动头不再显示实时计时，完成后的活动头仍显示权威总时长。
- **状态行与工具行文字对齐：** 状态行与 abort 状态改用与 tool-row 相同的固定图标槽与响应式间距。

### 平台与分发

- **npm 包改到 `@openchambery`：** `@openchambery/web` 与 `@openchambery/relay-server` 随 GitHub Release 发布；安装脚本、CLI 更新和 SSH 远程预装都改用新包名。
- **移除 Cloudflare/ngrok 公网隧道：** 服务端 provider、CLI `tunnel` 命令、设置页 Tunnel 面板与文档站整套移除；远程访问统一收敛到配对链接、LAN 直连与 Private Relay，旧 `--tunnel` 标志改为报错并提示迁移。
- **远程实例设置合并：** 「其他 OpenChamber 服务器」并入「远程实例」，添加方式收敛为「导入连接」与「添加 SSH」两种，以「链接 / SSH」徽章区分来源。

### 其他

- **设置 Agent 模式芯片：** 桌面「主 Agent / 子 Agent / 全部」保持一行，不再折行。

## [1.17.1-beta.11] - 2026-08-20

- **Android 活动头滚动条修复：** Activity 标题行与 LatticeOrb 改用 `overflow-clip`，避免 mobile.css 把 `overflow-hidden` 改写成可滚动区域后在 Android 上露出竖向滚动条。

## [1.17.1-beta.10] - 2026-08-20

- **状态行动画升级（M3 点阵）：** 会话运行状态的动态文案改为 aicss.dev Orbs M3「Unfolding」八点旋转点阵动画（`MorphOrb`），按 28px stage 缩放到桌面 14 / 移动 12，几何填满约 86% 组件盒；动态文案为单一 shimmer 动画，不再叠加独立闪烁省略号。
- **状态行动态计时（多端一致）：** 状态行显示本轮已进行时长（如 `1m20s`），计时起点取服务端下发的最新 user message `time.created`，web / 桌面 / VS Code / 移动端消费同一事件流，显示一致；时长复用 goal 格式化（`1m20s` 无空格样式）。运行中可折叠活动头不再显示实时计时，避免与状态行双计时不一致；完成后的活动头仍显示权威总时长。
- **状态行与工具行文字对齐：** 状态行与 abort 状态改用与 tool-row / ProgressiveGroup 相同的固定图标槽（桌面 14px / 移动 16px）与响应式间距，文字起始轴与消息内活动行对齐。

## [1.17.1-beta.9] - 2026-08-20

- **多会话流式卡顿修复（SSE 批量合并）：** 同一刷新帧内同一会话的多个 transcript SSE 事件（`message.part.updated` / `message.updated` 等）现在只做一次全量 flatten/rebuild/freeze 与一次订阅通知，此前每个事件各付一次整棵 transcript 重建成本，多会话并发流式时（约 11 事件/秒 × 6 会话）主线程被打满导致界面死卡；批内事件按顺序应用、保留中间快照与去重语义，不违反 part.updated 保序契约；同帧内 payload 相同的冗余事件折叠后不再触发重建。

- **移除 Cloudflare/ngrok 公网隧道：** 服务端 provider、CLI `tunnel` 命令、设置页 Tunnel 面板与文档站整套移除；远程访问统一收敛到配对链接、LAN 直连与 Private Relay，旧 `--tunnel` 标志改为报错并提示迁移；Relay 与 SSH 端口转发不受影响。
- **远程实例设置合并：** 设置里的「其他 OpenChamber 服务器」并入「远程实例」，添加方式收敛为「导入连接」与「添加 SSH」两种，列表混排并以「链接 / SSH」徽章区分来源；旧手动添加的服务器不再展示（数据保留，不删除），Docker 镜像与安全文档同步去掉 cloudflared。

## [1.17.1-beta.7] - 2026-08-20

- **npm 包改到 `@openchambery`：** `@openchambery/web` 与 `@openchambery/relay-server` 随 GitHub Release 发布；安装脚本、CLI 更新和 SSH 远程预装都改用新包名。

## [1.17.1-beta.6] - 2026-08-20

- **程序化替换不再遗留失联附件：** 粘贴文本压缩、图片引用插入、文件路径提及等程序化替换选区的路径，现在与手输一样会检测引用被替换掉的附件并自动移除；失联判定统一收敛到附件引用模块，附件组件同步简化。
- **iOS 输入框圆角修复：** 折叠/展开态统一同一圆角值，不再在 9999px 之间插值，消除 iOS WKWebView 上切换时的脏角。

## [1.17.1-beta.5] - 2026-08-20

- **移动端 Question 输入不再被键盘挡住：** 自定义回答聚焦后，聊天区给键盘留出滚动空间，输入框（空间足够时连同底部操作）滚到键盘上方；底部 composer 不会跟着抬起。
- **主输入框 variant 记忆：** 历史消息没带 variant 时回退到会话记忆，而不是当成显式默认；换模型时保留当前/已记住的 variant，避免被写成空。

## [1.17.1-beta.4] - 2026-08-20

- **iOS 代码块空白修复：** iOS WebKit 隐藏 Markdown 代码行号栏，避免空行测量异常将代码块撑出大段空白；Android 保留行号显示。
- **代码行号测量加固：** Shiki 空行不再参与相邻行坐标差测量，避免退化布局坐标扩大行号高度。

## [1.17.1-beta.3] - 2026-08-20

- **长会话打开不再卡死：** 冷启动时不再对已完整缓存的消息逐条后台复核——此前一个含数百条工具/推理片段的长会话会在打开瞬间并发拉取 500+ 条单消息请求，每个响应都整棵重建转录数据，主线程饱和数分钟、列表无法挂载、滚动与输入全部冻结。现在已完结且完整的片段直接信任本地缓存，仅真正缺失（精简摘要）或仍在流式中的消息才补全。
- **翻旧历史不再二次风暴：** 向上分页加载更早历史时，折叠且不可见的消息组不再后台自动补全；展开某个活动组时才按需拉取（单组内并发受限），不再出现翻页即几百个请求、卡 20-30 秒的情况。
- **补全请求全局限流：** 所有单消息精确补全（后台种子、展开活动组、编辑回流）共用同一调度器——并发不超过 4、同目标去重合并、用户展开操作优先于后台任务，任何来源都不会再打满主线程。
- **助手 TPS / token 计数不再丢失：** opencode 从创建起就给助手消息带全零 tokens 对象，流式期间落地的 HTTP 快照（补全/恢复/对账）若晚于 settle 事件，会把最终计数清零，TPS 显示随之消失。现在已累计的正向计数不会被全零快照回退，直到下次全量权威刷新。

## [1.17.1-beta.2] - 2026-08-19

- **Subagent 变更文件可查看：** 在子会话面板点击变更文件时，diff 使用该子会话的 session/directory 加载 turn 差异，不再误用父会话导致「无法查看变更内容」；移动端（iPhone / iPad）的 turn 差异面板同样按所属子会话加载。

## [1.17.1-beta.1] - 2026-08-19

- **工具 loading 点阵对齐：** 槽宽保持桌面 14px / 移动 16px，点阵在盒子内放大到约 12px，与 book / search 图标同一列；「探索中」不再把前导槽拉到 18px。
- **后台子 Agent 完成通知：** 父会话里的 `<subagent>` 通知渲染为可点击卡片；后台任务在子会话仍 running 时保持忙碌态，子会话 idle 后自动收敛。
- **设置 Agent 模式芯片：** 桌面「主 Agent / 子 Agent / 全部」保持一行，不再折行。

## [1.17.0] - 2026-08-19

### 核心：渐进式转录水合

- **打开长会话不再等整份历史：** 首个数据包即渲染最后一条用户消息与最终回答（或进行中的 Activity 外壳），输入框立即可用，更早的历史在后台补齐，不跳动视口；完成水合的 slim reasoning/tool 片段在挂载后自动补齐。
- **消息级转录缓存：** 转录按消息持久化到本地。重开会话时先按缓存瞬时绘制，再只做增量更新；冷启动不再走「降级 - 补拉」循环——有完整缓存的会话直接走热路径，首次上翻自愈为 exhausted，投影帧不再丢弃已加载的完整正文。
- **切会话不再连续跳页：** 切换会话时首帧即完整渲染底部进入窗口（summary 6 条 / collapsed 12 条），且已水合状态按会话保留（最近 16 个），切回时历史行直接以正文渲染；滚动中的分批节流策略保持不变。
- **表格/代码块首帧不抖动：** 表格容器、代码块卡片、mermaid、链接等装饰在同步首绘完成，首帧几何与最终形态一致；延迟渲染的占位骨架也同步归一化表格源码行高度。
- **工具输出按需拉取：** 完整工具调用输出只在展开 Activity 时获取，首帧保持轻量。
- **转录顺序正确性：** 缓存晚于网络页加载时，种子行按创建时间插入而非追加到尾部，不再出现旧回合渲染在新回合下方；缺失父消息不再阻塞整个会话加载。
- **手动刷新改为对账而非重建：** 刷新按权威尾部对账——未确认的新消息存活、尾部以外的历史保留、已加载的完整片段不降级为精简摘要；结构共享可识别引用稳定的删除子集。刷新与直播流竞争时跳过删除，不做猜测。
- **编辑/同步不丢不改：** 未确认的已发消息不被重连对账的精简副本覆盖；订阅确认后文本片段精确物化，编辑或重取后正文完整显示；进入已缓存会话时后台轻量权威尾部检查（30 秒窗口，SSE 活跃时跳过），多目录缓存的会话同时保持引用一致。
- **转录诊断：** 新增 transcript-diff 诊断事件，在发送/编辑/删除/刷新、重连补偿、物化与整目录重置前后记录快照（仅含消息 ID、片段数量、精简/完整分布、乐观标记，不含正文与附件），可在「关于 → 客户端诊断」导出。

### 会话与消息

- **会话引用升级：** @-提及会话不再内联整份转录（渐进式水合下未打开的引用会序列化为空消息而丢内容）；现在携带稳定的会话 ID 与标题，并附可读的 SQLite 查询配方供接收方按 ID 回读。消息全局去重并兼容粘贴/复制文本、`@session:<id>` token。
- **消息删除一致性：** 删除消息会应用到该会话的每个缓存作用域，而非仅当前目录。
- **消息更新按字段合并：** 事件不再整条覆盖——agent / mode / providerID / modelID / variant / model 只在携带非空值时更新，`time` 双向合并；助手消息头部身份在快照对账与列表重挂载时保持稳定，不再闪回通用占位。
- **/compact 显示修正：** 压缩回合不再渲染为用户气泡，压缩进度附着在持续助手 Activity 上，等待期间显示「正在压缩」状态提示。
- **项目列表活动置顶修复：** 新会话 / 新消息触发的置顶同时推进手动拖拽顺序；跨端通过服务端 settings 的 projects 顺序对齐，任意一端拖拽/置顶都同步到其他端。
- **侧边栏切换会话扩到跨项目：** 上一条 / 下一条快捷键按侧边栏可见项目顺序循环；折叠或「显示更多」隐藏的行不会被当作目标。

### 附件与图片

- **附件内联引用扩展：** 所有附件（本地文件、服务端文件、VS Code 文件与选区）在输入框都显示为 `[filename]` 内联引用卡片，图标按图片 / 附件区分。
- **图片引用携带宿主路径：** 发送 `[image-1.png]` 时把持久化宿主文件路径写入面向 Agent 的消息，后续回合可读取同一张图；聊天卡片仍显示短文件名。
- **上传走二进制流：** 附件字节先以二进制流上传，prompt JSON 只携带 `file://` 引用，不再用巨型 data URL 排队阻塞共享中继隧道。
- **原生 HEIC 转码：** iOS / Android 照片转 JPEG 走原生 ImageIO，WKWebView 主线程不再运行 WASM 解码器；桌面/Web 保留 JS 回退。
- **中继图片分块传输：** 图片按 512KB 批次跨原生桥传输（往返减少为 1/8），不再用超长展开；超过 1MB 的图片点击后才加载，已可见的不再额外滚动。
- **桌面图片上传修复：** Electron 页面 CORS 允许列表补上上传响应头。
- **移动端附件完整：** 附件按钮提供「照片 / 文件」——照片走系统 Photo Picker（多选），文件走文档选择器；文档附件在 iOS 可用 JSON 等非图片文件。

### 移动端

- **iOS 输入框展开动画重做：** pill 聚焦时不再同步提交整棵展开树——轮廓与键盘同拍翻转，其余控件下一帧挂载；展开/收起不再驱动布局属性的过渡动画（近 100ms 迟滞的根源），外形瞬时切换，圆弧缓动与 footer 淡入保留，键盘 FLIP 抬升不受影响。
- **长按选词不误触侧滑：** 长按选择文本后拖动选区把手，不再被当作左右滑切换会话；聚焦中的输入框上同样禁用切换手势。
- **聚焦恢复：** 会话面板 / 聊天输入浮层开关时恢复先前焦点，减少输入法状态丢失。
- **会话刷新入口：** 项目首页与会话列表长按菜单新增「刷新转录」，带加载 spinner，忙碌时自动禁用。
- **输入框显示修正：** 输入框上方渐变改用背景遮罩（iOS 显示一致），打开不再做压扁 / 缩放动画（曾导致 iOS 长文本不可滚动）。
- **Android 保存文件修复：** saveFile 桥先暂存私有缓存再打开系统保存器，避免大数据导出触发 Binder `TransactionTooLargeException`；OEM DocumentsUI 使用 octet-stream 与标题，不再崩溃。

### Agent 与工具呈现

- **连续 Load Skill 合并：** 连续技能调用折叠为一组，显示前三个技能名（超出显示「以及 N 个」），新技能到达时摘要向上翻转。
- **技能名不再为空：** 首帧精简页保留 name / id 定位串，行渲染读取 metadata.name / input.name / input.id，切换会话不再出现空白 Load Skill。
- **后台补全收敛：** 物化请求不再自动重试失败消息（展开或重试仍可人工触发），减少高频投影扰动与「整屏乱占位」；sorted 模式下无上下文的助手消息保持折叠占位而非平铺工具。
- **队列中止即时反馈：** 停止回合后下一条排队消息的提示气泡立即隐藏，并绘制为发送中的用户行，不再悬停在输入区等待真实提交。
- **探索中 loading 更清晰：** 会话「探索中」点阵略放大（桌面 18px，不超过折叠外层 Activity 图标）并与标题/摘要垂直居中；移动端统一行盒，避免宽屏断点把图标顶偏。
- **时间线引导线更轻：** 工具 / 思考 / JSON 摘要旁的引导线调淡，弱化在活动内容身后。

### 设置与其他

- **聊天设置：** 隐藏「内联助手操作」与「工具文件图标」设置项；「显示点文件」改名为「显示隐藏文件」。
- **iOS TestFlight 内测恢复：** 发布流水线补回 aps-environment entitlement。
- **会话历史恢复：** 曾返回空快照的项目会重新发现历史会话，不再等到 24 小时才恢复。

## [1.17.0-beta.28] - 2026-08-19

- **探索中 loading 更清晰：** 会话里「探索中」点阵指示器略放大（桌面 18px，不超过折叠外层 Activity 图标），并与标题/摘要同一行高垂直居中；移动端按 `isMobile` 统一行盒，避免宽屏断点把图标顶偏。
- **侧边栏跨项目切换会话：** 项目来源的上一条/下一条快捷键不再锁死在当前展开项目内，会按侧边栏可见项目行顺序跨项目循环；折叠/「显示更多」隐藏的行仍不会被当作目标。

## [1.17.0-beta.27] - 2026-08-19

- **侧边栏项目顺序不跟手：** 项目列表默认按手动拖拽顺序渲染，但新会话 / 新消息触发的置顶只改了注册表顺序、没推进手动顺序——只要拖拽过一次，之后的「活动置顶」就永远失效。现在活动置顶同时推进两者：手动排序保留，有新活动的项目照样顶到最前。跨端顺序也统一了：桌面与移动端通过服务端 settings 的 projects 数组顺序对齐，任一端的拖拽或活动置顶都会同步到其他端渲染。
- **长按选择文本误触发滑动切换：** 聊天正文里长按选中文本后拖动选区把手，不再被识别为左右滑切换会话的手势；宿主内存在展开选区时，该次触摸始终归文本选择所有。
- **iOS TestFlight 内测恢复：** 发布流水线补回 `aps-environment` entitlement 声明，beta 构建可再次正常上传 TestFlight 内测（上一版 beta.26 的 iOS 上传因此失败，桌面 / 安卓产物不受影响）。

## [1.17.0-beta.26] - 2026-08-19

- **冷启动会话「先塌再胀」：** 有持久缓存的会话冷切入时不再每次重演降级-补拉循环。此前持久种子重建的转录边界始终为 unknown，冷进入永远被判为「无热缓存」而整页权威重拉；权威页又以 slim 摘要投影重放（其 part id 与缓存的 full 不一致），同 id 保护失效——324 个 full part 塌成 247 再靠几十次物化请求补回，下次冷启动全部重来。现在种子用最旧记录推导保守 has-more 边界直接走热路径（缓存恰好存全时首次上翻自愈为 exhausted），冷启动仍保一次权威校验；合并层同时补齐「投影帧不得丢弃已有 full part」的不变量（不按 id 匹配），全量快照仍权威替换、真实删除不受影响。
- **移动端浮层焦点恢复：** 会话面板 / 聊天输入相关浮层打开与关闭时恢复先前焦点，减少输入法状态丢失。

## [1.17.0-beta.25] - 2026-08-19

- **表格/代码块渲染抖动：** 含 Markdown 表格（或代码块）的消息渲染时页面抖一下的问题已修复。此前首帧只做图片装饰——表格以默认可换行布局先画一版「高而窄」的形态，异步装饰帧再套上禁换行的横向滚动容器，单元格瞬间收成单行、行高骤变，虚拟列表测量到两次几何差后补偿滚动位置，看起来就是抖一下；代码块的卡片外壳同样晚一帧出现。现在完整装饰（表格容器 / 代码块卡片 / mermaid / 链接）在同步首绘即完成，首帧几何与最终形态一致。延迟渲染的占位骨架也同步归一化表格源码行（管道行按单行、分隔行按零高度估算），不再严重高估表格高度。

## [1.17.0-beta.24] - 2026-08-19

- **iOS 聚焦/收起输入框第二期：** pill → 卡片的展开不再对高度/内边距做过渡动画——布局属性逐帧动画会在键盘移动时重排整个聊天区，正是剩余约 100ms 迟滞的主要来源。外形现在瞬时切换，圆角缓动与 footer 淡入保留，手感依然柔和；键盘 FLIP 抬升不受影响。
- **助手消息头身份稳定：** 恢复/对账页拉取的快照不再整条覆盖现有消息——agent / provider / model 等身份字段按字段合并，快照缺失的字段保留线上既有值（与 SSE `message.updated` 同一规则）；消息行重挂载（虚拟列表、嵌套会话导航）时通过最近已知身份缓存保持头部显示，不再闪回通用回退。
- **转录诊断增强：** transcript-diff 诊断新增助手消息身份缺失计数与「身份先有后无」丢失检测（仅记录事实，不含值本身），导出后可直接定位身份丢失事件。

## [1.17.0-beta.23] - 2026-08-19

- **会话切换多次闪动：** 切换会话（iOS 尤其明显）时内容已可见、页面却连跳数次的问题已修复。此前切换瞬间首帧只渲染最新一条富文本，其余行先画占位骨架、再在随后 60-300ms 内逐批换成正文，这一高度抖动与贴底固定互相拉扯，即使转录数据零变化也会闪动。现在切入首帧即完整渲染底部进入窗口（summary 6 条 / collapsed 12 条），且已水合状态按会话保留（最近 16 个会话），再次切回时历史行直接以正文渲染；滚动过程中的分批节流策略保持不变。

## [1.17.0-beta.22] - 2026-08-18

- **iOS 聚焦/收起输入框卡顿：** 点按 pill 聚焦时不再同步提交整棵展开树——轮廓（pill → 卡片）与键盘同帧翻转，附件 / agent / 模型 / 发送等 footer 控件下一帧再挂载；键盘收起路径同理。展开与收起均与键盘动画同拍，不再先卡后跳。聚焦或已展开的输入框上也不再触发左右滑切换会话（收起且未聚焦的 pill 上仍可滑动切换）。
- **会话元数据被事件清空：** transcript `message.updated` 事件现在按字段合并——agent / mode / providerID / modelID / variant / model 只在事件携带非空值时覆盖，局部更新不再把既有模型/agent 信息抹成空；`time` 字段双向合并保留已有时间戳。
- **附件内联引用扩展：** 所有附件（本地文件 / 服务端文件 / VS Code 文件与选区）在输入框中均显示为 `[filename]` 内联引用卡片，不再仅限图片和代码选区；图标按图片 / 附件自动区分。
- **移动端会话行「刷新转录」：** Projects 首页与会话列表的长按操作面板新增刷新转录条目，带加载 spinner，会话忙碌时自动禁用；相关文案迁移到共享的 sessions 菜单 key。

## [1.17.0-beta.21] - 2026-08-18

- **整理后显示的偶现大间距：** 中间过程折叠后出现整屏空白、且滚动或切换会话后才恢复的问题已修复。根因有二：其一，宿主始终以 slim 摘要回应精确补拉时，后台自动补全在每次虚拟列表重挂载时重试失败请求（诊断日志：约 10 秒内 104 次 materialize diff，slim/full 数量始终不变），高频投影扰动令部分中间消息丢失回合上下文；其二，sorted 模式下丢失上下文的助手消息会回退为 Activity 宿主，把工具行内联平铺成一整屏异常占位。现在后台补全不再自动重试失败消息（展开与重试按钮仍可手动重试），sorted 模式下无上下文的助手消息保持折叠占位，不再平铺工具。

## [1.17.0-beta.20] - 2026-08-18

- **Skill activity rows:** consecutive Load Skill calls now collapse into one group, like Explored. The header shows original skill names on a single line (up to three, then “and N more”), and the summary flips upward as more skills arrive.
- **Empty skill names:** first-packet slim pages now keep skill `name` / `id` locators, and the row reads `metadata.name`, `input.name`, or `input.id`. Opening another conversation no longer shows blank “Load Skill” rows until a manual sync.
- **Queue abort:** stopping a turn immediately hides the next queued chip and paints it as a sending user row, so the follow-up does not sit visible while the real POST still waits for the turn gate.

## [1.17.0-beta.19] - 2026-08-18

- **Activity timeline:** the vertical guide line beside tool, thinking, and JSON summary rows is now lighter so it recedes behind the activity content.

## [1.17.0-beta.18] - 2026-08-18

- **Out-of-order transcripts on open:** a session whose local cache loaded just after the network page no longer renders older turns below newer ones. The durable cache seed is skipped once the canonical transcript is already filled, and any seed rows that do land are inserted by their created time instead of being appended to the tail. A manual refresh could not repair the earlier misorder; the transcript is now ordered correctly from the first paint.

## [1.17.0-beta.17] - 2026-08-18

- **Compaction transcript:** `/compact` is no longer painted as a user bubble. The compact turn stays in place so the previous assistant stream does not remount, and Compacting / Compaction complete attach to the continuous assistant Activity.
- **Compaction status hint:** while the last user command is compact and the session is still working, the bottom working hint now says Compacting instead of leftover previous-turn tool status such as Editing file.

## [1.17.0-beta.16] - 2026-08-18

- **Manual refresh no longer swallows messages:** refreshing a session transcript now reconciles against the fetched authority tail instead of rebuilding it from scratch. A just-sent message that the server has not confirmed yet survives the refresh, older history outside the tail page is kept in place, and already-loaded full parts are not downgraded to slim summaries. Server-deleted messages within the refreshed range are still removed, and a refresh that races live streaming skips deletions rather than guessing.
- **Transcript deletion on the observer path:** structural sharing now recognizes reference-stable deletion subsets, so message removals are not silently restored by the query observer.

## [1.17.0-beta.15] - 2026-08-18

- **Swallowed sends:** an unconfirmed just-sent message is no longer overwritten when a reconnect reconcile delivers a slim server copy of it — the optimistic parts stay whole until full authoritative parts arrive. Editing (which removes old turns) is untouched by this protection.
- **Edited text not updating:** slim text parts are now exact-materialized from the host record, so a message body that landed as a summary after an edit or refetch upgrades to the full authoritative text without a manual refresh. Cold-start revalidation keeps targeting only tool/reasoning/file parts, so no fetch storm.
- **Enter-and-sync:** opening a session with a warm cache now runs a lightweight authority tail check in the background (30s per-session window, skipped while SSE is live, stale revisions merge conservatively) and merges the result without clearing the transcript, so turns that finished elsewhere appear on re-entry and failures keep what is on screen.
- **Sync test harness:** new command-sequence replay tests pin the optimistic-row protection, slim text fill, and hot revalidate behavior at the repository merge boundary.

## [1.17.0-beta.14] - 2026-08-18

- **Transcript diagnostics:** new `transcript-diff` diagnostics event captures a canonical snapshot (message IDs, per-message part counts, slim/full distribution, optimistic markers) before and after every user send/edit/delete/refresh and every reconnect-compensation, materialize, and destructive-reset path, then derives the added/removed/downgraded/optimistic-lost diff. Snapshots carry no message text or attachment payloads; existing merge and compensation behavior is unchanged. Export via About → client diagnostics.
- **Composer session mentions:** @-referenced sessions now ship a self-describing card with id, title, owning directory, and cached client messages, plus a verified read-only SQLite recipe the receiving assistant can use to look up the transcript itself. Empty `messages` arrays now signal a client cache miss (still retrievable) instead of masquerading as an empty session.
- **Android save-file picker:** the Capacitor `OpenChamberMedia.saveFile` bridge now stages bytes in an app-private cache file before opening the system picker, avoiding Binder `TransactionTooLargeException` on large diagnostics exports, and uses `application/octet-stream` + `EXTRA_TITLE` so OEM DocumentsUI does not crash on confirm.

## [1.17.0-beta.13] - 2026-08-18

- **Session references:** @-mentioning a conversation no longer inlines its transcript into the prompt — under progressive hydration an unopened referenced session serialized as empty messages, silently dropping the reference content. The hidden part now carries only the stable session ID and display title plus an instruction to look the session up by ID when its content matters, references resolve from loaded session summaries without transcript reads, and pasted or copied `@<title>` text also delivers session semantics (deduped against `@session:<id>` tokens).
- **Message removal consistency:** removing a message now applies across every cached transcript scope of the same session instead of only the resolved directory, keeping multi-directory session caches consistent after retries or edits.

## [1.17.0-beta.12] - 2026-08-17

- **Missing turns:** transcript updates now broadcast to every cached scope of the same session instead of only the directory the event arrived on, and an ambiguous multi-directory route no longer drops events. Opening an already-cached session also runs a throttled background reconcile check, so turns that finished elsewhere (or before a restart) appear without a manual refresh.

## [1.17.0-beta.11] - 2026-08-17

- **Android attachments:** tapping attach in the chat composer now offers Attach photos or Attach files. Photos open the Android system Photo Picker (gallery, multi-select) through a new native bridge; files keep the document picker. iOS, desktop, web, and VS Code keep their existing attach flows.
- **Transcript hydration:** completed activity groups hydrate their slim reasoning/tool parts in the background after mount, so a cold-start tail no longer shows truncated bodies until manual expansion.

## [1.17.0-beta.10] - 2026-08-17

- **Session list recovery:** a project whose sidebar stayed empty after OpenCode once returned an empty session snapshot now rediscovers its historical sessions on the next sync, instead of waiting for the 24-hour full reconcile. Empty worktree directories keep their topology hint and normal projects keep incremental sync.

## [1.17.0-beta.9] - 2026-08-17

- **Image citations:** sending `[image-1.png]` now also writes the durable host file path into the agent-facing message, so a later turn can Read the same image. The chat chip still shows the short filename; relay/slim still omit the image bytes.

## [1.17.0-beta.8] - 2026-08-17

- **Transcript cache:** reopening the app after a session advanced elsewhere no longer pins stale message bodies from the local cache. Seeded tool/reasoning/file parts revalidate against the exact message record in the background after the first paint, so the latest content appears without a manual refresh.

## [1.17.0-beta.7] - 2026-08-17

- **Desktop image upload:** Electron can send prompt attachments again. The runtime CORS allowlist now includes the OpenChamber upload headers used from `openchamber-ui://app`.

## [1.17.0-beta.6] - 2026-08-17

- **Chat images:** slim first-paint images now upgrade in place from the exact message fetch. Assistant tool rows no longer appear as unnamed file attachments.
- **Relay images:** large images wait for a per-image Load tap instead of covering the whole card; already-visible images start loading without another scroll.

## [1.17.0-beta.5] - 2026-08-17

- **Transcript load:** a missing parent message no longer blocks the whole conversation. Sessions that OpenCode can open now load in OpenChamber even if one assistant row points at a deleted user message.

## [1.17.0-beta.4] - 2026-08-17

- **Chat settings:** hide Inline Assistant Actions and Show Tool File Icons. Chinese labels now say 显示隐藏文件 / 顯示隱藏檔案 instead of 显示点文件.

## [1.17.0-beta.3] - 2026-08-17

- **Prompt attachment uploads:** inline image/file bytes are uploaded as a binary stream before the prompt is sent, and the prompt JSON only carries a host `file://` reference. Sending large attachments no longer head-of-line blocks the shared relay tunnel with a giant data URL.
- **Native HEIC transcode:** iPhone photos convert to JPEG through native ImageIO on iOS (and the Android equivalent) instead of the heic2any WASM decoder in the WKWebView main thread; web/desktop keep the JS fallback.
- **Relay image streaming:** image chunks cross the native asset bridge in 512KB batches (8× fewer bridge round-trips), base64 chunking no longer uses oversized spread calls, and images larger than 1MB over a relay connection load on tap instead of automatically.
- **Attach documents on mobile:** the mobile attach button now opens the document picker, so JSON and other non-image files can be attached on iOS; photos stay reachable from the same picker's action sheet.

## [1.17.0-beta.2] - 2026-08-16

- **Mobile composer fade:** the fade above the input now uses a page-background mask instead of a `color-mix` gradient, so it renders on iOS WKWebView the same way it already did on Android.
- **Mobile composer scroll:** opening the input no longer press-scales or scaleY-animates the card. That transform was leaving a long textarea intermittently unscrollable on iOS.

## [1.17.0-beta.1] - 2026-08-16

- **Progressive transcript hydration:** opening a long session no longer waits for the whole history. The last user message and final answer (or a live Activity shell) render from the first packet, the composer is usable immediately, and older history backfills in the background without jumping the view.
- **Message-level transcript cache:** transcripts are now persisted per message on-device. Reopening a session paints from local cache instantly and then delta-updates only the messages that actually changed, instead of refetching the whole window.
- **On-demand tool output:** full tool-call output is fetched only when you expand an Activity, keeping first paint small.
- **Transcript diagnostics:** prerelease builds record transcript sync/load-failure facts locally and export them from About, so we can debug slow or failed loads without uploading message content.

## [1.16.134] - 2026-08-16

- **Exploration groups:** consecutive read, search, and directory tools collapse into a localized exploration group with live progress and expandable details. The grouped Exploring state lasts from the first exploration call until a later non-explore part appears, and the live count flip no longer spills out of the row or opens a mobile scrollbar (overflow-clipped so Android does not paint an overlay thumb).
- **Tool loading:** every chat tool shows the shared loading state from first appearance until it settles, then restores its normal icon; running shell tools show the loading orb while settled rows keep the terminal icon.
- **Delegated task rows:** assigned task rows keep the agent avatar and name across busy and idle states; only an unassigned live Task shows Delegating, while ordinary running tools keep their own titles. The agent badge chip on mobile is smaller, regular weight, and fill-only.
- **Localized tool names:** built-in tools carry concise Chinese labels (apply_patch is "批量修改" so patch edits read apart from single-file edit), and reasoning/activity copy consistently uses "Agent" in Simplified and Traditional Chinese instead of 智能体 / 智能體.
- **Transcript reliability:** a just-sent message and its follow-up could stop appearing while the status line kept moving; the message body now always subscribes and the option that could silence it has been removed. If a session still reports work while the visible transcript has not moved for 20 seconds and no local stream is running, the client refetches the authoritative tail itself; a failed refetch keeps the messages on screen and is logged.
- **Provider recovery:** messages no longer get stuck after a failed provider load. Sending re-triggers a fresh provider refresh once before giving up, and an empty provider catalog is never cached as permanently fresh, so the model list is re-fetched on demand instead of being stranded forever.
- **Session goals & questions:** when the agent asks a question, the goal pauses instead of staying on Evaluating and keeps waiting for your reply; a missed pending question is fetched again so its answer card returns instead of leaving unclickable chips.
- **Mobile session layout:** worktree sessions share the project-level indent instead of sitting one extra level deeper; the composer status uses the same type size as collapsed Processed activity titles and stays on the stable copy 正在委派任务 while a Task runs; the lattice loading orb is slightly larger on phones.
- **Diagnostics & privacy:** About export now saves a file via the system save picker (iOS Files / Android create-document) instead of copying to the clipboard. Anonymous usage reporting stays off unless the user turns it on, and prerelease builds record transcript sync/load-failure facts locally without ever including message bodies or tokens.
- **Remote instances:** pairing names an instance instead of a device, and relay matches require the relay URL in addition to paired credentials.
- **Dev server:** the bundled web dev build no longer pulls server or test files into the browser graph.
- **Docs (zh-CN):** refreshed Chinese documentation and sidebar navigation for the included product guides.

## [1.16.134-beta.21] - 2026-08-16

- **Exploration groups:** the count flip uses overflow clipping that does not create a scroll box, so Android no longer paints a tiny overlay thumb on the row.

## [1.16.134-beta.20] - 2026-08-16

- **Exploration groups:** the count flip still moves upward, but compositor layers no longer poke out of the row and flash a mobile scrollbar.
- **Mobile sessions:** expanded worktree lists no longer add a second indent under the project.

## [1.16.134-beta.19] - 2026-08-16

- **Status bar:** on mobile, the composer status uses the same type size as collapsed Processed activity titles.
- **Mobile sessions:** worktree sessions now share the project-level indent instead of sitting one extra level deeper.

## [1.16.134-beta.18] - 2026-08-16

- **Status bar:** while a Task is running, the composer status stays on the stable Chinese copy 正在委派任务 instead of the subagent name.

## [1.16.134-beta.17] - 2026-08-16

- **Provider recovery:** messages no longer get stuck after a failed provider load. Sending re-triggers a fresh provider refresh once before giving up, and an empty provider catalog is never cached as permanently fresh, so the model list is re-fetched on demand instead of being stranded forever.

## [1.16.134-beta.16] - 2026-08-16

- **Exploration groups:** the count flip keeps its upward motion, but the row can no longer grow and open a mobile scrollbar.

## [1.16.134-beta.15] - 2026-08-16

- **Tool rows:** ordinary running tools keep their own titles. Only an unassigned live Task shows Delegating.

## [1.16.134-beta.14] - 2026-08-16

- **Agent naming:** reasoning and activity copy now consistently use "Agent" in Simplified and Traditional Chinese instead of 智能体 / 智能體 (including the task tool row). The existing code comment in ToolPart is left untouched.

## [1.16.134-beta.13] - 2026-08-16

- **Tool rows:** only an unassigned Task shows Delegating. Assigned tasks keep the agent name; other tools keep their normal titles and only swap in the loading orb.
- **Mobile loading:** the lattice orb is slightly larger on phones, and the exploration count flip no longer opens a scrollbar.
- **Remote instances:** pairing names an instance instead of a device, and relay matches require both server id and relay URL.

## [1.16.134-beta.12] - 2026-08-16

- **Session goals:** when the agent asks a question, the goal pauses instead of staying on Evaluating. The current turn keeps waiting for your answer; resume after you reply.
- **Questions:** missed pending questions are fetched again so the answer card comes back, instead of leaving only unclickable chips in the transcript.
- **Subagent rows:** assigned task rows keep the agent name instead of falling back to Delegating.
- **Dev server:** bundled web dev no longer pulls server or test files into the browser graph.

## [1.16.134-beta.11] - 2026-08-16

- **iOS beta:** prerelease TestFlight marketing version again strips the suffix (`1.16.134-beta.10` → `1.16.134`) instead of pinning to `0.99.0`, so Apple can treat it as an update on the current 1.16.x train.

## [1.16.134-beta.10] - 2026-08-16

- **Diagnostics export:** About export now saves a file. Capacitor opens the system save picker (iOS Files / Android create-document) instead of copying to the clipboard.
- **iOS beta:** prerelease TestFlight marketing version is now fixed at `0.99.0` instead of the stripped package version, so Apple version trains no longer go backwards when package versions jump.
- **Usage reports:** anonymous usage reporting is off unless the user turns it on.

## [1.16.134-beta.9] - 2026-08-16

- **Diagnostics:** prerelease builds record transcript sync and load-failure facts locally. About can export the log; message bodies and tokens are never included.
- **iOS beta:** prerelease IPAs now upload to Internal TestFlight. Apple marketing version drops the `-beta` suffix; external group and Beta App Review stay off.

## [1.16.134-beta.8] - 2026-08-16

- **Agent badge:** the message-header agent chip is smaller, regular weight, and fill-only (no border). On mobile the name matches the 10px avatar.

## [1.16.134-beta.7] - 2026-08-16

- **Subagent rows:** the agent name stays visible beside the avatar instead of collapsing away.
- **Exploration groups:** the live count flip no longer spills out of the row and creates a scrollbar.

## [1.16.134-beta.6] - 2026-08-16

- **Subagent rows:** delegated task rows keep the agent avatar while work is in progress instead of switching to the shared loading orb.

## [1.16.134-beta.5] - 2026-08-16

- **Exploration groups:** the grouped Exploring state now lasts from the first search/read/list call until a later non-explore part appears, instead of stopping as soon as those calls settle.

## [1.16.134-beta.4] - 2026-08-16

- **Tool loading:** every chat tool shows the shared loading state from first appearance until it settles; settled rows restore their normal icons.
- **Docs (zh-CN):** refreshed Chinese documentation and sidebar navigation for the included product guides.

## [1.16.134-beta.3] - 2026-08-16

- **Shell activity:** running shell/terminal tools show the shared loading orb; settled rows restore the terminal icon.
- **Tool labels:** Chinese `apply_patch` label is now “批量修改” so patch edits read apart from single-file edit.
- **Task chrome:** delegated task rows keep the agent avatar across busy and idle states (loading orb is shell-only).

## [1.16.134-beta.2] - 2026-08-16

- **Chat activity:** consecutive read, search, and directory tools now collapse into a localized exploration group with live progress and expandable details.
- **Tool labels:** built-in tool names are localized, with concise Chinese labels for editing, writing, patches, and delegated tasks.
- **Activity polish:** refined activity, exploration, and editing tool icon sizing and status presentation.

## [1.16.134-beta.1] - 2026-08-15

- **Frozen transcript:** the message body and the session status line are separate subscriptions, so the body could stop updating while the header kept showing activity — a just-sent message and the reply that followed it would never appear. The body now always subscribes, and the option that could silence it has been removed outright.
- **Transcript self-heal:** if a session still reports work while the visible transcript has not moved at all for 20 seconds and no local stream is running, the client refetches the authoritative tail on its own. A failed refetch keeps the messages already on screen, and the case is logged so the underlying cause can be traced.

## [1.16.133] - 2026-08-15

- **Sync messages:** desktop session right-click and the mobile overflow Refresh force an authoritative OpenCode tail. Success replaces the visible transcript; failure keeps the previous messages. Refresh is disabled only when the live session is actually busy or retrying.
- **Send self-heal:** after a long idle gap the client no longer trusts a zombie "connected" stream. It reconnects before sending, and a hung prompt times out so "Sending message" cannot stick forever.
- **Cold open:** a first tail page still lands when SSE moved while it was in flight, so the skeleton does not wait for another GET. Any landed row, including an assistant-only first page, dismisses the skeleton. An empty success still does not become an empty chat.
- **Load-error retry:** clicking Try again on "Unable to load this conversation" now shows the skeleton and actually reloads the transcript.
- **Mobile sync hint:** the chat title shows a tiny "Syncing messages..." line while the current session is first loading, user-refreshing, or reconnecting. Once a transcript is already visible, reconnect no longer keeps the whisper.
- **Relay:** apply per-direction backpressure and fair-queue pumps so one busy tunnel cannot monopolize the event loop or get heartbeat-reaped while paused.

## [1.16.139-beta.5] - 2026-08-15

- **Cold open:** a first tail page still lands when SSE moved while it was in flight, so the skeleton does not wait for another GET. Any landed row, including an assistant-only first page, dismisses the skeleton. An empty success still does not become an empty chat.
- **Mobile sync hint:** once the current session already has a transcript, reconnect no longer keeps the "Syncing messages..." whisper. The hint now reads the same directory as the chat.
- **Relay:** apply per-direction backpressure and fair-queue pumps so one busy tunnel cannot monopolize the event loop or get heartbeat-reaped while paused.

## [1.16.139-beta.4] - 2026-08-15

- **Load-error retry:** clicking Try again on "Unable to load this conversation" now shows the skeleton and actually reloads the transcript instead of doing nothing.

## [1.16.139-beta.3] - 2026-08-15

- **Mobile sync hint:** the chat title shows a tiny "Syncing messages..." line while the current session is first loading, user-refreshing, or reconnecting. Idle chats stay a single title line.

## [1.16.139-beta.2] - 2026-08-15

- **Sync messages:** Refresh is disabled only when the live session is actually busy or retrying. A sticky leftover busy flag no longer greys out the mobile overflow button.
- **Send self-heal:** after a long idle gap the client no longer trusts a zombie "connected" stream. It reconnects before sending, and a hung prompt times out so "Sending message" cannot stick forever.

## [1.16.139-beta.1] - 2026-08-15

- **Sync messages:** desktop session right-click and the mobile overflow Refresh now force an authoritative OpenCode tail. Success replaces the visible transcript; failure keeps the previous messages. Busy or retrying sessions disable the action so a live turn is not interrupted.

## [1.16.132] - 2026-08-14

- **Transcript echo:** SSE `message.updated` and optimistic merges locate rows by conversation order, not id binary-search. A completed turn keeps its finish/body on the live last assistant, and a just-sent user message is not duplicated while "Sending message..." stays pinned.
- **Conversation order on send:** idle/Query insert-only and optimistic queue inserts no longer re-sort the transcript by message id. A just-sent or queued user turn stays at the tail.
- **Transcript tail:** a lagging idle/Query snapshot no longer replaces the live last turn. Same-length or collapsed tail refreshes merge insert-only, and idle materialize drops the page if SSE moved while it was in flight.
- **Chat Activity auto-collapse:** insert-only idle/Query merges now copy missing `finish` / `time.completed` / `error` onto the live last assistant, so a completed turn can fold after the final body is visible.
- **Background idle settle:** a session that finishes off-screen is refreshed with the completed snapshot when you switch back, so reasoning can collapse and the final conclusion appears without restarting the app.
- **Provider/agent catalog:** new draft and project switch reuse the already-loaded global Agent and Provider lists. Composer no longer clears agents or waits on a per-project fetch; last selected agent+model ID stays per project. `listAgents` has a 12s timeout with merged abort signals, and startup catalog recovery stays single-flight across directory changes.
- **Session todos:** after opening a session, fill the todo list from the latest loaded `todowrite`/`todoread` in the transcript when live `todo.updated` never arrived.
- **Mobile Projects canvas:** share one page-background token between the app shell and tabs root, and keep the floating shell as a clip frame so short project lists no longer seam into plain `--background`.
- **Sidebar contrast:** lift session-sidebar ink in dark mode so labels stay readable on charcoal / vibrancy surfaces.
- **Mobile/Android pairing QR:** Google scan still runs first on devices with Play Services; if it fails to start, fall back to the bundled CameraX scanner so phones without GMS can pair. Old WebViews that misread `openchamber://` pairing links now parse the scanned string directly.

## [1.16.132-beta.8] - 2026-08-14

- **Transcript echo:** SSE `message.updated` and optimistic merges locate rows by conversation order, not id binary-search. A completed turn keeps its finish/body on the live last assistant, and a just-sent user message is not duplicated while "Sending message..." stays pinned.
- **Background idle settle:** a session that finishes off-screen is refreshed with the completed snapshot when you switch back, so reasoning can collapse and the final conclusion appears without restarting the app.

## [1.16.132-beta.7] - 2026-08-14

- **Provider/agent catalog:** new draft and project switch immediately reuse the already-loaded global Agent and Provider lists. Composer no longer clears agents or waits on a per-project fetch; last selected agent+model ID stays per project. Project-only agents remain rare and arrive later via force-refresh or Agents settings.

## [1.16.132-beta.6] - 2026-08-14

- **Conversation order on send:** idle/Query insert-only and optimistic queue inserts no longer re-sort the transcript by message id. A just-sent or queued user turn stays at the tail instead of disappearing into the middle of history.

## [1.16.132-beta.5] - 2026-08-14

- **Chat Activity auto-collapse:** insert-only idle/Query merges now copy missing `finish` / `time.completed` / `error` onto the live last assistant, so a completed turn can fold after the final body is visible. Lagging snapshots still cannot replace extra live messages or strip terminal fields already present.

## [1.16.132-beta.4] - 2026-08-14

- **Mobile Projects canvas:** share one page-background token between the app shell and tabs root, and keep the floating shell as a clip frame so short project lists no longer seam into plain `--background`.
- **Provider/agent catalog:** give `listAgents` a 12s timeout with merged abort signals, clear loading flags by per-directory load epoch, and keep startup catalog recovery single-flight across directory changes.

## [1.16.132-beta.3] - 2026-08-14

- **Transcript tail:** a lagging idle/Query snapshot no longer replaces the live last turn. Same-length or collapsed tail refreshes merge insert-only, and idle materialize drops the page if SSE moved while it was in flight.
- **Sidebar contrast:** lift session-sidebar ink in dark mode so labels stay readable on charcoal / vibrancy surfaces.

## [1.16.132-beta.2] - 2026-08-14

- **Session todos:** after opening a session, fill the todo list from the latest loaded `todowrite`/`todoread` in the transcript when live `todo.updated` never arrived. Typical on mobile when the write happened on another device. No extra request.

## [1.16.132-beta.1] - 2026-08-14

- **Mobile/Android pairing QR:** Google scan still runs first on devices with Play Services; if it fails to start, fall back to the bundled CameraX scanner so phones without GMS can pair. Old WebViews that misread `openchamber://` pairing links now parse the scanned string directly.

## [1.16.131] - 2026-08-14

- **Markdown code line numbers:** size gutters from wrapped layout height so mobile line wrap no longer desyncs numbers from the code.
- **Relay send:** if the event pipeline is down but the E2EE tunnel is connected, skip the nested OpenCode health probe so send no longer fails with `Connection lost (health probe unhealthy)`.
- **Relay event-stream ready:** wait up to 8s for the WebSocket to become ready (LAN stays 2s); Host `/api/opencode/health` nested fetch now times out at 4s.
- **Provider catalog:** one global cache per transport. New project / new-draft no longer force-refreshes the model list; only last selected model ID stays per project.
- **Conversation order:** revert visibility, the revert dock, and user-message history compare position by `messageOrder`, not lexicographic message ids.
- **Chat LaTeX:** render Pandoc-style `$...$` inline math with currency-safe pairing so `$I_m$` becomes KaTeX while `$50` / `US$ 680` stay money.
- **Retry overlay:** live session activity and expired retry backoff promote `retry` → `busy` so a resumed turn does not keep the retry overlay pinned.

## [1.16.131-beta.3] - 2026-08-14

- **Markdown code line numbers:** size gutters from wrapped layout height so mobile line wrap no longer desyncs numbers from the code.

## [1.16.131-beta.2] - 2026-08-13

- **Relay send:** if the event pipeline is down but the E2EE tunnel is connected, skip the nested OpenCode health probe so send no longer fails with `Connection lost (health probe unhealthy)`.
- **Relay event-stream ready:** wait up to 8s for the WebSocket to become ready (LAN stays 2s); Host `/api/opencode/health` nested fetch now times out at 4s.
- **Provider catalog:** one global cache per transport. New project / new-draft no longer force-refreshes the model list; only last selected model ID stays per project.
- **Conversation order:** revert visibility, the revert dock, and user-message history compare position by `messageOrder`, not lexicographic message ids.

## [1.16.131-beta.1] - 2026-08-13

- **Chat LaTeX:** render Pandoc-style `$...$` inline math with currency-safe pairing so `$I_m$` becomes KaTeX while `$50` / `US$ 680` stay money.
- **Retry overlay:** live session activity and expired retry backoff promote `retry` → `busy` so a resumed turn does not keep the retry overlay pinned.

## [1.16.130] - 2026-08-13

- **Android 12 launch crash:** move `OnBackAnimationCallback` / `OnBackInvokedCallback` out of `OpenChamberNavigationPlugin` into SDK-gated support classes so registering the plugin no longer class-loads Android 13/14-only `android.window.*` types on older devices.

## [1.16.130-beta.1] - 2026-08-13

- **Android 12 launch crash:** move `OnBackAnimationCallback` / `OnBackInvokedCallback` out of `OpenChamberNavigationPlugin` into SDK-gated support classes so registering the plugin no longer class-loads Android 13/14-only `android.window.*` types on older devices.

## [1.16.129] - 2026-08-12

- **Android package identity:** change release `applicationId` to `com.yee94.openchamber` (debug: `com.yee94.openchamber.debug`) so the fork no longer collides with upstream `com.openchamber.app` installs that use a different signing key. Uninstall any older `com.openchamber.app` build before installing this APK.
- **Windows: agent turns end reliably.** An agent turn no longer leaves the composer stuck in a busy state: benign durable-sync replica frames no longer tear down the WebSocket stream, a single unreadable frame can no longer wedge reconnect resume, and directory spellings that differ by drive-letter case or separators converge on the same session store so `session.idle` always reaches the composer.
- **Windows: queued follow-ups are admitted again.** Queue admission, ledger keys, chip scope matching, and server-queue scope lookup now address the canonical directory, so one project resolves to one queue whichever win32/canonical spelling a caller holds.
- **Path normalization hardening:** directory identity keys now canonicalize Windows drive-letter case and separator spellings, and read-only session status hooks no longer provision a directory store on a miss.
- **Sidebar session hover card:** let the session title wrap to multiple lines so the full name stays readable instead of truncating with an ellipsis.
- **Sorted chat final-body streaming:** in “Sorted” / “整理后显示” mode, intermediate tool and reasoning work still lands in Activity; only the terminal final-conclusion body reveals and streams once the assistant reaches the no-continuation / finish absent-or-`stop` shape.
- **Context Panel subagent transcript after focus:** Sorted + collapsed Activity no longer blanks an open Context Panel chat when the window refocuses. Null-anchor (subtask/synthetic) reconnect refresh uses non-destructive `ensureInitial` instead of wiping the transcript; the panel’s open session stays in the compensation viewed set across blur; an empty open surface force-ensures on focus.
- **i18n:** clarify Sorted-mode descriptions across locales so the setting matches the final-body-only streaming behavior.

## [1.16.129-beta.6] - 2026-08-12

- **Context Panel subagent transcript after focus:** Sorted + collapsed Activity no longer blanks an open Context Panel chat when the window refocuses. Null-anchor (subtask/synthetic) reconnect refresh uses non-destructive `ensureInitial` instead of wiping the transcript; the panel’s open session stays in the compensation viewed set across blur; an empty open surface force-ensures on focus.

## [1.16.129-beta.5] - 2026-08-12

- **Sorted chat final-body streaming:** in “Sorted” / “整理后显示” mode, intermediate tool and reasoning work still lands in Activity; only the terminal final-conclusion body reveals and streams once the assistant reaches the no-continuation / finish absent-or-`stop` shape.
- **i18n:** clarify Sorted-mode descriptions across locales so the setting matches the final-body-only streaming behavior.

## [1.16.129-beta.4] - 2026-08-12

- **Windows: queued follow-ups are admitted again.** Outgoing requests carry a canonicalized directory while session payloads come back in the win32 spelling, so queue admission compared two spellings of the same directory, judged every attempt stale, and handed the message back to the composer. Admission, the queue ledger key, chip scope matching, and server-queue scope lookup now address the canonical directory, so one project resolves to one queue whichever spelling a caller holds.

## [1.16.129-beta.3] - 2026-08-12

- **Windows: agent turns end reliably.** An agent turn no longer leaves the composer stuck in a busy state: benign durable-sync replica frames no longer tear down the WebSocket stream, a single unreadable frame can no longer wedge reconnect resume, and directory spellings that differ by drive-letter case or separators converge on the same session store so `session.idle` always reaches the composer.
- **Path normalization hardening:** directory identity keys now canonicalize Windows drive-letter case and separator spellings, and read-only session status hooks no longer provision a directory store on a miss.

## [1.16.129-beta.2] - 2026-08-12

- **Sidebar session hover card:** let the session title wrap to multiple lines so the full name stays readable instead of truncating with an ellipsis.

## [1.16.129-beta.1] - 2026-08-12

- **Android package identity:** change release `applicationId` to `com.yee94.openchamber` (debug: `com.yee94.openchamber.debug`) so the fork no longer collides with upstream `com.openchamber.app` installs that use a different signing key. Uninstall any older `com.openchamber.app` build before installing this APK.

## [1.16.128] - 2026-08-12

- **Desktop multi-window appearance isolation:** scope sidebar brand and theme localStorage by runtime transport so a packaged local window and a remote-host window no longer share logo/theme prefs; delay theme server write-back until settings hydrate so remote hosts are not polluted with local defaults.
- **Relay event-stream stability:** serialize host-side WebSocket outbound fragments so large frames no longer interleave and corrupt JSON over the tunnel.
- **Event pipeline recovery:** treat invalid WS frames (JSON parse, bad type, non-normalizable event payload) as transport faults; keep the last good event id, reconnect with compensation, and prefer SSE fallback in auto mode without postponing heartbeat recovery.
- **Diff summary over the wire:** Host outbound `session.diff` and message/session `summary.diffs` now ship preview fields only (`file` / `status` / `additions` / `deletions`); full patch bodies are stripped before fan-out and replay.
- **Client store sanitization:** summarize `session.diff` and message summary diffs on ingest so large patch/before/after blobs never enter live stores.
- **Turn Diff on demand:** DiffView turn scope loads full patches via `GET /session/{id}/diff` when expanding a turn, merges them with summary stats, keeps tool-patch paths inline, and surfaces load failure with retry while preserving the summary file list.
- **Update button polish:** sidebar update button is now a compact solid theme-color circle (24px, no translucent tint); in-progress buttons in the update dialog use a solid primary fill instead of a semi-transparent one.

## [1.16.128-beta.2] - 2026-08-12

- **Desktop multi-window appearance isolation:** scope sidebar brand and theme localStorage by runtime transport so a packaged local window and a remote-host window no longer share logo/theme prefs; delay theme server write-back until settings hydrate so remote hosts are not polluted with local defaults.

## [1.16.128-beta.1] - 2026-08-12

- **Relay event-stream stability:** serialize host-side WebSocket outbound fragments so large frames no longer interleave and corrupt JSON over the tunnel.
- **Event pipeline recovery:** treat invalid WS frames (JSON parse, bad type, non-normalizable event payload) as transport faults; keep the last good event id, reconnect with compensation, and prefer SSE fallback in auto mode without postponing heartbeat recovery.
- **Diff summary over the wire:** Host outbound `session.diff` and message/session `summary.diffs` now ship preview fields only (`file` / `status` / `additions` / `deletions`); full patch bodies are stripped before fan-out and replay.
- **Client store sanitization:** summarize `session.diff` and message summary diffs on ingest so large patch/before/after blobs never enter live stores.
- **Turn Diff on demand:** DiffView turn scope loads full patches via `GET /session/{id}/diff` when expanding a turn, merges them with summary stats, keeps tool-patch paths inline, and surfaces load failure with retry while preserving the summary file list.

## [1.16.127-beta.6] - 2026-08-11

- **File preview JSON/JSONC:** remove the JSON tree viewer from sidebar and mobile file preview; `.json` / `.jsonc` files now always open in the standard editor.
- **Tool JSON output:** drop the summary/item JSON view in shell and tool results; keep only the collapsible tree viewer (default) and raw JSON toggle.

## [1.16.127] - 2026-08-11

- **Assistant transcript loading:** materialize each active Assistant binding through the shared transcript repository, so current OpenCode messages load immediately and historical pagination continues through the standard conversation timeline.
- **Desktop language consistency:** localize native application menus, dock actions, and tray controls with the selected UI language; refresh their labels when the language changes.
- **Windows title bar:** use an opaque theme surface for Windows chrome and window controls.
- **Windows file references:** normalize drive-letter and UNC paths with `pathe`, preserving absolute roots and generating valid `file://` URLs for referenced files and folders.
- **Language recovery:** return the active locale state to the default language when a translation dictionary fails to load.

## [1.16.126] - 2026-08-11

- **Message edit while busy:** keep the editing state, abort then wait for session idle before deleting the old tail, then send the replacement (fixes OpenCode 409 Session is busy).
- **Cold-start Provider catalog recovery:** force-refresh empty Provider/Agent catalogs after a successful temporary empty warm load (`staleTime: Infinity`), with store-level single-flight and a shared `useStartupCatalogRecovery` poll (`useInterval`, bounded attempts) on web, mobile, and mini-chat; VS Code bootstrap uses the same store action.
- **Desktop new window black screen fix:** remove `setVisualZoomLevelLimits(-3, 5)` which broke the macOS compositor surface (0×0 layout viewport, fully opaque/blank paint) on Electron 41 additional windows; first window only survived because splash → app navigation reset the broken state.
- **Desktop window boot reliability:** per-key init-script assignment so contextBridge read-only globals no longer abort boot-outcome injection (fixes New Window / re-shown windows stuck on splash); boot outcome pushed through preload for host switches.
- **Desktop single-main-window semantics:** app-level broadcasts (deep links, notification clicks, updater/SSH/installed-apps events, system resume) now route to the main window only; closing the main window promotes the next surviving primary window in creation order.
- **electron:dev environment isolation:** strip production/preview `OPENCHAMBER_*` / `OPENCODE_*` env leakage (UI password, dist dir, runtime flags) from HMR children so dev API no longer 401s.
- **Desktop menu/dock:** New Window accelerator restored to Cmd/Ctrl+Shift+N, New Worktree entry removed, "Add Workspace" → "Add Project", and a dock menu (New Window / New Session / New Mini Chat).
- **File mention autocomplete:** move state derivation into a focused `fileMentionAutocompleteState.ts` module with tests.
- **Desktop host switch:** extract desktop host switch mutation/query helpers with tests.
- **Markdown list styling:** use native disc/decimal outside markers with theme-primary colored `::marker` (no faded en-dash pseudo-bullets); compact list item spacing aligned with agent-tracker prose rhythm. Body line-height stays `1.625`.

## [1.16.125] - 2026-08-10

- **Scheduled history mobile cards:** whole-card open with the shared soft press surface (no trailing open-session button); compact datetime and status chrome; time/trigger meta no longer ellipsized; error text uses an inline warning glyph that stays on the first line and wraps only at the trailing edge.
- **Scheduled History spacing:** match Tasks list card gap and a single `--oc-mobile-page-gap` under the tab switcher (no stacked tablist margin + content padding).
- **Runtime identity switch routing:** always rewrite the browser path to the restored session (or clear it); re-parse route state after identity switch so deep-link reconcile cannot toast or re-pin a previous-runtime session id; clear a previous-runtime `/session/…` path when restore has no matching session.
- **Deep-link failure toast:** toast `missing-directory` only once per dead session id for the mount lifetime; index refresh no longer spams.
- **Mobile settings search alignment:** use the shared `--oc-mobile-page-gap` between the collapsing header and settings search so the search field lines up with other root tab first content.

## [1.16.125-beta.6] - 2026-08-10

- **Scheduled history error row:** render the warning glyph as an inline icon with the message so it stays on the first line and only wraps at the trailing edge.

## [1.16.125-beta.5] - 2026-08-09

- **Scheduled history error row:** keep the warning icon inline with the message (line-clamp only on the text), and match History card spacing to the Tasks list on mobile tab.

## [1.16.125-beta.4] - 2026-08-09

- **Scheduled History spacing:** align mobile-tab History list offset with Tasks using a single `--oc-mobile-page-gap` (no stacked tablist margin + content padding).
- **Runtime identity switch routing:** always rewrite the browser path to the restored session (or clear it); re-parse route state after identity switch so deep-link reconcile cannot toast or re-pin a previous-runtime session id.

## [1.16.125-beta.3] - 2026-08-09

- **Scheduled history mobile cards:** open the run session from the whole card with the shared soft press surface; drop the trailing open-session button on mobile so meta stays readable.

## [1.16.125-beta.2] - 2026-08-09

- **Runtime switch path cleanup:** after a runtime identity switch, clear a previous-runtime `/session/…` path when restore has no matching session so deep-link resolve and missing-directory toasts do not re-fire.
- **Deep-link failure toast:** toast `missing-directory` only once per dead session id for the mount lifetime; index refresh no longer spams.
- **Scheduled history mobile cards:** compact datetime, smaller status chrome, stack time/trigger meta so they are not ellipsized beside open-session, and allow longer error text with better wrapping.

## [1.16.125-beta.1] - 2026-08-09

- **Mobile settings search alignment:** use the shared `--oc-mobile-page-gap` between the collapsing header and settings search so the search field lines up with other root tab first content.

## [1.16.124] - 2026-08-09

- **Path-mode app router:** replace query-param routing with history paths and exclusive primary surfaces (session / plan / schedule / assistant / settings); add session deep-link directory lookup, visible open failures, and sidebar reveal for focused sessions already in the loaded list.
- **New-session path:** canonicalize the draft surface as `/session/new` (with `/new` alias), wire router + session UI store so opening a draft owns the URL and does not re-open a previous session.
- **Sidebar visibility performance:** gate desktop/mobile sidebars with `isVisible` so off-screen surfaces unmount the session row tree and stop live aggregates, sticky headers, PR enrichment, and related speculative work while keeping the shell mounted for instant reopen.
- **Session index stability:** ignore pure `time.updated` churn in global upsert/live-list equivalence so ownership memos do not rebuild on every streaming tick; soften directory child-store eviction with a grace window to avoid thrashing multi-worktree expands.
- **Mobile collapsing headers:** keep sticky layout height constant and drive collapse with compositor-only `transform`/`opacity` (plus a static in-flow spacer) so scroll no longer feedback-bounces; scale titles top-left, preserve expanded top inset, and keep a comfortable compact edge inset on Android.
- **Mobile root headers:** collapse large tab titles on scroll with reduced-motion fallback; align read-only prompt banners with the solid mobile foot / safe-area treatment.
- **Mobile Projects worktrees:** add long-press actions and left-swipe New session / Delete rails on worktree headers (session-row parity), plus container wiring for worktree action sheets and delete.
- **Segmented selected chrome:** shared `.oc-segmented-selected-pill` in the design system — light elevated paper + soft shadow (no border ring), dark selection-token fill — used by scheduled Tasks/History, filter chips, and SortableTabsStrip active pills.
- **Mobile scheduled segmented controls:** share pad/gap/item-height metrics across Tasks/History and All/Active/Paused (+ create); derive concentric inner radius from surface radius minus pad; keep selected pills vertically centered and align trailing create action height.
- **Android floating glass:** remove the Capacitor Android opaque-fill override so mobile floating surfaces, dock, and glass controls keep the same translucent + backdrop-filter recipe as iOS; reduced-transparency remains the accessibility fallback.
- **Settings theme mode chips:** keep theme-mode options on one row (`flex-nowrap` + `shrink-0`) and shorten the Chinese system-follow label for dense mobile layout.

## [1.16.124-beta.6] - 2026-08-09

- **Mobile segmented radii:** derive inner item/pill radius from the track surface radius minus pad so outer and selected corners stay concentric; drop hard-coded inset-radius on scheduled Tasks/History and filter pills.

## [1.16.124-beta.5] - 2026-08-09

- **Mobile scheduled segmented controls:** share pad/gap/item-height metrics across Tasks/History and All/Active/Paused (+ create), keep selected pills vertically centered, and align trailing create action height with segment items.
- **Segmented selected chrome:** light mode keeps elevated fill + soft shadow only (no border ring); dark mode uses selection-token lift without a full outline.

## [1.16.124-beta.4] - 2026-08-09

- **Mobile collapsing headers:** keep sticky layout height constant and drive collapse with compositor-only `transform`/`opacity` (plus a static in-flow spacer) so scroll no longer feedback-bounces; scale titles top-left, preserve expanded top inset, and keep a comfortable compact edge inset on Android.
- **New-session path:** canonicalize the draft surface as `/session/new` (with `/new` alias), wire router + session UI store so opening a draft owns the URL and does not re-open a previous session.

## [1.16.124-beta.3] - 2026-08-09

- **Mobile collapsing headers:** interpolate expanded root title padding (`safe-area + 1rem + legacy pt-1.5`) down to detail-nav compact chrome, drop the forced min-height, and keep the header as the sole owner of top safe-area spacing.

## [1.16.124-beta.2] - 2026-08-09

- **Path-mode app router:** replace query-param routing with history paths and exclusive primary surfaces (session / plan / schedule / assistant / settings); add session deep-link directory lookup, visible open failures, and sidebar reveal for focused sessions already in the loaded list.
- **Sidebar visibility performance:** gate desktop/mobile sidebars with `isVisible` so off-screen surfaces unmount the session row tree and stop live aggregates, sticky headers, PR enrichment, and related speculative work while keeping the shell mounted for instant reopen.
- **Session index stability:** ignore pure `time.updated` churn in global upsert/live-list equivalence so ownership memos do not rebuild on every streaming tick; soften directory child-store eviction with a grace window to avoid thrashing multi-worktree expands.
- **Mobile Projects worktrees:** add long-press actions and left-swipe New session / Delete rails on worktree headers (session-row parity), plus container wiring for worktree action sheets and delete.
- **Mobile root headers:** collapse large tab titles on scroll with reduced-motion fallback; align read-only prompt banners with the solid mobile foot / safe-area treatment.

## [1.16.124-beta.1] - 2026-08-08

- **Segmented selected chrome:** add shared `.oc-segmented-selected-pill` in the design system — light elevated paper, dark selection-token fill — and use it for scheduled Tasks/History, filter chips, and SortableTabsStrip active pills so dark mode contrast is theme-owned, not feature-local.
- **Android floating glass:** remove the Capacitor Android opaque-fill override so mobile floating surfaces, dock, and glass controls keep the same translucent + backdrop-filter recipe as iOS; reduced-transparency remains the accessibility fallback.
- **Settings theme mode chips:** keep theme-mode options on one row (`flex-nowrap` + `shrink-0`) and shorten the Chinese system-follow label for dense mobile layout.

## [1.16.123] - 2026-08-08

- **Transcript repository:** move session messages, parts, pagination, optimistic updates, and live revisions behind one QueryCache-backed transcript store shared by chat, context, assistants, and runtime consumers.
- **Reconnect recovery:** signed Host reconciliation continuations, replay-before-ready compensation, generation isolation, bounded destructive reset, and stale-response merge rules that preserve newer live content.
- **Live tool details:** preserve tool part state changes through the transcript cache so Read paths, shell commands, output, metadata, and completion update in the active conversation without switching sessions.
- **History stability:** keep transcript snapshots referentially stable for timeline observers while preserving load-older pagination; rebuild scoped transcript subscriptions when the runtime binding changes so queue auto-send attaches to the new repository registry.
- **Chat stability:** retain a painted conversation while transcript cache data briefly refreshes or reconnects, preserving viewport position, composer focus, and cursor placement.
- **Cache and performance:** runtime-specific transcript LRU limits, narrow SSE observer updates to the changed message, and deterministic coverage for long-gap recovery plus high-volume event delivery.
- **Chat layout:** keep desktop user-message spacing consistent when sticky headers are disabled.
- **Mobile scheduled tasks:** scroll through the root phone tabpanel without a nested scrollbar; keep Tasks/History backgrounds aligned with Projects; unify history cards on floating surface material; keep the original elevated selected pill (fill + soft shadow) when switching views via a sliding indicator.
- **Test suite:** restore query/store tests blocked by incomplete `runtime-switch` mocks, port stale transcript reducer coverage, and realign contract tests with queue ledger semantics and moved pagination helpers.

## [1.16.123-beta.6] - 2026-08-08

- **Mobile scheduled tasks:** keep the Tasks / History selected pill elevation (white fill + soft shadow) when switching views, using a sliding elevated indicator instead of remounting button chrome.

## [1.16.123-beta.5] - 2026-08-08

- **Mobile scheduled tasks:** let the plan tab scroll through the root phone tabpanel (no nested scrollbar), keep task/history backgrounds aligned with Projects, and unify history cards on the floating surface material.

## [1.16.123-beta.4] - 2026-08-07

- **Chat stability:** retain a painted conversation while transcript cache data briefly refreshes or reconnects, preserving the viewport position, composer focus, and cursor placement.

## [1.16.123-beta.3] - 2026-08-06

- **Transcript observers:** rebuild scoped transcript subscriptions when the runtime binding changes so queued auto-send and other scope listeners attach to the new repository registry instead of a stale child-store map.
- **Test suite:** restore query and store tests blocked by incomplete `runtime-switch` mocks, port stale transcript reducer coverage to the current API, and realign contract tests with queue ledger semantics and moved pagination helpers; full `packages/ui` isolate suite is green again.

## [1.16.123-beta.2] - 2026-08-06

- **Live tool details:** preserve tool part state changes through the transcript cache so Read paths, shell commands, output, metadata, and completion state update in the active conversation without switching sessions or refreshing.
- **Chat layout:** keep desktop user-message spacing consistent when sticky headers are disabled.

## [1.16.123-beta.1] - 2026-08-06

- **Transcript state:** move session messages, parts, pagination, optimistic updates, and live revisions behind one QueryCache-backed transcript repository shared by chat, context, assistants, and runtime consumers.
- **Reconnect recovery:** add signed Host reconciliation continuations, replay-before-ready compensation, generation isolation, bounded destructive reset, and stale-response merge rules that preserve newer live content.
- **History stability:** keep transcript snapshots referentially stable for timeline observers, preventing historical conversations from entering repeated render updates while preserving load-older pagination.
- **Cache and performance:** apply runtime-specific transcript LRU limits, narrow SSE observer updates to the changed message, and cover long-gap recovery plus high-volume event delivery with deterministic runtime tests.

## [1.16.122] - 2026-08-06

- **Assistant turn completion:** align live, cached, and historical turns with OpenCode 1.18.4 run-loop semantics; ordinary tool calls remain continuation work until the terminal final answer, keeping Activity expanded between steps and eliminating the final tool/body flicker.
- **History pagination:** make each directory child store the authoritative load-older boundary, commit transcript pages and pagination state atomically, reject stalled or malformed cursors, preserve retry feedback, and settle native fetches with a hard timeout while concurrent page loads finish.
- **Reconnect and cache recovery:** generation-gate prefetch and materialization commits, invalidate transcript freshness after real reconnects or transport switches, recover the viewed conversation immediately, and wake SSE retries when the OS resumes the app.
- **Mobile load-older experience:** allow explicit pagination while background prefetch is pending, preserve the first visible message across virtualized prepends, and hide the control after an authoritative no-growth page.
- **Runtime requests:** route OpenCode V2 active-session checks through the runtime origin so the SDK emits `/api/session/active` exactly once; browser diagnostics now include failed runtime request status and call stacks.
- **Presentation:** strengthen desktop sidebar vibrancy and refine assistant TPS labels across supported languages.

## [1.16.122-beta.4] - 2026-08-06

- **History pagination:** settle native fetches with a hard timeout, wait through concurrent page loads, hide the load-older control after an authoritative no-growth page, and preserve retry feedback for transport failures.
- **Runtime requests:** route OpenCode V2 active-session checks through the runtime origin so the SDK emits `/api/session/active` exactly once; browser diagnostics now include failed runtime request status and call stacks.
- **Chat activity:** refine assistant TPS presentation and localized labels across supported languages.

## [1.16.122-beta.3] - 2026-08-06

- **Mobile history pagination:** allow an explicit “Load older messages” action to start while a background transcript prefetch is pending, preventing the stale prefetch lifecycle from blocking the request and showing a retry error without issuing a page fetch.

## [1.16.122-beta.2] - 2026-08-06

- **Mobile reconnect recovery:** invalidate cached transcript freshness after real stream reconnects and transport switches, recover the viewed conversation immediately, and refresh other cached conversations on their next visit so messages missed while the app was backgrounded appear without restarting.
- **Event stream resume:** wake SSE retry backoff immediately when the OS resumes the app, including reconnect attempts already sleeping in the long hidden/offline delay.
- **Desktop sidebar glass:** increase native blur visibility through the sidebar surface for a stronger vibrancy treatment.

## [1.16.122-beta.1] - 2026-08-06

- **Assistant turn completion:** align live, cached, and historical turns with OpenCode 1.18.4 run-loop semantics; ordinary tool calls remain continuation work until the model sends a terminal final answer, keeping Activity expanded between steps and preventing the final tool/body three-frame flicker.
- **History pagination:** make each directory child store the authoritative load-older boundary, commit transcript pages and pagination state atomically, reject stalled or malformed cursors, and retain the last known boundary through refresh failures.
- **Reconnect and cache safety:** generation-gate prefetch and materialization commits, share same-flight responses across provider remounts, and clear pagination boundaries with session eviction so reconnects and cross-directory sessions converge on the current transcript.

## [1.16.121] - 2026-08-05

- **Save image:** long-press or context-menu on chat images (markdown, attachments, fullscreen viewer) opens save actions; desktop downloads, mobile saves to Photos via a native media plugin, with runtime-file streams and preview-prefetch so save does not re-hit the host path.
- **Session catalog isolation:** subagent/child sessions never promote to sidebar roots when the parent is missing, archived, or system-owned; scheduled-task children stay out of the project list.
- **Live session caches:** hiding system, subagent, or archived sessions from the directory list no longer drops their message stream — only temporary SmartFetch secondaries wipe caches on leave.
- **Mobile back navigation:** defer history cleanup so React Strict Mode remounts and short-lived overlays (e.g. image preview) no longer pop the chat underlay.
- **Image viewer:** mobile back route, open-close guard against accidental dismiss, and long-press save from the fullscreen preview.

## [1.16.120] - 2026-08-05

- **Chat multi-step stability:** keep the live turn expanded between tool steps, settle completion only when both turn projection and session status agree work is done, and stop treating premature `time.completed` as a finished turn so nested tools no longer fold/flash mid-loop.
- **Display part monotonicity:** while an assistant turn is still open, union lagging HTTP/SSE part frames so already-painted tool rows cannot disappear for a frame; the same merge applies to the streaming tail.
- **Tool expansion:** render expanded tool bodies synchronously so virtualized rows measure real height on first paint instead of lurching a frame later.
- **Composer slash chips:** insert durable reserved-slot chips for non-built-in OpenCode commands without a leading auto-space, match command names case-insensitively, and align message reference chip metrics with the composer trigger well.
- **Scroll prepend tracking:** avoid reading `scrollHeight` on every append; measure only when prepend compensation needs a height delta.

## [1.16.119] - 2026-08-05

- **Mobile chat history availability:** reserve a spinner-backed load-older control while the first page resolves, so every mobile entry path keeps the pagination affordance visible.
- **Relay Markdown images:** retain `file:` image locators through sanitization as a private decoration source, allowing the Relay image pipeline to replace them with opaque native display URLs.

## [1.16.118] - 2026-08-05

- **Mobile chat history availability:** page responses retain their cursor and completion boundary through cache-dirty tail refreshes, keeping the load-older action available from authoritative response metadata.
- **Chat history pagination:** load four user turns per prepend page, pass each session workspace directory through pagination metadata, merge cursor state by authoritative load generation, and bound Host turn-page requests with a client timeout.
- **Mobile load-older experience:** render the spinner from the explicit pagination mutation, preserve the first visible message and its viewport offset across virtualized prepend transitions, and retain released auto-follow ownership through restoration.
- **History failure feedback:** surface turn-page and transport failures through the localized load-older toast, including user-initiated requests that return no page growth.
- **Relay host security:** allow private-relay host control only in the Electron desktop runtime; Web, CLI, VS Code, and plain Node runtimes receive an unavailable response.
- **Mobile scheduled task history:** keep each run's start time and trigger metadata on one compact row.

## [1.16.118-beta.4] - 2026-08-05

- **Mobile chat history:** label the initial cursor discovery as “Checking for earlier messages…” so it describes availability checking before the actionable load-more button appears.
- **Mobile load-older viewport:** hold auto-follow released through explicit prepend restoration, preventing TanStack transition and measurement scroll events from reclaiming bottom ownership on the first load.
- **Virtualized history transition:** preserve the first visible message and its viewport offset when a prepend crosses the small-history virtualization threshold.

## [1.16.118-beta.3] - 2026-08-05

- **Load-older button missing:** incomplete wins when merging local + prefetch meta — a dirty prefetch (`complete:false`) no longer loses to a stale local `complete:true`, which hid the mobile "load older" button and blocked pagination.
- **Load-older silent no-op:** throw when history is incomplete but cursor is missing; toast on user-initiated no-growth as well as transport errors.
- **Materialize turn limit:** session materialize writes prefetch `limit` as Host turnCount (not message count).
- Includes **1.16.118-beta.2** (cursor merge, failure toast, desktop-only relay host) and **beta.1** (4-turn pages, mutation busy, timeout).

## [1.16.118-beta.2] - 2026-08-05

- **Chat load-more silent no-op:** merge local pagination meta with prefetch so a local entry without cursor cannot hide a still-valid prefetch cursor (mobile "load older" no longer flashes and stops with no request).
- **Load-older failures:** surface Host turn-page / transport errors with a toast (`chat.history.loadOlderFailed`) instead of swallowing them after the spinner clears.
- **Relay host gate:** only the Electron desktop runtime may open the private-relay host-control socket; plain Node / web / CLI / VS Code report unavailable and refuse host enable/pairing with 403.
- Includes **1.16.118-beta.1:** 4-turn prepend pages, directory-scoped load-more, mutation-owned mobile load-older busy state, Host turn-page timeout, scheduled-tasks mobile history row layout.

## [1.16.118-beta.1] - 2026-08-05

- **Chat load-more:** raise history prepend to 4 turns per page (local and Relay), pass the session workspace directory into load-more meta so cross-project sessions no longer silent-no-op, and bound Host turn-page flights with a client timeout.
- **Mobile load-older button:** own explicit load-earlier with TanStack `useMutation` so the spinner tracks real mutation pending state instead of background materialize/prefetch loading (fixes stuck Relay spinner with no real load).
- **Scheduled tasks (mobile):** keep history row meta (started time / trigger) on one line in the mobile panel.

## [1.16.117] - 2026-08-04

- **Relay Markdown images:** load local image references through the encrypted binary tunnel on first paint, so screenshots and other agent-produced image artifacts render directly on paired clients.
- **Native Relay images:** stream host-backed images through an opaque virtual asset protocol on desktop and mobile (Electron `openchamber-asset` scheme + Capacitor bridge), so progressive tunnel images load without exposing host paths or credentials.
- **Chat history:** preserve current-session transcript content while older history pages load, with transport-aware turn windows and safer hosted Assistant transcript reconciliation.
- **Chat tool activity:** render each static tool call on its own row, keep pre-assistant compaction disclosure expandable, and seed task avatars by task id.
- **Queued message chips:** improve chip state handling for pending composer messages.
- **Scheduled task history:** refine failed-run details in dark mode with theme-aware text and a quiet status icon treatment.

## [1.16.116] - 2026-08-04

- **Git sync:** keep the toolbar controls aligned while sync details appear instantly in a hover tip; pending incoming or outgoing changes receive a compact status badge.
- **Chat stability:** eliminate activity-tool flicker during streaming, preserve cached timeline layout, and keep session synchronization responsive while live updates arrive.
- **Composer and references:** improve dropped-file references, inline visual layout, and model-control interaction handling.
- **Scheduled tasks:** extend the runtime allowance for task dialogs and simplify progressive tool-row rendering.

## [1.16.115] - 2026-08-04

- **Chat timeline (turn pages):** load and paginate conversations by turn pages instead of raw message slices, with shared Web / VS Code bridge + server `session-turn-pages` APIs so cold open, history scroll-up, and recovery share one cursor-aware contract.
- **Cold open hydration:** gate the transcript behind a stable skeleton until the first renderable snapshot lands — no more flash of “Unable to load this conversation”, and session pin waits until hydration leaves so deep links / session switches do not pin against an empty shell.
- **Virtualized history:** end-anchored TanStack Virtual (`anchorTo: 'end'`, `followOnAppend`) with activity-density estimates, timeline cache keys split by collapsed/summary mode, synchronous `scrollToFn` writes so end-anchor stays in lockstep with the DOM, and overscan that no longer ramps through thrashing measure waves.
- **Markdown hydration:** cold open and bulk history land settle the visible window in one after-paint commit; scrolling meters preload; idle frames release under density-aware limits so dense collapsed viewports stop freezing multi-hundred-ms React dumps.
- **Turn activity:** live processing on the latest turn always starts expanded so you can watch work in flight; when it settles and stays untouched it follows the collapsed/summary setting again; touched turns keep explicit expansion across disposition changes.
- **Progressive groups & compaction:** progressive tool/reasoning grouping and compaction-aware timeline projection keep long turns readable without losing part order or live tail fidelity.
- **Pending messages:** retain optimistic / provisional admission parts through live merge so user bubbles do not vanish when a part-less live row overlays SQLite history.
- **Hosted Assistant history:** seed the current binding from Assistant SQLite, overlay directory-sync by message ID (live wins only with parts), and keep same-assistant infinite-query placeholder data across `sessionID` / `sessionGeneration` so stateless turns do not blank the stitched transcript mid-load.
- **Scheduled tasks:** durable run-history store with dialog UI for past runs, elapsed duration, and clearer task status — plus recovery paths that keep history readable after restarts.
- **Session goals:** richer goal row / dialog with run history and elapsed duration while a goal is active or evaluating.
- **Composer send reliability:** primary send falls back to the visible model/agent selection when worktree→project config lag makes live capture miss; one more activate+recapture when still incomplete; missing provider/model now toasts instead of silently restoring the draft.
- **Session identity gate:** primary chat unblocks Send once a renderable message snapshot exists, even if the directory session-list row is still lagging; live/global session entity is a second proof path.
- **Model picker tooltip:** show provider name, capability icons (tools / reasoning / image / video / audio), and stacked In/Out cost rows instead of raw modality text dumps.
- **Sync:** initial session materialization uses the turn-page limit (`getInitialSessionTurnLimit`) so bootstrap page size matches history pagination.
- **Desktop branding:** refresh packaged `icon.ico` / `icon.png` assets for the dark OpenChamber mark.

## [1.16.114] - 2026-08-03

- **Markdown rendering:** reserve the box each content string actually renders at instead of laying out the raw source as an invisible spacer, so the swap from placeholder into rich content no longer shrinks the row or yanks the scroll offset; heights come from `ResizeObserver` entries and are dropped when the column width changes.
- **Markdown highlighting:** memoize every Shiki worker entry point with content-addressed keys, deduplicate concurrent requests for the same snippet into one worker job, and leave failed highlighting retryable instead of cached, so a row scrolling out of view can no longer strip highlighting from a row still waiting on the same code.
- **Markdown hydration:** batch-release the visible hydration window in one commit (with metered preload past both viewport edges) so entering a session settles layout without remeasuring and re-anchoring the virtualizer once per turn.
- **Code fences:** a fence whose info string is a `startLine:endLine:filepath` code reference now resolves the referenced file's name or extension to the correct Shiki language id and shows the file path on the code card header, instead of leaving every reference block uncolored under a mangled path.
- **Message rendering:** release the turn tail in one batch while idle (never mid-stream), and replace the forced reflow reads in the chat auto-follow scroll path with a single box snapshot per scroll event for a smoother long-scroll experience.
- **Sessions sidebar:** refresh active-session selection with an inset rounded chip, keep the whole row clickable (without double-firing interactive children), and optimize group prop equality and render-phase structure lookups to reduce re-renders.
- **Goal mode:** recover a restarted active goal stranded on “evaluating” after the app was force-killed mid-turn — an orphaned unfinished assistant reply is now corroborated against live session status and resumed past instead of bailing forever.
- **Chat history:** recover an incomplete tail page by fetching up to eight missing parent user messages by exact message ID (including mixed tails that already hold a newer user turn); authoritative complete pages skip parent recovery.
- **Settings / i18n:** add a theme-mode switch label and align the “Tokens” terminology across Simplified and Traditional Chinese goal copy.

## [1.16.113] - 2026-08-03

- **Slash commands:** auto-submit only immediate local actions (`new`, `fork`, `compact`, `undo`, `redo`, `model`, `goal`); draft-style commands such as `/loop` insert into the composer for continued editing.
- **Goal mode:** `/goal` only arms goal mode, strips the command token, and leaves any objective draft in the composer instead of auto-sending.
- **Composer chips:** hand-typed complete slash commands promote to reserved-slot chips so icon spacing matches autocomplete selection.
- **Assistant TPS:** optional generation-rate display on completed assistant messages and in the context panel (tool call time excluded).
- **Terminal:** stop rebinding the PTY stream on viewport resize/fit; only the first measured viewport size enters session creation.
- **Docs / mobile:** refresh README download links and mobile screenshots; keep Capacitor update checks on the native app version path.

## [1.16.112] - 2026-08-03

- **Mobile Relay recovery:** preserve the active runtime and model catalog through transient re-probe failures, allowing the tunnel reconnect path to recover without clearing model selection.

## [1.16.111] - 2026-08-02

- **Mobile image preview:** consume the WebView's synthesized trailing click before the viewer unmounts so a stationary tap closes the preview and keeps the source image closed.

## [1.16.110] - 2026-08-02

- **Image preview:** keep the full-screen viewer in control of pointer input throughout its closing transition and consume the closing click so the underlying image stays closed.

## [1.16.109] - 2026-08-02

- **Image preview:** replace the static image popup with a full-viewport gallery viewer that supports `1x`–`5x` zoom, bounded pan, desktop wheel/double-click controls, mobile pinch gestures, and swipe navigation without horizontal content padding.
- **Mobile image preview:** use a stationary tap to close at any zoom level while keeping pinch, pan, gallery swipe, and cancelled gestures isolated; remove visible title and close chrome while preserving keyboard focus trapping and an accessible hidden close action.

## [1.16.108] - 2026-08-02

- **Chat images:** open Markdown and message images in the shared gallery preview, resolving relative paths, absolute paths, and file URLs through the active Relay runtime when needed.
- **Relay Markdown:** show themed click-to-load placeholders for local images while direct and LAN connections retain browser-native image loading; streaming updates reconcile activated image resources through explicit render commits without DOM image observers.
- **Assistant navigation:** open source sessions through the native phone navigation stack, honor guarded Chat-tab switches on desktop and iPad, and use a target icon for the source-session action.

## [1.16.107] - 2026-08-01

- **Desktop updates:** keep idle package downloads silent until the user clicks Download, then join any in-flight download and show progress from the current offset instead of restarting at 0%.
- **Desktop updates:** style “Restart to Update” with the normal primary action color instead of the success mint tint.
- **Message queue:** address durable queue rows by transport, directory, session, and delivery target only — never by runtime generation — so LAN⇄relay or host-restore bounces no longer orphan persisted queue items.

## [1.16.106] - 2026-08-01

- **Mobile updates:** Android and iOS Capacitor clients now check for app updates directly against EdgeOne, then Vercel, then GitHub Releases, using the native app version instead of the connected OpenChamber Server’s network and version.

## [1.16.105] - 2026-08-01

- **Updates:** check the configured EdgeOne-compatible update service first, then Vercel, then GitHub Releases. The update path now serves Web, VS Code, Capacitor mobile, and server-managed update checks through the same fallback chain.

## [1.16.104] - 2026-08-01

- **Mobile updates:** surface update-check failures instead of reporting “already on latest” when the connected instance cannot reach the update service, and keep About retry available after a failed check.

## [1.16.103] - 2026-08-01

- **Update service:** restore the EdgeOne transition feed for already-installed clients still pointed at `openchamber-update.edgeone.dev`, sharing the same stable release manifest and GitHub assets as Vercel.
- **Update service:** route EdgeOne desktop updater manifests through one dynamic handler so every `latest*.yml` path resolves without per-file edge routes.
- **Release CI:** keep TestFlight submission-limit deferrals from blocking GitHub Release finalize.
- **Sessions sidebar:** rename the sidebar new-conversation entry to “New chat” and wire it to the correct label key instead of the schedule copy.
- **Chat history:** batch-release the visible markdown hydration window in one commit so entering a session settles layout without remeasuring and re-anchoring the virtualizer once per turn.

## [1.16.102] - 2026-08-01

- **Assistants:** make cold-device conversation loading wait for session startup, retry transient OpenCode history failures, and skip deleted historical sessions while preserving mirrored messages.

## [1.16.101] - 2026-08-01

- **Release CI:** fix Vercel update-service deploy path so stable finalize no longer doubles `deploy/update-service` and fails production publish.

## [1.16.100] - 2026-08-01

- **Update service:** move the public auto-update API and desktop Electron updater feed from EdgeOne Pages to Vercel (`openchamber-update.vercel.app`), removing the EdgeOne project layout and fixing mainland check-update failures that returned HTTP 401.

## [1.16.99] - 2026-07-31

- **Message edit:** commit a staged edit before queue admission, so a resend routed through the queue (queued messages present, queue follow-up, or auto-review running) deletes the old turn first instead of landing as an extra message with a stale edit that could delete it on a later unrelated send.
- **Message edit:** treat the whole composer shell (attachment chips, input header, footer) as still inside the composer for blur disarming, so removing an attachment or opening a dropdown no longer cancels the edit.
- **Message edit:** keep the staged edit while a mobile chrome action (attach / agent / model picker) blurs the composer on purpose, matching the desktop send-button behavior.

## [1.16.98] - 2026-07-31

- **Message edit:** stop treating an empty composer as a cancel; a staged edit now releases only on the ✕, on leaving the session, or when focus moves out of the composer.
- **Message edit:** ignore the blurs that do not mean abandonment — a send in flight, focus landing on composer chrome such as attach / model / dictation, the mobile overlay and keyboard-restore windows, and the blur that precedes staging a different row.
- **Message edit:** re-focus the composer per edited row, so switching edit targets focuses again without stealing focus while typing.

## [1.16.97] - 2026-07-31

- **Message edit:** hold the staged edit while a send is in flight so the optimistic composer clear no longer disarms the edit it is submitting, which left the original message in place and stranded a permanent “editing…” shimmer.
- **Message edit:** always release the editing paint once the send settles, on the success, failure, and early-bail paths.
- **Message edit:** focus the composer when an edit arms, retrying on the next frame if the textarea is not mounted or still disabled yet.

## [1.16.96] - 2026-07-31

- **Message edit:** stop a forgotten staged edit from deleting history on the next ordinary send; cancel, clear the composer, or leave the session disarms it.
- **Message edit:** show a visible “edit pending” chip with cancel on the target user row before send, then a shimmer “editing…” label while the commit runs.
- **Message edit:** derive the delete range only from an authoritative server snapshot, keep deletes forward-only, and exclude in-flight optimistic send IDs so optimistic resend no longer wipes earlier turns.
- **Mobile sessions:** expose Rename from the session status-bar menus, and close the rename sheet as soon as smart-title is submitted instead of waiting for generation to finish.

## [1.16.95] - 2026-07-31

- **Desktop updates:** after discovering a pending package, auto-download only while the OS reports idle/locked (`powerMonitor`), sharing one in-flight download with the manual Download button so the two paths never race.
- **Desktop updates:** keep `downloaded` across hourly re-checks for the same version, and mirror main-process progress / ready events so the UI can flip to “Restart to Update” without a second click.
- **Desktop updates:** also probe on window focus (throttled to once per 20 minutes) while keeping the hourly visible-window baseline check.
- **Agent/model defaults:** remember the last explicit pick as one Project-scoped unit (agent + model + variant), with a global fallback, instead of a per-agent model map; migrate legacy `lastSelectedAgentName` / `agentModelSelections` on hydrate.
- **Session fork:** keep the fork loading shell session-scoped, only follow into the new chat when the user is still on the source/target, and skip restoring pending composer input after switching away mid-fork.

## [1.16.94] - 2026-07-31

- **Optimistic send:** paint the primary user row and sending state before async selection flush so ordinary sends feel immediate.
- **Message queue:** fire-and-forget queue admission with optimistic composer clear/restore, pending admission chips, and clearer in-flight send/queue button states.
- **New-session send:** centralize composer flight/establishing in a send manager so rapid follow-up sends stage “Queuing…” chips instead of opening extra sessions, then drain into the real session queue after create completes.
- **Composer send:** keep establishing pending-admission display snapshots referentially stable so sending a new-session message no longer trips Maximum update depth / getSnapshot loops in ChatInput.
- **Composer mentions:** share insertion-boundary helpers so inline file/agent references keep consistent spacing.
- **Composer citations:** strip the reserved icon well when matching image attachment filenames so Backspace removes the chip and attachment together.
- **Composer attachments:** clear inline image/code-selection citations in the same draft revision when removing an attachment, instead of hand-syncing textarea text after remove.
- **Queue chips:** decorate image/citation and mention tokens with the shared message reference chip so queued previews match sent-message styling instead of showing raw reserved-slot placeholders.
- **Mobile composer:** keep the collapsed pill non-scrollable so caret focus / swipe no longer pans long draft lines out of view.
- **Sessions sidebar:** keep the project display-mode menu beside the add-project action, and align “New Session” copy across mobile/desktop entry points.
- **Mobile share:** native Assistant shortcuts and iOS share suggestions use the Assistant display name and emoji/identicon avatar.
- **Git worktrees:** skip double-wrapping already-gated web/mobile discovery bridges so concurrent worktree listings no longer deadlock the discovery semaphore.
- **Branding:** use the dark OpenChamber mark for desktop production icons (without the PREVIEW badge), iOS AppIcon/splash, and Android launcher/splash assets.
- **Desktop branding:** force the macOS Icon Composer `AppIcon` (`Assets.car`) to the dark mark in light, dark, and tinted appearances so Dock no longer switches back to the light glyph.
- **Desktop packaging:** regenerate a multi-size Windows `icon.ico` (includes 256×256) so electron-builder packaging succeeds after the dark-logo refresh.
- **Android branding:** regenerate adaptive-icon cube-only foreground mipmaps and use a full-bleed dark gradient background drawable so launchers no longer stack a finished icon card over the adaptive background; render share-shortcut avatars on transparent canvases.
- **Visual settings:** stack chat rendering controls full-width for a cleaner settings layout.
- **Toolchain:** upgrade Vite 8 / `@vitejs/plugin-react` 6 with Rolldown Babel + React Compiler presets across web/vscode roots.
- **Release CI:** publish semver prereleases as GitHub prereleases and skip EdgeOne update-manifest publication; finalize publishes the existing draft by `release_id`; skip iOS/TestFlight builds for `-beta` tags.

## [1.16.94-beta.8] - 2026-07-31


- **Desktop branding:** force the macOS Icon Composer `AppIcon` (`Assets.car`) to the dark mark in light, dark, and tinted appearances so Dock no longer switches back to the light glyph.
- **Android branding:** regenerate adaptive-icon cube-only foreground mipmaps and use a full-bleed dark gradient background drawable so launchers no longer stack a finished icon card over the adaptive background.

## [1.16.94-beta.7] - 2026-07-31

- **Queue chips:** decorate image/citation and mention tokens with the shared message reference chip so queued previews match sent-message styling instead of showing raw reserved-slot placeholders.
- **Mobile composer:** keep the collapsed pill non-scrollable so caret focus / swipe no longer pans long draft lines out of view.
- **Git worktrees:** skip double-wrapping already-gated web/mobile discovery bridges so concurrent worktree listings no longer deadlock the discovery semaphore.
- **Mobile branding:** use a full-bleed dark Android adaptive-icon background with the transparent vector foreground mark, and render share-shortcut avatars on transparent canvases.
- **Visual settings:** stack chat rendering controls full-width for a cleaner settings layout.
- **Toolchain:** upgrade Vite 8 / `@vitejs/plugin-react` 6 with Rolldown Babel + React Compiler presets across web/vscode roots.

## [1.16.94-beta.6] - 2026-07-31

- **Composer send:** keep establishing pending-admission display snapshots referentially stable so sending a new-session message no longer trips Maximum update depth / getSnapshot loops in ChatInput.
- **Release CI:** finalize publishes the existing draft by `release_id` instead of recreating a release by tag, which was leaving empty published releases and failing with `tag_name already_exists`.

## [1.16.94-beta.5] - 2026-07-31

- **Desktop packaging:** regenerate a multi-size Windows `icon.ico` (includes 256×256) so electron-builder packaging succeeds after the dark-logo refresh.
- **Composer attachments:** clear inline image/code-selection citations in the same draft revision when removing an attachment, instead of hand-syncing textarea text after remove.

## [1.16.94-beta.4] - 2026-07-31

- **Mobile share:** native Assistant shortcuts and iOS share suggestions use the Assistant display name and emoji/identicon avatar.
- **Composer citations:** strip the reserved icon well when matching image attachment filenames so Backspace removes the chip and attachment together.

## [1.16.94-beta.3] - 2026-07-31

- **Branding:** use the dark OpenChamber mark for desktop production icons (without the PREVIEW badge), iOS AppIcon/splash, and Android launcher/splash assets.

## [1.16.94-beta.2] - 2026-07-31

- **New-session send:** centralize composer flight/establishing in a send manager so rapid follow-up sends stage “Queuing…” chips instead of opening extra sessions, then drain into the real session queue after create completes.
- **Release CI:** publish semver prereleases (e.g. `-beta`) as GitHub prereleases and skip EdgeOne update-manifest publication so stable auto-update stays on the newest non-prerelease release.
- **Sessions sidebar:** keep the project display-mode menu beside the add-project action, and align “New Session” copy across mobile/desktop entry points.

## [1.16.94-beta.1] - 2026-07-31

- **Optimistic send:** paint the primary user row and sending state before async selection flush so ordinary sends feel immediate.
- **Message queue:** fire-and-forget queue admission with optimistic composer clear/restore, pending admission chips, and clearer in-flight send/queue button states.
- **Composer mentions:** share insertion-boundary helpers so inline file/agent references keep consistent spacing.
- **Release CI:** skip iOS/TestFlight builds for `-beta` tags because Apple marketing versions cannot include prerelease suffixes.

## [1.16.93] - 2026-07-30

- **Desktop updates:** check the EdgeOne update service at startup and hourly while the packaged app is visible.
- **Android updates:** hand APK downloads to the configured system browser for download and installation.
- **Mobile composer:** stabilize Android keyboard lift and composer focus across model selection, and show a live dictation waveform.

## [1.16.92] - 2026-07-30

- **Mobile composer:** scroll long drafts within the input field after the compact composer expands.

## [1.16.91] - 2026-07-30

- **iOS external TestFlight:** use supported App Store Connect build fields and relationship operations when associating processed builds with the external beta group and submitting Beta App Review.

## [1.16.90] - 2026-07-30

- **iOS external TestFlight:** publish every uploaded iOS build to the fixed external beta group, submit it for Beta App Review, and keep the public TestFlight link serving the newest approved build.

## [1.16.89] - 2026-07-30

- **Mobile About:** show the installed native client version separately from the connected OpenChamber and OpenCode instance versions, and use the native version for mobile update checks.

## [1.16.88] - 2026-07-30

- **Chat delivery:** clear direct Composer messages before asynchronous dispatch, prevent duplicate submits across buttons, keyboard shortcuts, presets, dictation, primary chat, and Assistants, and retain failed drafts for retry.

## [1.16.87] - 2026-07-30

- **Relay messaging:** show an optimistic user message immediately and display a highlighted sending status until the prompt request settles.
- **Filesystem API:** centralize outside-file grant validation and simplify route coverage for read-only file access.

## [1.16.86] - 2026-07-30

- **macOS signed desktop:** give Electron helper processes their own hardened-runtime JIT entitlements so notarized DMGs no longer crash in `OpenChamber Helper (Renderer)` during V8 startup.
- **Desktop updates:** allow the packaged UI to check, download, and apply desktop updates independently of the active OpenChamber host connection, while still keeping generic remote `desktop_restart` blocked.
- **Relay Docker:** build `linux/amd64` and `linux/arm64` images natively in parallel, then merge digests into the multi-arch `:version` and `:latest` manifests.

## [1.16.85] - 2026-07-29

- **Desktop stability:** update Electron to 41.10.3, restoring Renderer startup on macOS 26.5.2 Apple Silicon systems.
- **Release automation:** publish macOS arm64, Windows, Linux, Android, iOS TestFlight, and Relay artifacts without building or attaching a VS Code extension package.

## [1.16.84] - 2026-07-29

- **Desktop updates:** deliver signed macOS ZIP updates through the same in-app Electron updater flow as Windows and Linux, with download and restart-to-install support.
- **Release automation:** install notarization credentials only in macOS jobs so VS Code builds remain platform-independent and macOS packaging can notarize correctly.

## [1.16.83] - 2026-07-29

- **Apple release signing:** configure Developer ID signing and notarization for macOS desktop builds, and App Store distribution signing for iOS TestFlight (main app, Widget, Notification Service, Share Extension).
- **iOS App Group:** link `group.com.yee94.openchamber` across all App Store targets and regenerate provisioning profiles so archive and export succeed.
- **iOS App Store upload:** declare the full iPad interface orientation set required for multitasking review.
- **Release pipeline:** include iOS TestFlight upload in the formal GitHub Release workflow alongside desktop, Android, VS Code, and Relay.

## [1.16.82] - 2026-07-29

- **Session status:** release stale project loading indicators when a newer session-index batch replaces completion metadata, and keep mobile project cards aligned with the recent-session list after a session finishes.
- **Mobile worktrees:** present the new-worktree flow in a resizable, scrollable sheet with a fixed action area.

## [1.16.81] - 2026-07-29

- **Relay pairing:** allow the local Desktop shell (`desktop-local`) to set a custom Host Relay endpoint when creating pairing sessions; remote client tokens stay blocked.
- **Mobile Settings:** keep Settings detail pages as a quiet transparent canvas so only group cards own material, including Android solid chrome.

## [1.16.80] - 2026-07-29

- **Mobile instances:** make the whole instance row a switch target while edit/delete actions keep their own hit areas.

## [1.16.79] - 2026-07-29

- **Relay pairing:** choose official or custom `ws://` / `wss://` Relay endpoints when creating device QR codes, pin server-side endpoints with `OPENCHAMBER_RELAY_URL`, and remember the endpoint from scanned pairing payloads.
- **Relay packaging:** publish Relay Docker images on release, document remote `docker-compose` deployment, and keep repository artifacts free of personal domains or machine paths.
- **Session message pages:** use one 30-message page size for bootstrap, history, recovery, and materialization on every surface, including private Relay tunnels.
- **Mobile composer keyboard:** only the bottom chat composer arms keyboard lift; question cards and other fields no longer move chrome.
- **Draft branch picker:** keep branch lists scoped to the project root so switching worktrees does not drop a warm list while git probes settle.
- **Desktop Preview:** share the machine OpenCode config and session store with release/CLI while still isolating OpenChamber app data.

## [1.16.78-beta.1] - 2026-07-29

- **Message queue:** start manual-dispatch probes before long reconciliation reads, treat accepted rows as explicit reconciliation work, and keep queue chips stable while authoritative revisions catch up.
- **OpenCode events and session status:** normalize current event envelopes, use `v2.session.active` membership with a three-state capability probe, and reconcile live busy/retry/idle status per directory.
- **Session index and worktrees:** retain empty synced directories for cross-client topology recovery, retry transient session-index refreshes without clearing useful projections, and release only observer-owned loading state after failures.
- **Worktree creation:** recover a successful Git worktree creation when message-queue activation remains pending through a scoped, bounded repair flow.
- **Desktop and mobile:** show a runtime-switch overlay until Desktop reconnection is ready, improve host status fidelity, prevent touch-scroll file mentions from selecting rows, and load relay file images through authenticated blobs.
- **Agent settings:** save only edited fields so unrelated changes retain existing model and permission configuration.
- **Android:** reduce streaming rendering and haptic frequency, replace persistent glass blur with solid semantic surfaces, and remove workstation-specific Buildship JDK and JDTLS paths.

## [1.16.77] - 2026-07-28

- **Session merge:** centralize session message page merge strategy so the loader, reducer, and materialization share one `(purpose, stale)` resolution instead of diverging rules.
- **Reconnect recovery:** stale recovery pages backfill missing messages without overwriting newer live message objects.
- **Message loading:** route initial and history loads through the shared session-message loader instead of duplicate fetch paths.

## [1.16.76] - 2026-07-28

- **File links:** detect binary files across Web, VS Code, and Desktop, open them with the system default app on desktop, and skip non-image binary references on mobile.
- **Model picker:** keep search-time section collapse independent from browse mode so filtering no longer fights your saved section layout.
- **Reconnect recovery:** allow recovery pulls to apply stale revision pages and reconcile active session status after the transcript tail reloads.

## [1.16.75] - 2026-07-28

- **Mobile file preview:** open Read/Skill and chat file links in a gesture resizable sheet on phone, with direct-preview back dismiss and iPad still using the right Files panel.
- **Refresh transcript:** add a mobile overflow Refresh action that clears prefetch and re-materializes the current session tail from the server.
- **Reconnect recovery:** gate session identity and message body on separate live revisions so a streaming session can still recover its transcript after `session.get`.
- **Tool rows:** make Read/Skill tool rows full-width navigation hotspots and route mobile opens through the shared file preview path.
- **Android debug:** give debug builds a separate applicationId and app name so local installs no longer replace release packages.

## [1.16.74] - 2026-07-28

- **Session completion:** reconcile active session status from authoritative, runtime-scoped snapshots after reconnects and message pulls, keeping busy, retry, and idle indicators current.
- **Conversation refresh:** reload dirty session tails after live updates and materialize completed reasoning and text fields when an active session becomes idle.
- **Mobile new sessions:** present project and branch selection in resizable sheets, tighten selector chips, and unify bottom safe-area treatment across sheets and action surfaces.
- **Mobile composer:** keep Android keyboard transitions in sync with shorter open/close motion, and preserve follow-up send or steer controls above busy composer surfaces.
- **Release assets:** remove retired Electron icon backup files from the package resources.

## [1.16.73] - 2026-07-27

- **Smart session titles:** add a shared `requestSessionSmartTitle` action and expose AI title generation from mobile session rename dialogs on Projects home and the sessions sheet.
- **Desktop rename:** route sidebar smart-title requests through the same action so live session stores stay consistent after regeneration.

## [1.16.72] - 2026-07-27

- **Assistant delete:** long-press or context-menu Delete on desktop and mobile assistant lists opens a confirmation dialog, removes the assistant, and clears a matching default share target.
- **Assistant settings:** enlarge the default-prompt textarea so longer system prompts are easier to edit.

## [1.16.71] - 2026-07-27

- **Desktop header:** move Switch instance into the session ··· menu and anchor the instance/usage panel to that control, removing the standalone stack trigger.

## [1.16.70] - 2026-07-27

- **Search ranking:** rank command, skill, snippet, agent, and branch pickers by relevance (exact → prefix → boundary → fuzzy) so exact hits like `origin/master` stay on top.
- **Queue edit focus:** restore composer focus after editing a queued message so desktop and mobile can keep typing immediately.
- **Grok usage:** map SuperGrok unified weekly credits correctly, surface prepaid Extra Credits as a separate balance window, and avoid falling back to monthly billing when weekly data is present.

## [1.16.69] - 2026-07-27

- **Grok quota renewal:** automatically renew expired Grok Build CLI access tokens when fetching xAI usage on Web and VS Code, with clearer renewal failure messaging.
- **Mobile assistants:** long-press an assistant in the list to open Edit and jump straight into that assistant’s settings detail page.
- **Mobile sessions:** wire phone session and draft open actions through the secondary navigation stack so + and history rows land on the correct chat route.
- **Mobile worktrees:** force-refresh the project worktree catalog on connect and when the sessions sheet opens, matching desktop topology without wiping known entries on partial failure.
- **Desktop header:** rename Services to Switch instance and surface View usage from the session menu for clearer instance switching.
- **Message queue:** strengthen server-runtime queue handling with additional regression coverage.

## [1.16.68] - 2026-07-26

- **Mobile chat navigation:** add animated, multi-level phone session navigation so child-agent conversations retain an interactive parent-page history.
- **iOS responsiveness:** start Composer keyboard motion before UIKit presentation, calibrate it from native keyboard measurements, and use high-refresh edge-back progress with velocity-aware settling.
- **Android chrome:** keep the gesture navigation bar hidden across focus and keyboard transitions for a cleaner edge-to-edge chat surface.

## [1.16.67] - 2026-07-26

- **Android sharing:** raise native Assistant share attachment capacity to 20 MiB and align the Composer handoff validation with the native draft limit.
- **Share recovery:** record privacy-safe Android draft preparation failure categories, improving diagnosis without exposing shared text, URIs, or image metadata.

## [1.16.66] - 2026-07-26

- **Session startup:** cache validated session-index snapshots by runtime identity and paint the cached sidebar state immediately during cold starts.
- **Session refresh:** move session-index snapshot reads into TanStack Query with transport-scoped keys, shared in-flight fetches, and abort-signal propagation.
- **Session resilience:** retain the cached startup projection through transient refresh failures, then reconcile it with the next authoritative live snapshot.

## [1.16.65] - 2026-07-26

- **Mobile pickers:** keep model and agent searches pinned above bounded, scrollable result lists, preserving reliable keyboard focus and touch input in Android WebView.
- **Mobile sheets:** strengthen sheet scrolling, focus handling, and dismiss-gesture ownership so search fields and compact action sheets remain responsive during touch interaction.
- **Mobile projects:** streamline main-workspace session presentation beneath the project header and preserve covered layout behavior with focused regression coverage.
- **Message queue:** preserve committed queue mutations across reconciliation so completed operations retain their authoritative state.

## [1.16.64] - 2026-07-26

- **Android keyboard:** add native IME inset sync so the mobile composer and chat layout track soft-keyboard open/close more reliably across Android WebView surfaces.
- **Assistant staged edits:** support continuous staged sent-message edits with CAS rollback, exclusive scope cleanup, and safer draft restoration when assistant bindings or transports change.
- **Assistant drafts:** preserve draft attachments across restore and staged-edit flows so shared and secondary assistant composers keep media with the draft body.
- **Composer recovery:** strengthen input-surface recovery, queue admission, and message-composer restoration so interrupted or remounted chat surfaces rehydrate drafts without dropping queued work.
- **Mobile sessions:** refine session list pagination, project search, and mobile chat chrome for smoother project-home and history navigation.
- **Message queue:** tighten server-edit bridge and shadow-import paths so queue status and edit handoffs stay consistent across client and server runtimes.

## [1.16.63] - 2026-07-25

- **Grok quota:** add Grok Build credit and billing-window usage across Web, VS Code, and shared quota surfaces, using local Grok CLI authentication.
- **File references:** detect extension-bearing project paths in ordinary assistant prose and make file links open directly in the mobile Files preview.
- **Mobile history:** hand virtualized history-prepend anchoring to TanStack Virtual while preserving exact compensation for non-virtualized lists, improving scroll stability during older-message loads.
- **Mobile autocomplete:** cap command, skill, and file suggestion panels at 40% of the visual viewport so long lists remain scrollable without covering the conversation.
- **Message queue:** strengthen server-runtime dependency wiring and production cutover coverage for more reliable queue status and snapshot hydration.
- **Mobile polish:** refine queued-message controls, timeline caching, and responsive chat layout behavior.

## [1.16.62] - 2026-07-25
