# Paneworks

Workspaces for [Tabby](https://tabby.sh): predefined split layouts where every pane has its own profile, working directory and startup command. Fork of [TabbySpaces](https://github.com/halilc4/tabbyspaces) 0.2.7 by Igor Halilovic (MIT).

## What it changes compared to TabbySpaces

- **Tab title = workspace name.** The outer tab always shows the workspace name, whatever runs in the panes.
- **Pane label = program title.** Each pane's label shows the title the running program sets (for example Claude Code's session title), prefixed by the pane name when one is set: `C1 · <program title>`. Without a pane name the label is the program title alone. Renaming a pane by hand ("Rename pane") stops the sync for that pane.
- **No internal ids on screen.** Panes are found through a hidden marker in their profile instead of a temporary pane title, so a pane can no longer get stuck showing its id.
- **Reliable startup commands.** Panes are scanned when the split is ready, whenever a pane is added and again after a few seconds, and the command waits for the shell session; slow panes no longer miss their command.
- **Independent of TabbySpaces.** Both can be installed side by side: Paneworks keeps its workspaces under its own config key (`paneworks`), uses its own profile ids (`split-layout:paneworks:…`), tab state key (`paneworksWorkspaceId`), CSS hooks and component tags, and ignores TabbySpaces' tabs. Workspaces are not shared; create them in Settings > Paneworks.

## Install

In Tabby: Settings > Plugins, search **paneworks**, Install, restart Tabby. Updates appear in the same place.

## Develop

```
npm install
npm run build
```

`.npmrc` sets `legacy-peer-deps`, so npm doesn't pull Tabby's own packages. The build writes `dist/` (the published package: plugin code, its own `package.json`, README, LICENSE).

To try a local build in Tabby, link it instead of the published version, then restart Tabby after each `npm run build`:

```
cd %APPDATA%\tabby\plugins
npm uninstall tabby-paneworks
npm install --legacy-peer-deps <path to this repo>\dist
```

Back to the published version: `npm uninstall tabby-paneworks`, then install it from the plugin manager.

## Release

```
npm version patch      # or minor / major: bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

The tag starts `.github/workflows/release.yml`: build, publish to npm (trusted publishing, no token), GitHub release. Every Tabby with Paneworks installed then offers the update in Settings > Plugins.

## Use

Settings > Paneworks (or the grid button in the toolbar): create a workspace, split it, set name, profile, working directory and startup command per pane, then open it from the toolbar.

## License

MIT, see LICENSE.
