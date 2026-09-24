# Work-status column

A short column beside the transcript. It is not a card and not a context-panel
surface. It occupies its final width as soon as a session is selected or the
first-prompt draft enters its establishing/submitting transcript state. Message
loading does not gate the column. Idle welcome drafts keep it hidden, as do an
open right sidebar or context panel.

Rows stay one line: project, current branch, secondary worktree name, and working
tree changes. Every row shares the same leading-icon and text alignment; there
are no section headers, cards, or duplicate Browser /
Terminal / Files shortcuts. Long names truncate and expose their full value/path
on hover. Project, branch, worktree, and changes consume the shared `folder`,
`git-branch`, `node-tree`, and `changes` sprites, with rounded geometry from
`scripts/icon-name-map.mjs`. Worktree shares its glyph with the left sidebar.
All four status-column icons use medium stroke without extra opacity reduction. Context usage, MCP,
and skills are not shown here. Subagents use a collapsed disclosure row matching
the chat activity header: up to three tightly stacked `AgentAvatar` faces, a
localized working and completed counts (including zero), and a chevron. Expanding
groups agents by state, working first, omitting empty groups. Group headings show
their counts; spaced, borderless agent rows do not repeat the status. Rows with an authoritative
child session ID open that session in the context panel; unresolved rows remain
disabled rather than guessing a navigation target. Faces come
from loaded parent-transcript `task` / `subagent` tool parts and native `subtask`
parts, seeded by part id, plus direct child sessions that those parts do not
already link. A pending or running tool part is working. A busy or retrying
child session stays working after its parent tool part completes. Completed
faces stay in the disclosure. Hover and accessible labels identify each face. The column
reads the transcript already loaded for the session and the displayed
directory's `session_status`. It does not fetch child messages.

Changes uses a vertical plus/minus glyph and opens the Git sidebar. The branch
and worktree copy buttons, and the changes row, use the hand cursor. The
desktop shell otherwise draws an arrow on buttons; these controls keep the
hand through `.oc-work-status-action`. Project, branch, and worktree text stay
the arrow. Branch and worktree rows each reveal a copy button on hover or keyboard focus,
immediately after the name. Branch copies the branch name; worktree copies the
full worktree path. Both use the shared clipboard helper and briefly show a
check only on success. Hovering the branch glyph shows the current-branch
label, and hovering the worktree glyph shows the worktree label. Each button
keeps its layout slot so revealing it does not shift the name.

Project ownership uses `resolveProjectForSessionDirectory`, as upstream does,
including worktrees outside the project root. Session-attached worktree metadata
must match the displayed directory; otherwise use the owning project's discovered
worktrees. Only secondary worktrees get a separate row. Branch and diff totals
come from this fork's shared `useGitStore` (its diff stats are flat per-file, unlike
upstream's staged/working maps). ChatInput already owns live Git refresh hints;
this column only ensures the shared snapshot on mount and adds no polling.
Changes opens the Git sidebar. Branch does not navigate.
Layout exclusion applies to both inline and overlay modes, scoped to the displayed
directory, without mutating the saved visibility preference.

Width is fixed at 196px. Inline display requires a window viewport of at least
1440px, evaluated on the first render with `useMediaQuery`; it does not wait for
chat-area measurements. Inline width and margins do not animate, so entering
chat and crossing the breakpoint do not repeatedly reflow the transcript.
Narrow windows retain the manually opened overlay with opacity/transform
transitions. Mobile and VS Code keep the column disabled.
The header toggle uses `settings-2`.
