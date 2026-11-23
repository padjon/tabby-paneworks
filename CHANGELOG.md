# Changelog

## 1.1.0

- Views: a workspace can have several views, each with its own set of switched-on panes. Select a view in the sidebar; the pane switches apply to the selected view. Views can be added, renamed, duplicated and deleted. Existing workspaces get one view, "Default", with their current switches.
- Edit settings in VS Code (workspace menu): the workspace as a JSON file, applied on every save, kept in sync with the sidebar.
- Copy button in the sidebar header: copies the project folder path. Copy settings file path (workspace menu): copies the path of the workspace's JSON settings file.
- New workspace asks for a profile, folder and startup command and creates 4 panes with them (number adjustable); the workspace is named after the folder, which becomes its project folder.
- New workspaces no longer get a random tab colour; pick one in the workspace menu.
- Duplicate in the pane editor: a copy of the pane right below it, switched on in the same views.

## 1.0.0

First release.

- Workspaces as ordered lists of terminal panes (profile, folder, startup command, optional name and label colour).
- "View all": automatic grid from a minimum pane size; adapts to window and sidebar size.
- Focus view: one pane alone, full size.
- Sidebar in every workspace tab: workspace menu, pane list with live titles, on/off switches, drag-and-drop order, inline pane editor (save, restart in place, remove), NEW marker for hidden panes with new output.
- Every pane starts with the workspace; hiding is only visual, hidden panes keep running.
- Pane labels follow the title the running program sets; the tab shows the workspace name.
- Toolbar button to open, bring to front and create workspaces.
- Pane frames, bright resize handles, label colours with readable text.
