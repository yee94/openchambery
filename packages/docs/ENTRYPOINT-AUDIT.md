# Handbook entry-point audit

Reviewed 2026-10-26 against the current local working tree. This is a content audit,
not a product feature change. The active English and Chinese editions were rewritten
from the reachable user tasks; historical translations remain unpublished archives.

## Admission rule

A feature belongs in the handbook only when a visible entry can reach its mounted
implementation under a stated platform/capability configuration, or when it is an
explicitly identified operator/CLI procedure. A source file, backend endpoint,
translation or screenshot is insufficient on its own.

This review traces source paths and gates. It does not claim a live Electron,
VS Code, physical-phone, provider, SSH or Relay end-to-end test. The local handbook
is separately built and checked for rendering, links and navigation.

## Removed promises and corrected boundaries

| Former claim | Disposition | Evidence |
| --- | --- | --- |
| User-managed project notes, todos and saved plans in Context | Removed from project guide; old route retained only as a retired redirect | `packages/ui/src/components/layout/ContextSidebarTab.tsx:486-563` renders usage; `packages/ui/src/components/layout/ContextPanel.tsx:2687-2688` mounts it. No project-note/todo/plan editor is mounted. |
| Todos can be edited and sent to a new worktree | Removed; Agent todo display described separately | `packages/ui/src/components/chat/ChatInput.tsx:7509-7520` and `packages/ui/src/components/chat/message/toolRenderers.tsx:402-419` consume Agent task state. |
| Desktop/Web sidebar starts multi-run | Replaced by VS Code Agent Manager instructions | `packages/ui/src/components/session/sidebar/SidebarHeader.tsx:16-20` records removed toolbar; `openMultiRunLauncher` has no production caller. `packages/vscode/package.json:91-96`, `packages/vscode/src/extension.ts:250-254`, `packages/ui/src/components/views/agent-manager/AgentManagerView.tsx:97-130` provide the live VS Code path. |
| Git PR tab creates, updates and merges PRs | Removed | `packages/ui/src/components/views/git/PullRequestSection.tsx` contains operations but has no mounting import. Existing GitHub context pickers and status links remain reachable. |
| Worktree Integrate panel | Removed | `packages/ui/src/components/views/git/IntegrateCommitsSection.tsx` and `packages/ui/src/components/views/git/BranchIntegrationSection.tsx` are unmounted. |
| Permanent target button opens a goal editor | Replaced by `/goal` → editable objective → send | `packages/ui/src/components/chat/ChatInput.tsx:3982-3993`; `packages/ui/src/components/chat/SessionGoalButton.tsx:19-35,61-75` is a conditional removal chip, not a launcher. |
| Agent temperature editor | Removed | `packages/ui/src/components/sections/agents/AgentsPage.tsx:699-842` exposes mode, description, model/variant and prompt; no temperature control. |
| Separate snippet manager | Removed from navigation and prose | Mounted `packages/ui/src/components/sections/commands/CommandsPage.tsx:210-323` is a command-template editor; no separate snippet manager is registered. |
| Skills Catalog is a tab available everywhere | Corrected to a separate settings page, excluded from dedicated mobile navigation | `packages/ui/src/components/views/SettingsView.tsx:1102-1105`; `packages/ui/src/lib/settings/metadata.ts:84-106`; `packages/ui/src/components/sections/skills/SkillsPage.tsx:53-55`. |
| Planning group in Magic Prompts | Removed | `packages/ui/src/components/sections/magic-prompts/MagicPromptsSidebar.tsx:16-51` lists Git, GitHub and Session. |
| Universal notification template/length controls | Restricted to the actual surfaces; length control removed | `packages/ui/src/components/sections/yuri/NotificationSettings.tsx:498,578-665` hides foreground/template controls in native apps; no UI `maxLastMessageLength` editor. |
| Settings → Yuri → Passkeys | Corrected to Sessions → Passkeys | `packages/ui/src/components/sections/yuri/YuriPage.tsx:106-107,203-230` mounts the group in Sessions. |
| Browser is a permanent header globe button | Corrected to the session-menu action | `packages/ui/src/components/layout/Header.tsx:1827-1836`; `packages/ui/src/components/layout/ContextPanel.tsx:2712-2717` selects native vs proxy rendering. |

## Retained task map

The following index uses component basenames for brevity. Settings components
live under `packages/ui/src/components/sections/<section>/`, layout components
under `components/layout/`, and session/chat components under their named groups.
`SettingsView.tsx` lives under `components/views/`; `metadata.ts` is
`packages/ui/src/lib/settings/metadata.ts`. Fully qualified paths are repository-relative.

| Handbook topics | Reachable entry / checked contract |
| --- | --- |
| Overview, installation, first request | Project navigation and provider setup below; desktop lifecycle `packages/electron/README.md` and `main.mjs`; CLI `packages/web/bin/lib/commands-serve.js`; mobile `apps/MobileConnectionWelcome.tsx`. |
| Projects | `SettingsView.tsx:1078` → `ProjectsPage`; `sections/projects/ProjectSettingsPanel.tsx:55-57` mounts identity, actions and worktree configuration. VS Code excludes Projects in settings metadata. |
| Assistants | `SessionSidebar.tsx:824-826` opens contacts; `sections/assistants/AssistantsSettingsPage.tsx:580,621-703` gates capability and renders name, prompt, model, workspace and save. |
| Context | `Header.tsx:1966-1978` usage control; `ui/CommandPalette.tsx:284-289`; usage-only `ContextSidebarTab.tsx`. |
| Project actions | Project settings above; `Header.tsx:2093-2101` mounts `ProjectActionsButton`; active session/worktree supplies the execution directory. |
| Git and GitHub context | `layout/RightSidebarTabs.tsx:113-129` and `views/GitView.tsx`; `ChatInput.tsx:861-876,8105-8128` attaches existing issues/PRs. GitHub auth lives in `sections/git-identities/GitPage.tsx:122`. |
| Worktrees | `session/sidebar/sortableItems.tsx:252-265` gated project-row button, `CommandPalette.tsx:222-230`, `apps/MobileSessionsSheet.tsx:1298-1310`, `DraftSessionBranchSelector.tsx:273-285`. |
| Preview | `views/TerminalView.tsx:1221-1236` and `ProjectActionsButton.tsx:760,862`; loopback-only inspect/console controls in `ContextPanel.tsx:1177-1205` wait for bridge readiness. |
| Session goals | `/goal` handler above, `SessionGoalRow.tsx:68-151` status/pause/resume; `useSessionGoal.ts:18` reads Chat setting; VS Code gate in `SessionGoalButton.tsx:33`. |
| Scheduled tasks | `SessionSidebar.tsx:810-816` opens desktop workspace; `apps/MobileApp.tsx:2997` mounts mobile tab; `ScheduledTasksDialog.tsx:1051-1073` creation requires a project; `ScheduledTaskEditorDialog.tsx:610-652` validates timezone and previews runs. |
| Providers / Agents | `SettingsView.tsx:1084,1106-1107`; `ProvidersPage.tsx:535-750` authentication; `AgentsPage.tsx:845-1052` permission rules and advanced editor. |
| MCP | `SettingsView.tsx:1096-1097`; `McpPage.tsx:1377-1422,1526-1859` connection, test, transport and auth configuration. |
| Skills | `SettingsView.tsx:1102-1105`; installed editor `SkillsPage.tsx:546-710`; `FileMentionAutocomplete.tsx:121-183,411-414` and `ChatInput.tsx:5702-5734` provide `@` Skill selection. |
| Commands | `SettingsView.tsx:1094-1095`; `CommandsPage.tsx:210-323`; slash trigger `lib/composer-autocomplete/trigger.ts:33-49`. |
| Themes | `YuriPage.tsx:102-103,151-164`; `YuriVisualSettings.tsx:621,778-886` gates VS Code and exposes Appearance → Theme → Reload. Host directory owner: `packages/web/server/index.js:263-266`. |
| Notifications | `SettingsView.tsx:1132`; `YuriPage.tsx:116-117`; `NotificationSettings.tsx:485-665` event and delivery controls with platform branches. |
| Magic Prompts | `SettingsView.tsx:1121-1122`; `MagicPromptsPage.tsx:305-394`; `lib/settings/metadata.ts:286-291` excludes VS Code. |
| Git identities | `SettingsView.tsx:1123-1124` → `GitPage`; `metadata.ts:235-241` excludes VS Code, including direct navigation through `SettingsView.tsx:1069-1072`. |
| Usage | `SettingsView.tsx:1108-1109`; `UsageSidebar.tsx:89-156`, `UsagePage.tsx:174-385`; header consumption in `Header.tsx:700,979`. No unverified provider support list is retained. |
| Device pairing / SSH / Relay | `sections/remote-instances/RemoteInstancesPage.tsx:1076` gates SSH management on desktop bridge; `:2236-2247` gates client actions; `:1622-1648` uses available transports. Dedicated mobile settings omit this editor and expose instance switching. CLI Relay-only behavior: `packages/web/bin/lib/commands-connect-url.js` and its module documentation. |
| Mobile | `apps/MobileApp.tsx` mounts Projects, Assistants, Schedule and Settings; `mobile/settings/MobileSettingsTab.tsx:27-37` applies the mobile settings allowlist. Native sharing and system integration owners are recorded in `packages/mobile/README.md`. |
| Voice | `metadata.ts:295` excludes VS Code; `sections/yuri/VoiceSettings.tsx:417-443` edits host speech settings; `dictation/HoldToTalkComposer.tsx:79-117` chooses release intent; `DesktopDictationButton.tsx:155-209` finishes/cancels recording. |
| Updates | `metadata.ts:296` exposes About on desktop/mobile; `AboutSettings.tsx:135-177,229` separates channels and versions. Installer/OTA ownership: `packages/electron/README.md` and `packages/mobile/README.md`. |
| Security | Client revocation in Remote Instances; `YuriPage.tsx:203-230` and `PasskeySettings.tsx:175-199`; auth owner `packages/web/server/lib/ui-auth/ui-auth.js`. |
| Host CLI / environment | `packages/web/bin/lib/commands-{serve,status,logs,lifecycle,startup}.js`; `packages/web/server/lib/opencode/{env-config,env-runtime,cli-options,server-startup-runtime}.js`; `terminal/runtime.js`. Removed outdated Bun-daemon configuration advice. |
| Reverse proxy / troubleshooting | Operator procedures, not UI features. `packages/web/server/lib/realtime-proxy.js:4-17`, `terminal/terminal-ws-protocol.js`, event-stream and dictation runtime owners identify long-lived traffic. No copied deployment templates or obsolete fixed-version recovery instructions retained. |

## Editorial result

All 36 English articles and their 36 Chinese counterparts received new task-based
outlines and prose. Stable paths, exact commands and necessary UI labels remain.
The six route aliases per language are not feature guides. In particular,
`notes-todos-plans` is a retired route, not a claim that notes were moved elsewhere.

## Magpie follow-up

Added a bilingual guide and links from provider, usage and SSH instructions.

- Usage entry: `packages/ui/src/components/sections/usage/UsageSidebar.tsx:156`
  mounts `MagpieConnection`; its `:24-55` save handler and disclosure expose an
  optional gateway URL. Host discovery, authorization, stale readings and runtime
  coverage are owned by `packages/web/server/lib/quota/DOCUMENTATION.md:37-84`.
- Transfer entry: `packages/ui/src/components/sections/remote-instances/RemoteInstancesPage.tsx:552-564`
  conditionally renders the unchecked Magpie selection. `:2567-2576` exposes SSH
  config sync only for ready managed connections. Source discovery, destination
  CLI installation, recognized account transfer and partial results are owned by
  `packages/web/server/lib/config-sync/DOCUMENTATION.md:84-100`.
- Extension boundary: `packages/ui/src/components/sections/plugins/PluginsSidebar.tsx`
  and `PluginsPage.tsx` manage OpenCode runtime extensions. They are not a Magpie
  plugin installation UI. Magpie's own setup and plugin workflows were checked
  against its official documentation at `https://usemagpie.ai/docs/start` and
  `https://usemagpie.ai/docs/plugins` through Context7 `/yetone/magpie`.
- No Magpie browser-provider integration is claimed merely because Yuri has a
  generic browser-provider contract. No unverified extension package installation
  command or fixed model identifier is introduced.

The handbook now contains 37 articles per active language. This follow-up is a
documentation change; no model call, account transfer or remote installation was
performed as part of verification.
