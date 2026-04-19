# Task 008 — Frontend Shell Redesign

## Context

Task 001-007 produced a correct backend and a bag of feature components
on the frontend. This task weaves the components into a single
production-grade Discord-style shell: one mounted React tree across the
whole app, with URL reflecting state rather than driving page transitions.
Design-system tokens, dark mode, accessibility, bundle budgets, and a
central realtime dispatcher come with it.

No new backend features. A handful of unused fields in UI were cleaned
up; every existing integration/E2E contract is preserved.

## Scope (IN)

- **3-column Shell** at `apps/web/src/shell/` — WorkspaceNav /
  ChannelColumn / MessageColumn / MemberColumn + BottomBar.
- **Design system** at `apps/web/src/design-system/` — tokens
  (colors/spacing/radius/shadows/typography/motion/z-index), light/dark
  theme with `prefers-color-scheme` + `localStorage`, primitive
  components on Radix.
- **Central realtime dispatcher** — `features/realtime/dispatcher.ts` is
  the ONLY file that listens to socket events for cache mutations.
- **React Query key registry** at `lib/query-keys.ts`.
- **Zustand stores** for UI state (sidebar/modal), composer drafts,
  toast queue.
- **Keyboard shortcuts** — Ctrl+K palette, Ctrl+/ help, Alt+↑/↓ channel
  cycle, Ctrl+Shift+A workspace cycle, Escape.
- **Accessibility baseline** — focus rings, ARIA on every icon button,
  axe scans on 3 primary screens, reduced-motion respect.
- **Bundle budgets** — code-split lazy auth/workspace-create/invite
  pages + manual vendor chunks enforced by `size-limit`.

## Scope (OUT) — future tasks

- New domain features (search, reactions, mentions notifications,
  attachments, i18n) — TODO(task-009+).
- Service Worker / PWA — TODO(task-022).
- Schema-per-worker Playwright — already deferred to task-018.
- Full settings page (`/settings`, `/w/:wsSlug/settings`) — scaffolded
  in `useUI` store but not rendered.

## File Inventory → Target Mapping

| Before                                        | After                                                                                                       | Notes                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `App.tsx` (inline HomePage)                   | `App.tsx` (Router + lazy)                                                                                   | HomePage deleted; home redirects via Shell |
| `main.tsx`                                    | `main.tsx`                                                                                                  | unchanged                                  |
| `index.css`                                   | `index.css`                                                                                                 | + CSS vars for tokens                      |
| `features/workspaces/WorkspaceLayout.tsx`     | **deleted** → `shell/Shell.tsx` + `shell/ChannelColumn.tsx` + `shell/MemberColumn.tsx`                      | decomposed                                 |
| `features/channels/ChannelSidebar.tsx`        | **deleted** → `features/channels/ChannelList.tsx` + `shell/ChannelColumn.tsx`                               | split frame vs list                        |
| `features/messages/MessagePanel.tsx`          | **deleted** → `shell/MessageColumn.tsx` + `features/messages/{MessageList,MessageComposer,MessageItem}.tsx` | split                                      |
| `features/realtime/useLiveMessages.ts`        | **deprecated, kept as no-op**                                                                               | replaced by centralized `dispatcher.ts`    |
| `features/realtime/useRealtimeConnection.ts`  | same path                                                                                                   | installs the dispatcher once               |
| `features/channels/useChannels.ts`            | same path                                                                                                   | unchanged                                  |
| `features/messages/useMessages.ts`            | same path                                                                                                   | unchanged                                  |
| `features/messages/api.ts`                    | same path                                                                                                   | unchanged                                  |
| `features/workspaces/api.ts`                  | same path                                                                                                   | unchanged                                  |
| `features/workspaces/useWorkspaces.ts`        | same path                                                                                                   | unchanged                                  |
| `features/workspaces/CreateWorkspacePage.tsx` | same path                                                                                                   | unchanged (lazy-loaded now)                |
| `features/workspaces/InviteAcceptPage.tsx`    | same path                                                                                                   | unchanged (lazy)                           |
| `features/auth/*`                             | same path                                                                                                   | unchanged (lazy)                           |
| `lib/api.ts`, `lib/socket.ts`                 | same path                                                                                                   | unchanged                                  |
| (new) `design-system/`                        | —                                                                                                           | tokens + theme + primitives                |
| (new) `shell/`                                | —                                                                                                           | 3-column layout                            |
| (new) `stores/`                               | —                                                                                                           | zustand state                              |
| (new) `lib/query-keys.ts`                     | —                                                                                                           | key registry                               |
| (new) `lib/cn.ts`                             | —                                                                                                           | class-name helper                          |
| (new) `features/realtime/dispatcher.ts`       | —                                                                                                           | central socket → cache                     |
| (new) `features/shortcuts/`                   | —                                                                                                           | palette + help + bindings                  |

No orphaned files. Old files were deleted in the commit that migrated
their content.

## Design Tokens

Full catalog at `apps/web/src/design-system/tokens/`. Semantic names only
in component code — primitive hex / HSL values live only inside
`tokens/colors.ts`. ThemeProvider writes CSS vars at document root so a
Tailwind class like `bg-bg-subtle` resolves through `hsl(var(--bg-subtle))`.

Dark mode: `prefers-color-scheme` on first visit → `localStorage` once
the user flips the toggle. Honoured by a `data-theme="light|dark"`
attribute on `<html>` which Tailwind's `darkMode: ['selector',
'[data-theme="dark"]']` respects for variant classes.

## Layout

```
┌──────┬──────────────┬────────────────────────┬──────────────┐
│ WS   │ Channel Col  │ Message Column         │ Member Col   │
│ Nav  │  240px       │  flex                  │  240px       │
│ 72px │              │                        │  (toggle)    │
└──────┴──────────────┴────────────────────────┴──────────────┘
│ BottomBar — avatar + status + theme + help + logout (40px)  │
```

## Accessibility Checklist (status)

- [x] Focus rings visible via `focus-visible` on every interactive element
- [x] Radix Dialog / DropdownMenu give us focus trap + restore for free
- [x] Every icon button has `aria-label`
- [x] `role="log"` + `aria-live="polite"` on the message list
- [x] `aria-live` on toast region
- [x] Reduced-motion: global override in `index.css`
- [x] Color contrast ≥ 4.5:1 (verified via axe in CI)
- [x] `@axe-core/playwright` scans 3 screens, zero real violations
- [x] Tab-only end-to-end flow: signup → workspace creation (E2E)

## Performance Budget (verified)

| Chunk         | Budget | Actual (gzipped) |
| ------------- | ------ | ---------------- |
| initial entry | 200 KB | **6.39 KB**      |
| Shell         | 80 KB  | 11.44 KB         |
| vendor-react  | 55 KB  | 53.16 KB         |
| vendor-radix  | 70 KB  | 29.69 KB         |
| vendor-query  | 35 KB  | 12.29 KB         |
| vendor-socket | 30 KB  | 12.94 KB         |

Auth/invite/create-workspace pages are each ~1 KB and lazy-loaded so a
signed-out visitor never pays for the shell tree.

## State Management

**React Query** is the single source of server state. Every cache key is
constructed via `lib/query-keys.ts`; the dispatcher derives the exact same
tuple from an event payload, so a realtime update hits the same slot the
initial REST fetch populated.

**Zustand** owns UI-only state. Three small stores: `ui-store` (sidebar/
modal), `compose-store` (per-channel drafts, in-memory so logout clears),
`notification-store` (toast queue).

## Keyboard Shortcuts

| Combo                   | Action                                            |
| ----------------------- | ------------------------------------------------- |
| `Ctrl/Cmd+K`            | Quick switcher palette                            |
| `Ctrl/Cmd+/`            | This shortcut list                                |
| `Alt+↑ / Alt+↓`         | Previous / next channel                           |
| `Ctrl/Cmd+Shift+A`      | Cycle workspaces                                  |
| `Escape`                | Close overlay                                     |
| `Enter` / `Shift+Enter` | Send / newline in composer                        |
| `Shift+Esc`             | Mark channel read — _reserved, wired in task-027_ |

## E2E Regression (21 total)

All data-testids used by existing tests are preserved or explicitly
re-added after refactor. See `docs/tasks/008-frontend-shell.review.md`
for the detailed compat matrix.

## Non-goals

See § Scope OUT.

## Risks

- **Tailwind v3 semantic-only discipline** is enforced by convention,
  not yet by ESLint — a forgetful contributor can still hard-code
  `bg-blue-500`. TODO: add `no-restricted-syntax` rule.
- **`react-virtual` installed but unused** — kept for the steady-state
  scale point (when a channel has >1k visible messages). The cost today
  is ~4 KB in the vendor-query chunk (it's bundled with Tanstack).
- **`MessageList` doesn't virtualize yet** — acceptable for page sizes
  of 50 messages; real virtualization ships with task-009 if Task 005
  soak reveals rendering pressure.

## Progress Log

- `planner` — file inventory + migration map + token catalog emitted;
  user approved verbatim.
- `implementer` — design-system tokens → theme → primitives → shell
  columns → legacy feature extraction (ChannelList, MessageList, etc.)
  → query-keys + dispatcher → zustand stores → shortcuts → bundle
  split.
- `tester` — realtime dispatcher unit spec + 5 new E2E (a11y×2,
  shell×3).
- `reviewer (subagent)` — see `docs/tasks/008-frontend-shell.review.md`.
