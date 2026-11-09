# Paneworks

**Workspaces for [Tabby](https://tabby.sh).** A workspace is a list of terminal panes, each with its own profile, folder and startup command. All of them start when the workspace opens. Paneworks arranges them in a grid that fits your window, and a sidebar in the workspace tab lets you show, hide, focus, sort, colour and edit them. Hiding is only visual: hidden panes keep running.

Made for running several long-lived sessions side by side (coding agents, dev servers, logs, tmux sessions) and switching between them without stopping any of them.

![View all: four panes in a grid, sidebar on the left](https://raw.githubusercontent.com/padjon/tabby-paneworks/main/docs/screenshots/view-all.png)

## Features

- **Automatic grid.** "View all" shows every switched-on pane. You set a minimum pane size; Paneworks fits as many panes as that allows, in as many rows as give each pane the most room, and rearranges when the window changes size.
- **Focus view.** Click a pane in the sidebar to see it alone, full size. Click it again to go back.
- **Every pane runs.** All panes start with the workspace, switched off or not. Hiding a pane never stops it; it comes back exactly as it was.
- **On/off switches and drag-and-drop order**, saved in the workspace.
- **Live titles.** Each pane's label shows the title its program sets (for example a coding agent's session title), optionally prefixed with a pane name. The tab itself always shows the workspace name.
- **Label colours** per pane, so you recognise panes at a glance.
- **NEW marker** on hidden panes that printed something since you last looked.
- **Startup commands** that wait for the shell to be ready.
- **Everything in the sidebar**: add, edit, restart and remove panes; rename, configure, create, switch and delete workspaces. No settings page.

![Focus view: one pane full size](https://raw.githubusercontent.com/padjon/tabby-paneworks/main/docs/screenshots/focus.png)

## Install

In Tabby: **Settings → Plugins**, search **paneworks**, **Install**, restart Tabby. Updates show up in the same place.

## Getting started

1. Click the **Paneworks** button (grid icon) in Tabby's toolbar and choose **New workspace**. It opens with one pane and the sidebar on the left.
2. Click **+** next to "Panes" to add panes. For each pane set a name (optional), label colour, startup command, folder and profile, then **Save**. The pane starts right away.
3. Click **View all** to see all switched-on panes in a grid.
4. Click the workspace name at the top of the sidebar to rename it, set the minimum pane size or let it open when Tabby starts.

Next time, open the workspace from the toolbar button. If it is already open, the button brings its tab to the front.

When a workspace opens, you briefly see all of its panes: Tabby starts a terminal only once it has been on screen. As soon as every pane runs, Paneworks switches to "View all".

## The sidebar

| Element | What it does |
|---|---|
| Workspace name (top) | Workspace menu: rename, minimum pane size, open when Tabby starts, switch to or open another workspace, new workspace, delete this one |
| « / » | Collapse or expand the sidebar |
| **View all** | All switched-on panes in a grid; shows how many are on screen out of how many are on |
| **+** | Add a pane (opens its editor) |
| Pane title | Focus view: this pane alone. Click again to go back to "View all" |
| Switch | On: part of "View all". Off: hidden, still running, reachable through its title |
| ⋮⋮ (drag the row) | Sort the panes; the order is the grid order |
| ⋯ | Edit the pane: name, label colour, startup command, folder, profile. **Restart** applies a changed command, folder or profile; **Remove** deletes the pane |

![Pane editor in the sidebar](https://raw.githubusercontent.com/padjon/tabby-paneworks/main/docs/screenshots/pane-editor.png)

### What the pane rows show

| Look | Meaning |
|---|---|
| Accent bar on the left, full brightness | On screen |
| Dimmed | Running, not on screen |
| Dimmer, switch off | Switched off (running, not in "View all") |
| Highlighted row | Shown alone (focus view) |
| **NEW** label | New output since the pane left the screen |
| "no room" under the title | Switched on, but doesn't fit at the minimum pane size |
| Small square before the title | The pane's label colour |

Hover over a row for the same information as a tooltip. On screen, every pane has a frame, the focused pane's frame uses the accent colour, and the bars between panes can be dragged to resize them.

![Workspace menu](https://raw.githubusercontent.com/padjon/tabby-paneworks/main/docs/screenshots/workspace-menu.png)

## How the grid is chosen

With a minimum pane size of W × H, the pane area fits `floor(width / W)` columns and `floor(height / H)` rows. Paneworks shows as many switched-on panes as fit, in their sidebar order, and among the arrangements that fit picks the one with the largest panes; rows are filled evenly, fuller rows first.

Examples for 600 × 260 px in a 1900 × 1000 px area: 3 panes → 2 + 1, 4 → 2 + 2, 5 → 2 + 2 + 1, 8 → 3 + 3 + 2. In 1200 × 700 px only 2 × 2 fit, so of 8 switched-on panes the first 4 are shown and the others are marked "no room" (they keep running).

## Pane titles

A pane's label shows the title its program sets through the terminal. With a pane name it reads `name · title`, without one just the title. Renaming a pane through Tabby's own "Rename pane" keeps your name and stops the live title for that pane.

If a pane runs **tmux**, tmux keeps titles to itself by default. Add this to `~/.tmux.conf` to pass them on:

```
set -g set-titles on
set -g set-titles-string "#{pane_title}"
```

## Configuration file

Workspaces are stored in Tabby's `config.yaml` under `paneworks.workspaces`. You normally never edit this by hand, but it is plain YAML:

```yaml
paneworks:
  workspaces:
    - id: 0b7c…                 # any unique id
      name: My project
      minPaneWidth: 600         # optional, px (default 600)
      minPaneHeight: 260        # optional, px (default 260)
      launchOnStartup: false
      panes:                    # sidebar and grid order
        - id: 5f1e…             # any unique id
          name: api             # optional
          color: '#3b82f6'      # optional label colour
          profileId: local:powershell
          cwd: C:\code\my-project
          startupCommand: npm run dev
        - id: 9a2d…
          profileId: local:powershell
          cwd: C:\code\my-project
          startupCommand: npm test -- --watch
          hidden: true          # switched off
```

## Notes and limits

- Panes live as long as the workspace tab. Closing the tab closes all of its panes, hidden ones included. After a Tabby restart, the workspace tab comes back through Tabby's tab recovery and starts its panes again.
- If a pane's program exits, the pane closes; "View all" or its title starts it again.
- Paneworks rearranges panes through Tabby's split-tab internals (the same mechanism as Tabby's own pane drag and drop). Developed and tested with Tabby 1.0.231 on Windows. A major Tabby update could need a Paneworks update.
- Paneworks keeps its data under its own config key and profile ids, so it does not interfere with other workspace plugins.

## Develop

```
npm install
npm run build
```

`.npmrc` sets `legacy-peer-deps`, so npm doesn't pull Tabby's own packages. The build writes `dist/`: the published package (plugin code, its `package.json`, README, LICENSE).

To try a local build in Tabby, link it in place of the published version and restart Tabby after each `npm run build`:

```
cd %APPDATA%\tabby\plugins
npm uninstall tabby-paneworks
npm install --legacy-peer-deps <path to this repo>\dist
```

Back to the published version: `npm uninstall tabby-paneworks`, then install it from Tabby's plugin manager. Console messages are prefixed `[Paneworks]` (Ctrl+Shift+I in Tabby).

## Release

```
npm version patch      # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

The tag runs `.github/workflows/release.yml`: build, publish to npm with trusted publishing (no token), GitHub release with generated notes.

## License

MIT, see [LICENSE](LICENSE).
