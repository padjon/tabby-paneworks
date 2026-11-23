# Paneworks

**Workspaces for [Tabby](https://tabby.sh).** A workspace is a list of terminal panes, each with its own profile, folder and startup command. All of them start when the workspace opens. Paneworks arranges them in a grid that fits your window, and a sidebar in the workspace tab lets you show, hide, focus, sort, colour and edit them. Hiding is only visual: hidden panes keep running.

Made for running several long-lived sessions side by side (coding agents, dev servers, logs, tmux sessions) and switching between them without stopping any of them.

![View all: four panes in a grid, sidebar on the left](https://raw.githubusercontent.com/padjon/tabby-paneworks/main/docs/screenshots/view-all.png)

## Features

- **Views.** A workspace can have several views (for example "Agents", "Servers", "Everything"). Each view has its own set of switched-on panes. Pick a view in the sidebar to see its panes in a grid.
- **Automatic grid.** A view shows every pane switched on in it. You set a minimum pane size; Paneworks fits as many panes as that allows, in as many rows as give each pane the most room, and rearranges when the window changes size.
- **Focus view.** Click a pane in the sidebar to see it alone, full size. Click it again to go back.
- **Every pane runs.** All panes start with the workspace, switched off or not. Hiding a pane never stops it; it comes back exactly as it was.
- **On/off switches per view and drag-and-drop order**, saved in the workspace. All views share the same pane order.
- **Live titles.** Each pane's label shows the title its program sets (for example a coding agent's session title), optionally prefixed with a pane name. The tab itself always shows the workspace name.
- **Label colours** per pane, so you recognise panes at a glance.
- **Open in VS Code** from the sidebar header: opens the workspace's project folder (set in the workspace menu; by default the first pane folder). WSL folders open in VS Code's WSL mode.
- **Copy the project folder path** from the sidebar header.
- **Edit a workspace's settings in VS Code** as a JSON file (workspace menu). Every save is checked and applied right away.
- **Duplicate a pane** from its editor: same settings, switched on in the same views.
- **Tab colour** per workspace, applied to the workspace tab every time it opens, also after a Tabby restart.
- **NEW marker** on hidden panes that printed something since you last looked.
- **Startup commands** that wait for the shell to be ready.
- **F1 opens the Paneworks menu** (open or create a workspace) from anywhere in Tabby. Rebind it under **Settings → Hotkeys → Paneworks: open menu**.
- **Everything in the sidebar**: add, edit, restart and remove panes; rename, configure, create, switch and delete workspaces. No settings page.

![Focus view: one pane full size](https://raw.githubusercontent.com/padjon/tabby-paneworks/main/docs/screenshots/focus.png)

## Install

In Tabby: **Settings → Plugins**, search **paneworks**, **Install**, restart Tabby. Updates show up in the same place.

## Getting started

1. Click the **Paneworks** button (grid icon) in Tabby's toolbar, or press **F1**, and choose **New workspace**. Pick a profile, a folder and a startup command (optional). Paneworks creates 4 panes with them (you can change the number). The workspace is named after the folder, which also becomes its project folder. It opens with the sidebar on the left.
2. Change single panes with **⋯** (name, label colour, command, folder, profile), add more with **+** next to "Panes", or copy one with **Duplicate** in its editor.
3. Under **Views**, click a view to see its switched-on panes in a grid. Click **+** next to "Views" to add another view, select it, and use the pane switches to choose what it shows.
4. Click the workspace name at the top of the sidebar to rename it, pick a tab colour, set the project folder, set the minimum pane size or let it open when Tabby starts.

Next time, open the workspace from the toolbar button or F1. If it is already open, this brings its tab to the front.

When a workspace opens, you briefly see all of its panes: Tabby starts a terminal only once it has been on screen. As soon as every pane runs, Paneworks switches to the selected view.

## The sidebar

| Element | What it does |
|---|---|
| Workspace name (top) | Workspace menu: rename, tab colour, project folder, minimum pane size, open when Tabby starts, switch to or open another workspace, new workspace, delete this one |
| Copy icon | Copy the project folder path to the clipboard |
| `</>` | Open the project folder in VS Code (needs the `code` command, which VS Code's installer puts on PATH) |
| « / » | Collapse or expand the sidebar |
| **Views** **+** | Add a view, with all panes switched on |
| View row | Select the view and show its switched-on panes in a grid. Shows how many are on screen out of how many are on |
| ⋯ on a view | Rename, duplicate (same switches) or delete the view |
| **Panes** **+** | Add a pane (opens its editor). A new pane is switched on in the selected view only |
| Pane title | Focus view: this pane alone. Click again to go back to the selected view |
| Switch | Belongs to the selected view. On: shown in that view. Off: hidden there, still running, reachable through its title |
| ⋮⋮ (drag the row) | Sort the panes; the order is the grid order |
| ⋯ | Edit the pane: name, label colour, startup command, folder, profile. **Restart** applies a changed command, folder or profile; **Duplicate** adds a copy right below it (started at once); **Remove** deletes the pane |

![Pane editor in the sidebar](https://raw.githubusercontent.com/padjon/tabby-paneworks/main/docs/screenshots/pane-editor.png)

### What the pane rows show

| Look | Meaning |
|---|---|
| Accent bar on the left, full brightness | On screen |
| Dimmed | Running, not on screen |
| Dimmer, switch off | Switched off in the selected view (running, not shown) |
| Highlighted row | Shown alone (focus view) |
| **NEW** label | New output since the pane left the screen |
| "no room" under the title | Switched on, but doesn't fit at the minimum pane size |
| Small square before the title | The pane's label colour |

Hover over a row for the same information as a tooltip. On screen, every pane has a frame, the focused pane's frame uses the accent colour, and the bars between panes can be dragged to resize them.

![Workspace menu](https://raw.githubusercontent.com/padjon/tabby-paneworks/main/docs/screenshots/workspace-menu.png)

## How the grid is chosen

With a minimum pane size of W × H, the pane area fits `floor(width / W)` columns and `floor(height / H)` rows. Paneworks shows as many of the view's switched-on panes as fit, in their sidebar order, and among the arrangements that fit picks the one with the largest panes; rows are filled evenly, fuller rows first.

Examples for 600 × 260 px in a 1900 × 1000 px area: 3 panes → 2 + 1, 4 → 2 + 2, 5 → 2 + 2 + 1, 8 → 3 + 3 + 2. In 1200 × 700 px only 2 × 2 fit, so of 8 switched-on panes the first 4 are shown and the others are marked "no room" (they keep running).

## Pane titles

A pane's label shows the title its program sets through the terminal. With a pane name it reads `name · title`, without one just the title. Renaming a pane through Tabby's own "Rename pane" keeps your name and stops the live title for that pane.

If a pane runs **tmux**, tmux keeps titles to itself by default. Add this to `~/.tmux.conf` to pass them on:

```
set -g set-titles on
set -g set-titles-string "#{pane_title}"
```

## Configuration file

Workspaces are stored in Tabby's `config.yaml` under `paneworks.workspaces`.

To edit one by hand while Tabby runs, use **Edit settings in VS Code** in the workspace menu, not `config.yaml`: Tabby keeps `config.yaml` in memory and overwrites it on its next save. The menu item writes the workspace to its own JSON file (in a `paneworks` folder next to `config.yaml`) and opens it in VS Code. Each save is checked and applied to the open tab: renamed views, changed switches, panes added or removed. A file that isn't valid is not applied, and a notification says why. Panes and views without an `id` get one. Changes you make in the sidebar are written back to the file. Panes whose command, folder or profile changed are restarted. While the file has an error, the sidebar stops writing to it, so your edits stay until you fix them.

The format in `config.yaml` is plain YAML:

```yaml
paneworks:
  workspaces:
    - id: 0b7c…                 # any unique id
      name: My project
      color: '#10b981'          # optional tab colour
      folder: C:\code\my-project  # optional, for Open in VS Code (default: first pane folder)
      minPaneWidth: 600         # optional, px (default 600)
      minPaneHeight: 260        # optional, px (default 260)
      launchOnStartup: false
      activeViewId: 3c4d…       # the selected view (default: the first)
      views:
        - id: 3c4d…             # any unique id
          name: Default
          hidden: [9a2d…]       # pane ids switched off in this view
        - id: 7e8f…
          name: Tests
          hidden: [5f1e…]
      panes:                    # sidebar and grid order, shared by all views
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
```

## Notes and limits

- Panes live as long as the workspace tab. Closing the tab closes all of its panes, hidden ones included. After a Tabby restart, the workspace tab comes back through Tabby's tab recovery and starts its panes again.
- If a pane's program exits, the pane closes; a view or its title starts it again.
- Paneworks rearranges panes through Tabby's split-tab internals (the same mechanism as Tabby's own pane drag and drop). Developed and tested with Tabby 1.0.231 on Windows. A major Tabby update could need a Paneworks update.
- Tabby catches F1 before the terminal does, so programs that use F1 themselves (htop, mc) won't see it. Rebind the hotkey if you need F1 there.
- Paneworks keeps its data under its own config key and profile ids, so it does not interfere with other workspace plugins.

## Develop

```
npm install
npm run build
```

`.npmrc` sets `legacy-peer-deps`, so npm doesn't pull Tabby's own packages. The build writes `dist/`: the published package (plugin code, its `package.json`, README, LICENSE).

To try a local build in Tabby, install it once in place of the published version:

```
cd %APPDATA%\tabby\plugins
npm uninstall tabby-paneworks
npm install --legacy-peer-deps <path to this repo>\dist
```

After that, every `npm run build` (and `npm run build:dev` for the DEV variant) copies the build into the local Tabby (from Windows or WSL), including the folder a `file:` install points to, so a reinstall from Tabby's plugin manager can't bring back an older build. Restart Tabby to load it. CI builds skip this.

Back to the published version: `npm uninstall tabby-paneworks`, then install it from Tabby's plugin manager. Console messages are prefixed `[Paneworks]` (Ctrl+Shift+I in Tabby).

## Release

Every push to `main` runs `.github/workflows/release.yml`: build, publish to npm with trusted publishing (no token) and provenance, tag the commit `vX.Y.Z`. The version is `<major>.<minor>` from `package.json` plus the workflow run number, e.g. `1.0.17`. For a new minor or major version, change `package.json` by hand (e.g. to `1.1.0`).

## License

MIT, see [LICENSE](LICENSE).
