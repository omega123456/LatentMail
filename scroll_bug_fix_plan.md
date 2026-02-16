# Email List Scroll-to-Top Bug Fix Plan

## Overview

When clicking on an email for the **first time** after switching to a folder (or on initial load), the email list jumps back to the top. Subsequent email clicks within the same folder work fine — scroll position is preserved. The bug reappears after every folder switch.

## Root Cause

The Angular routing configuration defines **separate route entries** for each URL depth that all load the same `MailShellComponent`:

```
mail/:accountId/:folderId          → MailShellComponent
mail/:accountId/:folderId/:threadId → MailShellComponent
```

When the user clicks an email, the router navigates from the folder-level route to the thread-level route (e.g., `/mail/1/INBOX` → `/mail/1/INBOX/thread123`). Because these are **distinct route entries**, Angular destroys the entire `MailShellComponent` instance and creates a new one. This destroys the `CdkVirtualScrollViewport`, losing all scroll state. The rebuilt viewport starts at scroll position 0.

**Why it only happens the first time**: After the initial click, the URL is already at the `:threadId` route. Clicking another email only changes a route parameter within the *same* route definition. Angular reuses the component instance, so the scroll viewport survives and position is preserved.

**Why it recurs on folder switch**: `onFolderSelected` navigates to `/mail/:accountId/:folderId` (no threadId), which drops back to the folder-level route. The next email click again jumps to the `:threadId` route — a different route definition — destroying and rebuilding the component.

## Goals and Objectives

- Eliminate the scroll-to-top jump when clicking an email in the list
- Preserve scroll position across thread selections within a folder
- Keep route-driven state (deep links to specific threads) working
- Avoid breaking folder switching, which should still reset the list

---

## File System Changes

### Modified Files

| File | Purpose of Modification |
|------|------------------------|
| `src/app/app.routes.ts` | Consolidate separate mail routes into a single parent route with an optional `:threadId` child, so the shell component is never destroyed on thread selection |
| `src/app/features/mail/mail-shell.component.ts` | Adapt route param reading to work with the new nested route structure (read params from child route if present) |

---

## Architecture & Structure

### Route Consolidation Strategy

**Current (broken)**: Five separate top-level route entries that each independently load `MailShellComponent`:

- `mail`
- `mail/unified`
- `mail/:accountId`
- `mail/:accountId/:folderId`
- `mail/:accountId/:folderId/:threadId`

Each navigation between these routes destroys and recreates the shell component.

**Proposed (fixed)**: A single parent route for `mail/:accountId/:folderId` that loads `MailShellComponent`, with an *optional* child route for `:threadId`. The shell component is loaded once and stays alive. Thread selection only changes the child route, which does not destroy the parent.

The key architectural decisions:

1. **Single shell route**: `mail/:accountId/:folderId` loads the shell as the parent. Navigating between folders still destroys/recreates the shell (which is desired — it should reset the list).
2. **Optional threadId via child route**: A child route captures `:threadId`. The shell reads thread selection from the child route's params. When no thread is selected, the default child route is empty.
3. **Shell component stays alive**: Because the shell is the parent route component, clicking an email (which only changes the child route) does **not** destroy the shell or its `CdkVirtualScrollViewport`.
4. **Simpler entries for `mail` and `mail/:accountId`**: These redirect to `mail/:accountId/:folderId` (with INBOX default) so everything funnels through one shell instance.

### MailShellComponent Adaptation

The component currently reads params from `this.route.snapshot.params`, which sees all params at the route's own level. With the new nested structure:

- **`accountId`** and **`folderId`**: Available on the shell's own `ActivatedRoute` params (parent route)
- **`threadId`**: Available on the child `ActivatedRoute` params

The component needs to subscribe to both its own params and its first child route's params to detect thread selection changes. An alternative simpler approach is to use `Router.events` or `ActivatedRoute`'s `firstChild` observable.

### Interaction Summary

- **Folder click** → navigates to `/mail/:accountId/:newFolderId` → shell component is destroyed and recreated (different `:folderId` param triggers same route, but this is the **parent** route so Angular keeps the component alive — the folder change is detected via param subscription). Actually, because `:folderId` is a param on the same parent route, Angular **reuses** the component. `loadThreads` is called when the param changes, which resets scroll position naturally.
- **Email click** → navigates to `/mail/:accountId/:folderId/:threadId` → only the child route changes. Shell stays alive. Viewport scroll position preserved.
- **Clicking another email** → child route param changes. Shell stays alive. Scroll preserved.
- **Deep link** → `/mail/1/INBOX/thread123` → shell loads with folder, child route has threadId. Both are read on init.

---

## Routing & Navigation

### New Route Configuration

The `mail` section of routes will be restructured:

- **`mail`** → redirects to default account/folder
- **`mail/unified`** → loads shell (or redirects, depending on unified implementation status)
- **`mail/:accountId`** → redirects to `:accountId/INBOX`
- **`mail/:accountId/:folderId`** → loads `MailShellComponent` as the **parent**, with children:
  - **Default child (empty path)**: No-op component or empty route (no component). Represents "no thread selected."
  - **`:threadId` child**: No component (the shell handles display). Represents "thread is selected."

> **Important**: The child routes do not need their own components. The shell component reads the child params directly. The children can use `component: undefined` or a trivial empty component. Alternatively, the routes can be defined with `children` that have no component, and the parent reads `this.route.firstChild?.params`.

### Navigation Flow

| User Action | Route Transition | Shell Component |
|------------|-----------------|----------------|
| Select folder "Sent" | `/mail/1/INBOX` → `/mail/1/Sent` | Reused (param change on same route) |
| Click email in Sent | `/mail/1/Sent` → `/mail/1/Sent/thread123` | **Stays alive** (child route change) |
| Click different email | `/mail/1/Sent/thread123` → `/mail/1/Sent/thread456` | **Stays alive** (child param change) |
| Switch to INBOX | `/mail/1/Sent/thread456` → `/mail/1/INBOX` | Reused (parent param change) |
| Click email in INBOX | `/mail/1/INBOX` → `/mail/1/INBOX/thread789` | **Stays alive** (child route change) |

---

## Implementation Steps

1. **Restructure `app.routes.ts`**:
   - Consolidate the five mail route entries into a parent route with children
   - The parent route `mail/:accountId/:folderId` loads `MailShellComponent`
   - Add an empty-path default child route and a `:threadId` child route
   - Keep redirects for `mail` and `mail/:accountId` to route to the correct parent
   - Add a `<router-outlet>` to the shell (can be hidden/empty — it's just needed for Angular's child routing to work)

2. **Update `MailShellComponent` param reading**:
   - Change `applyRouteParams` to read `accountId` and `folderId` from the component's own `ActivatedRoute`
   - Read `threadId` from `this.route.firstChild?.params` or by subscribing to the child route's param changes
   - Use `combineLatest` or `merge` of parent params and child params to detect any route change
   - Keep the `lastLoadedAccountId`/`lastLoadedFolderId` guard to avoid redundant thread list reloads

3. **Verify folder switching still works**: When navigating between folders, the parent route params change (`folderId`). Angular reuses the component but fires the param subscription, which should trigger `loadThreads` → resets scroll position naturally via the store's `preserveListPosition: false` reset.

4. **Verify deep links still work**: Navigating directly to `/mail/1/INBOX/thread123` should load the shell, load the INBOX thread list, and then select the thread from the child param.

---

## Acceptance Criteria

- Clicking an email after scrolling down in a folder does **not** jump the email list to the top
- Scroll position is preserved across thread selections within the same folder
- Switching folders still resets the email list to the top (expected behavior)
- Deep linking to a specific thread (direct URL navigation) still works
- Back/forward browser navigation still works correctly
- The reading pane updates correctly when selecting threads in both three-column and bottom-preview layouts
- No duplicate `loadThreads` or `loadThread` calls on email click

---

## Notes and Considerations

- **Router outlet in shell**: The shell template needs a `<router-outlet>` for the child routes to activate, even if the child routes don't render any component. If child routes have no component, the outlet can be omitted and Angular will still track the child route's params. If this doesn't work, use a minimal empty component for the child routes.
- **`paramsInheritanceStrategy`**: Angular's `paramsInheritanceStrategy: 'always'` (set in router config) would make all parent params available to children and vice versa. This could simplify param reading but changes behavior globally. Evaluate whether this is appropriate for the project.
- **Alternative approach — `componentless` child routes**: Angular supports child routes without components. The parent's `ActivatedRoute` can observe `firstChild.params`. This is the cleanest approach and avoids needing an extra `<router-outlet>`.
- **Bottom-preview layout secondary concern**: In bottom-preview mode, the reading pane's appearance/disappearance on first thread selection also causes a minor height change for the virtual scroll viewport. While the route fix resolves the primary scroll reset, this height change could cause a small visual shift. Consider always rendering the reading pane container (with visibility hidden or min-height) to reserve space. This is a lower-priority follow-up.
