# Paneworks

Workspaces for [Tabby](https://tabby.sh): predefined split layouts where every pane has its own profile, working directory and startup command. Fork of [TabbySpaces](https://github.com/halilc4/tabbyspaces) 0.2.7 by Igor Halilovic (MIT).

## What it changes compared to TabbySpaces

- **Tab title = workspace name.** The outer tab always shows the workspace name, whatever runs in the panes.
- **Pane label = program title.** Each pane's label shows the title the running program sets (for example Claude Code's session title), prefixed by the pane name when one is set: `C1 · <program title>`. Without a pane name the label is the program title alone. Renaming a pane by hand ("Rename pane") stops the sync for that pane.
- **No internal ids on screen.** Panes are found through a hidden marker in their profile instead of a temporary pane title, so a pane can no longer get stuck showing its id.
- **Reliable startup commands.** Panes are scanned when the split is ready, whenever a pane is added and again after a few seconds, and the command waits for the shell session; slow panes no longer miss their command.
- Workspaces are stored under the same config key (`tabbyspaces`), so workspaces made with TabbySpaces keep working.

## Build

```
npm install --legacy-peer-deps
npm run build
```

The build writes `dist/` (plugin code plus its own `package.json`).

## Install into Tabby (Windows)

Only one of TabbySpaces and Paneworks may be installed: both read the same workspaces.

```
cd %APPDATA%\tabby\plugins
npm uninstall tabby-tabbyspaces
npm install --legacy-peer-deps D:\tabby-paneworks\dist
```

`npm install <folder>` links the folder, so after `npm run build` a Tabby restart picks up the new version; no reinstall needed. `--legacy-peer-deps` keeps npm from pulling a second copy of Tabby's own packages into the plugins folder. Restart Tabby after installing.

## Use

Settings > Paneworks (or the grid button in the toolbar): create a workspace, split it, set name, profile, working directory and startup command per pane, then open it from the toolbar.

## License

MIT, see LICENSE.
