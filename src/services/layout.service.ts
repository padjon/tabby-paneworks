import { Injectable } from '@angular/core'
import {
  AppService,
  BaseTabComponent,
  PlatformService,
  ProfilesService,
  SplitContainer,
  SplitTabComponent,
  TabRecoveryService,
  TabsService,
} from 'tabby-core'
import { DISPLAY_NAME } from '../build-config'
import {
  DEFAULT_MIN_PANE_HEIGHT,
  DEFAULT_MIN_PANE_WIDTH,
  LayoutSplit,
  TabbyProfile,
  Workspace,
  WorkspacePane,
  WorkspaceView,
  activeView,
  createDefaultPane,
  createDefaultView,
  createDefaultWorkspace,
  isLayoutSplit,
  isPaneOn,
  layoutPaneIds,
  parsePaneMarker,
  readableTextColor,
  setPaneOn,
} from '../models/workspace.model'
import { PaneRuntimeService } from './paneRuntime.service'
import { SIDEBAR_WIDTH, WorkspaceEditorService } from './workspaceEditor.service'

/** Quick choices for pane label colours. */
const PANE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316']

/** "Open in VS Code" button: code brackets. */
const ICON_CODE = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
</svg>`

/** "Copy project folder path" button: two sheets. */
const ICON_COPY = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
</svg>`

const SIDEBAR_COLLAPSED_WIDTH = 22
const REFRESH_MS = 1000
const RESIZE_DEBOUNCE_MS = 250

/** What a workspace tab shows: the selected view's switched-on panes in a grid, or one pane. */
type View = { kind: 'all' } | { kind: 'focus', paneId: string }

interface WorkspaceTabState {
  split: SplitTabComponent
  workspaceId: string
  view: View
  /** Signature of the grid last applied for "View all"; skips needless rebuilds. */
  appliedPlan: string | null
  /** Panes taken out of the split; alive, not shown. */
  parked: Map<string, BaseTabComponent>
  sidebar: HTMLElement | null
  collapsed: boolean
  busy: boolean
  dragging: boolean
  /** Open editors pause the periodic redraw (it would reset what is being typed). */
  editingPaneId: string | null
  editingViewId: string | null
  menuOpen: boolean
  timer: ReturnType<typeof setInterval> | null
  /** "NEW": panes with output since they left the screen (after the grace period). */
  unseen: Set<string>
  /** When each pane last left the screen. */
  leftAt: Map<string, number>
  /** Starting all panes after the tab opened; the grid waits until that is done. */
  starting: boolean
  /** The workspace file was edited while the tab was in the background: sync when it is shown. */
  syncPending: boolean
  /** Panes whose command, folder or profile changed in the file: restarted at the next sync. */
  restartPending: Set<string>
  /** Unsaved values of the open editor (pane, view or workspace menu), kept across redraws. */
  drafts: Map<string, string>
  /** Which editor the drafts belong to; another editor opening starts over. */
  draftOwner: string | null
  /** Tab colour this plugin last applied; a colour picked in Tabby's tab menu is kept otherwise. */
  appliedColor: string | null
}

/** How long opening waits for every pane's shell before switching to "View all". */
const START_TIMEOUT_MS = 8000

/**
 * Output in the first moments after a pane leaves the screen is ignored for "NEW":
 * a layout change resizes terminals, and shells / tmux redraw on resize.
 */
const NEW_OUTPUT_GRACE_MS = 2500

// Tabby internals used here (stable across 1.0.x, not in the public typings):
// split.viewRefs, split.attachTabView(), split.onAfterTabAdded(), split.replaceTab(),
// split.maximizedTab, split.visibility$, tab.hostView (the top-level tab's DOM).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** Last part of a folder path, Windows or POSIX: 'C:\\code\\api\\' -> 'api'; '' for none. */
function folderName(folder: string): string {
  const parts = folder.trim().split(/[\\/]+/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  return /^[a-z]:$/i.test(last) || last === '~' ? '' : last
}

/**
 * Everything inside a Paneworks workspace tab: the sidebar (workspace menu, panes,
 * switches, sorting, editing), the "View all" grid and the focus view; plus opening,
 * focusing and creating workspaces.
 * Showing and hiding moves live panes in and out of the split (the way Tabby's own
 * drag and drop does), so hidden panes keep running; panes never shown before are
 * created on demand with their startup command. Closing the tab closes all panes.
 */
@Injectable()
export class LayoutService {
  private states = new WeakMap<SplitTabComponent, WorkspaceTabState>()
  private active = new Set<WorkspaceTabState>()
  private resizeTimer: ReturnType<typeof setTimeout> | null = null
  private profiles: TabbyProfile[] = []
  private watchedSessions = new WeakSet<object>()

  constructor(
    private app: AppService,
    private profilesService: ProfilesService,
    private runtime: PaneRuntimeService,
    private workspaces: WorkspaceEditorService,
    private tabsService: TabsService,
    private tabRecovery: TabRecoveryService,
    private platform: PlatformService
  ) {
    this.runtime.workspaceSplitFound$.subscribe(({ split, workspaceId }) => this.attach(split, workspaceId))
    this.workspaces.workspaceEdited$.subscribe(({ workspaceId, before }) => this.syncEdited(workspaceId, before))
    window.addEventListener('resize', () => {
      if (this.resizeTimer) clearTimeout(this.resizeTimer)
      this.resizeTimer = setTimeout(() => this.refreshAllGrids(), RESIZE_DEBOUNCE_MS)
    })
  }

  // ---------- workspaces ----------

  /** The open tab of a workspace, if any. */
  findOpenTab(workspaceId: string): SplitTabComponent | null {
    for (const state of this.active) {
      if (state.workspaceId === workspaceId) return state.split
    }
    for (const tab of this.app.tabs) {
      if (tab instanceof SplitTabComponent &&
        tab.getAllTabs().some((t) => parsePaneMarker((t as Any).profile?.group)?.workspaceId === workspaceId)) {
        return tab
      }
    }
    return null
  }

  /** Opens a workspace, or brings its tab to the front when it is already open. */
  async openWorkspace(workspaceId: string): Promise<void> {
    const open = this.findOpenTab(workspaceId)
    if (open) {
      this.app.selectTab(open)
      return
    }
    const workspace = this.workspaces.getWorkspace(workspaceId)
    if (!workspace) return
    const commands = this.workspaces.collectStartupCommands(workspace)
    if (commands.length) this.runtime.registerCommands(commands)
    // Opens with all panes on screen; the sidebar then switches to "View all"
    const profile = await this.workspaces.generateTabbyProfile(workspace)
    if (profile) this.profilesService.openNewTabForProfile(profile as Any)
  }

  /**
   * New workspace: asks for a profile, a folder and a startup command (the initial setup),
   * then creates that many identical panes (4 by default). The workspace is named after
   * the folder, which also becomes its project folder. Opened right away.
   */
  async createWorkspace(): Promise<void> {
    await this.loadProfiles()
    const setup = await this.askWorkspaceSetup()
    if (!setup) return
    const names = new Set(this.workspaces.getWorkspaces().map((w) => w.name))
    let base = folderName(setup.folder)
    if (!base) {
      let n = 1
      while (names.has(`Workspace ${n}`)) n++
      base = `Workspace ${n}`
    }
    let name = base
    for (let n = 2; names.has(name); n++) name = `${base} ${n}`
    const workspace = createDefaultWorkspace(name)
    // Optional fields only when set (the config file never gets empty keys)
    workspace.panes = Array.from({ length: setup.panes }, () => ({
      id: createDefaultPane().id,
      profileId: setup.profileId,
      ...(setup.folder ? { cwd: setup.folder } : {}),
      ...(setup.command ? { startupCommand: setup.command } : {}),
    }))
    if (setup.folder) workspace.folder = setup.folder
    await this.workspaces.addWorkspace(workspace)
    await this.openWorkspace(workspace.id)
  }

  /** The "New workspace" dialog. Resolves to null when cancelled. */
  private askWorkspaceSetup(): Promise<{ profileId: string, folder: string, command: string, panes: number } | null> {
    this.ensureStyles()
    return new Promise((resolve) => {
      const overlay = this.node('div', 'paneworks-overlay')
      const box = this.node('div', 'paneworks-sidebar pw-dialog')
      const form = this.node('div', 'pw-form')

      const profile = document.createElement('select')
      profile.className = 'pw-input'
      for (const p of this.profiles) {
        const option = document.createElement('option')
        option.value = p.id
        option.textContent = p.name
        profile.append(option)
      }
      const local = this.profiles.find((p) => p.type === 'local' || p.type?.startsWith('local:')) ?? this.profiles[0]
      profile.value = local?.id ?? ''

      const folder = this.input('text', '', 'C:\\path or /home/user')
      const browse = this.button('pw-btn', 'Browse…', 'Pick a folder', async () => {
        try {
          const picked = await this.platform.pickDirectory()
          if (picked) folder.value = picked
          updateName()
        } catch {
          // dialog not available: type the path
        }
      })
      const folderRow = this.node('div', 'pw-folder-row')
      folderRow.append(folder, browse)
      const command = this.input('text', '', 'e.g. claude (optional)')
      const panes = this.input('number', '4', '4')
      panes.min = '1'
      panes.max = '16'
      panes.classList.add('pw-size')
      const nameHint = this.node('div', 'pw-hint')
      const updateName = () => {
        const name = folderName(folder.value)
        nameHint.textContent = name ? `Workspace name: ${name}` : 'The workspace is named after the folder.'
      }
      folder.addEventListener('input', updateName)
      updateName()

      form.append(
        this.node('div', 'pw-dialog-title', 'New workspace'),
        this.field('Profile', profile),
        this.field('Folder', folderRow),
        nameHint,
        this.field('Startup command', command),
        this.field('Panes', panes),
        this.node('div', 'pw-hint', 'Every pane starts with this profile, folder and command. Change single panes later in the sidebar.'),
      )
      const close = (result: { profileId: string, folder: string, command: string, panes: number } | null) => {
        overlay.remove()
        resolve(result)
      }
      const create = () => close({
        profileId: profile.value,
        folder: folder.value.trim(),
        command: command.value.trim(),
        panes: Math.min(16, Math.max(1, Math.round(panes.value.trim() && Number.isFinite(Number(panes.value)) ? Number(panes.value) : 4))),
      })
      for (const field of [folder, command, panes]) {
        field.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') create()
          if (e.key === 'Escape') close(null)
        })
      }
      profile.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Escape') close(null)
      })
      const actions = this.node('div', 'pw-actions')
      actions.append(
        this.button('pw-btn primary', 'Create', 'Create and open the workspace', create),
        this.button('pw-btn', 'Cancel', 'Close without creating', () => close(null)),
      )
      form.append(actions)
      box.append(form)
      overlay.append(box)
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null) })
      document.body.append(overlay)
      setTimeout(() => folder.focus(), 0)
    })
  }

  private async loadProfiles(): Promise<void> {
    if (!this.profiles.length) {
      this.profiles = await this.workspaces.getAvailableProfiles()
    }
  }

  // ---------- attaching to a workspace tab ----------

  /**
   * Tab colour from the workspace, applied whenever the tab attaches (opened, or recovered
   * after a restart, where Tabby doesn't keep tab colours). A workspace without a colour
   * leaves the tab alone, so a colour set from Tabby's tab menu stays until the next restart.
   */
  private applyTabColor(state: WorkspaceTabState): void {
    const color = this.workspaces.getWorkspace(state.workspaceId)?.color || null
    if (color) state.split.color = color
    else if (state.appliedColor) state.split.color = null // removed in the workspace menu or file
    state.appliedColor = color
  }

  private attach(split: SplitTabComponent, workspaceId: string): void {
    const existing = this.states.get(split)
    if (existing) {
      if (!existing.sidebar?.isConnected) this.mountSidebar(existing)
      return
    }
    const state: WorkspaceTabState = {
      split,
      workspaceId,
      view: { kind: 'all' },
      appliedPlan: null,
      parked: new Map(),
      sidebar: null,
      collapsed: this.loadCollapsed(workspaceId),
      busy: false,
      dragging: false,
      editingPaneId: null,
      editingViewId: null,
      menuOpen: false,
      timer: null,
      unseen: new Set(),
      starting: true,
      syncPending: false,
      restartPending: new Set(),
      drafts: new Map(),
      draftOwner: null,
      appliedColor: null,
      leftAt: new Map(),
    }
    this.states.set(split, state)
    this.active.add(state)
    this.loadProfiles()
    this.applyTabColor(state)

    split.destroyed$.subscribe(() => {
      // Parked panes are outside the split: close them with it
      for (const tab of state.parked.values()) tab.destroy()
      state.parked.clear()
      if (state.timer) clearInterval(state.timer)
      state.sidebar?.remove()
      this.active.delete(state)
    })
    // A tab in the background has no size; fit its grid when it comes to the front
    ;(split as Any).visibility$?.subscribe((visible: boolean) => {
      if (!visible) return
      setTimeout(() => {
        if (state.syncPending) this.syncTab(state)
        else this.refreshGrid(state)
      }, 50)
    })

    this.mountSidebar(state)
    state.timer = setInterval(() => this.render(state), REFRESH_MS)
    this.startAllPanes(state)
  }

  // ---------- views ----------

  private async showAll(state: WorkspaceTabState, force = false): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const area = this.paneArea(state)
    if (!workspace || !area) return
    const plan = this.workspaces.planViewAll(workspace, area.width, area.height)
    const signature = JSON.stringify(plan.tree)
    if (signature !== state.appliedPlan) {
      console.log(`[${DISPLAY_NAME}] View all:`, { area, shown: plan.shown.length, min: this.workspaces.minPaneSize(workspace) })
    }
    const wasAll = state.view.kind === 'all'
    state.view = { kind: 'all' }
    if (!plan.tree && workspace.panes.length && (force || !wasAll || state.appliedPlan !== 'empty')) {
      // Nothing switched on in this view: show the first pane (the split can't be empty);
      // the sidebar says so
      const first = workspace.panes[0].id
      if (await this.apply(state, workspace, { orientation: 'horizontal', ratios: [1], children: [{ paneId: first }] })) {
        state.appliedPlan = 'empty'
      }
    }
    if (plan.tree && (force || !wasAll || signature !== state.appliedPlan)) {
      if (await this.apply(state, workspace, plan.tree)) {
        state.appliedPlan = signature
      }
    }
    this.render(state, true)
  }

  private async showFocus(state: WorkspaceTabState, paneId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace) return
    const tree: LayoutSplit = { orientation: 'horizontal', ratios: [1], children: [{ paneId }] }
    if (await this.apply(state, workspace, tree)) {
      state.view = { kind: 'focus', paneId }
      state.appliedPlan = null
    }
    this.render(state, true)
  }

  /** Shows the current view again (after panes changed). */
  private async reapplyView(state: WorkspaceTabState): Promise<void> {
    if (state.view.kind === 'focus') await this.showFocus(state, state.view.paneId)
    else await this.showAll(state, true)
  }

  /** Re-fits "View all" to the current size; no-op when the grid stays the same. */
  private refreshGrid(state: WorkspaceTabState): void {
    if (state.view.kind === 'all' && !state.busy && !state.starting) this.showAll(state)
  }

  /**
   * Every pane of a workspace runs, switched off or not: hiding is only visual.
   * Tabby starts a terminal's shell only once the terminal has been on screen, so the
   * workspace first shows all its panes (a fresh open already does; after a Tabby
   * restart only the panes that were on screen come back), waits until every shell
   * runs, then switches to "View all", which hides the switched-off ones again.
   */
  private async startAllPanes(state: WorkspaceTabState): Promise<void> {
    const before = state.view
    state.starting = true
    try {
      const workspace = this.workspaces.getWorkspace(state.workspaceId)
      if (!workspace) return
      const area = await this.waitFor(() => this.paneArea(state), 3000)
      const missing = workspace.panes.some((p) => !this.livePanes(state).has(p.id))
      const tree = this.workspaces.allPanesLayout(workspace, area?.width, area?.height)
      if (missing && tree) {
        await this.apply(state, workspace, tree)
      }
      await this.waitFor(() => {
        const tabs = [...this.livePanes(state).values()]
        return tabs.length && tabs.every((t) => (t as Any).session) ? true : null
      }, START_TIMEOUT_MS)
    } finally {
      state.starting = false
    }
    // Back to the view from before (a fresh tab starts in "View all")
    if (before.kind === 'focus') await this.showFocus(state, before.paneId)
    else await this.showAll(state, true)
  }

  /** Polls until `check` returns a value (not null/false) or the timeout passes. */
  private async waitFor<T>(check: () => T | null | false, timeoutMs: number): Promise<T | null> {
    const end = Date.now() + timeoutMs
    for (;;) {
      const value = check()
      if (value) return value
      if (Date.now() > end) return null
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  private refreshAllGrids(): void {
    for (const state of this.active) this.refreshGrid(state)
  }

  /** Size of the area the panes get (the split element). Null while the tab is in the background. */
  private paneArea(state: WorkspaceTabState): { width: number, height: number } | null {
    const rect = this.splitElement(state)?.getBoundingClientRect()
    return rect && rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null
  }

  /** Rebuilds the split to show exactly the panes of `tree`. Returns false if nothing could be shown. */
  private async apply(state: WorkspaceTabState, workspace: Workspace, tree: LayoutSplit): Promise<boolean> {
    if (state.busy) return false
    state.busy = true
    try {
      const split = state.split as Any
      const panes = new Map(workspace.panes.map((p) => [p.id, p]))
      const live = this.livePanes(state)

      // Panes of the new view: live ones, or created now
      const wanted = layoutPaneIds(tree).filter((id) => panes.has(id))
      for (const id of wanted) {
        if (!live.has(id)) {
          const tab = await this.createPane(workspace, panes.get(id)!)
          if (tab) live.set(id, tab)
        }
      }
      const shown = wanted.filter((id) => live.has(id))
      if (!shown.length) return false

      // Park the panes that leave the split (detach their view, keep them alive)
      for (const tab of state.split.getAllTabs()) {
        const id = this.paneIdOf(tab)
        if (!id || !shown.includes(id)) {
          tab.removeFromContainer()
          split.viewRefs?.delete(tab)
          tab.parent = null
          if (id) {
            state.parked.set(id, tab)
            state.leftAt.set(id, Date.now())
          } else {
            tab.destroy() // not a workspace pane (e.g. a manual split): close it
          }
        }
      }

      const root = this.buildContainer(tree, live)
      if (!root) return false
      split.maximizedTab = null
      split.root = root

      // Attach the panes that enter the split; on screen = seen
      for (const id of shown) {
        const tab = live.get(id)!
        state.unseen.delete(id)
        tab.clearActivity()
        if (!split.viewRefs?.has(tab)) {
          state.parked.delete(id)
          tab.parent = state.split
          ;(tab as Any).emitVisibility?.(split.visibility?.value ?? true)
          split.attachTabView(tab)
          split.onAfterTabAdded(tab)
        }
      }

      split.layout()
      state.split.focus(live.get(shown[0])!)
      split.recoveryStateChangedHint?.next()
      this.nudgeResize()
      // Labels of newly attached panes appear after Angular's next pass
      setTimeout(() => this.applyLabelColors(state, this.workspaces.getWorkspace(state.workspaceId)), 100)
      return true
    } catch (error) {
      console.error(`[${DISPLAY_NAME}] Layout change failed:`, error)
      return false
    } finally {
      state.busy = false
    }
  }

  private buildContainer(node: LayoutSplit, live: Map<string, BaseTabComponent>): SplitContainer | null {
    const children: (SplitContainer | BaseTabComponent)[] = []
    const ratios: number[] = []
    node.children.forEach((child, i) => {
      const built = isLayoutSplit(child) ? this.buildContainer(child, live) : live.get(child.paneId) ?? null
      if (built) {
        children.push(built)
        ratios.push(node.ratios[i] ?? 1)
      }
    })
    if (!children.length) return null
    const sum = ratios.reduce((a, b) => a + b, 0) || 1
    const container = new SplitContainer()
    container.orientation = node.orientation === 'horizontal' ? 'h' : 'v'
    container.children = children
    container.ratios = ratios.map((r) => r / sum)
    return container
  }

  private async createPane(workspace: Workspace, pane: WorkspacePane): Promise<BaseTabComponent | null> {
    try {
      const token = await this.workspaces.createPaneToken(workspace, pane)
      const params = await this.tabRecovery.recoverTab(token as Any)
      if (!params) return null
      if (pane.startupCommand) {
        this.runtime.registerCommands([{ paneId: pane.id, command: pane.startupCommand }])
      }
      return this.tabsService.create(params)
    } catch (error) {
      console.error(`[${DISPLAY_NAME}] Could not create pane:`, pane, error)
      return null
    }
  }

  private livePanes(state: WorkspaceTabState): Map<string, BaseTabComponent> {
    const live = new Map<string, BaseTabComponent>()
    for (const tab of state.split.getAllTabs()) {
      const id = this.paneIdOf(tab)
      if (id) live.set(id, tab)
    }
    for (const [id, tab] of state.parked) live.set(id, tab)
    return live
  }

  private paneIdOf(tab: BaseTabComponent): string | null {
    return parsePaneMarker((tab as Any).profile?.group)?.paneId ?? null
  }

  /** Terminals refit on window resize; the split area changed. */
  private nudgeResize(): void {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
  }

  // ---------- pane changes from the sidebar ----------

  private async toggleShown(state: WorkspaceTabState, paneId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const pane = workspace?.panes.find((p) => p.id === paneId)
    if (!workspace || !pane) return
    const view = activeView(workspace)
    setPaneOn(view, paneId, !isPaneOn(view, paneId))
    await this.workspaces.saveWorkspaceQuietly(workspace)
    if (state.view.kind === 'all') await this.showAll(state)
    else this.render(state, true)
  }

  /** Copy of a pane right after it, switched on in the same views; starts and opens its editor. */
  private async duplicatePane(state: WorkspaceTabState, paneId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const source = workspace?.panes.find((p) => p.id === paneId)
    if (!workspace || !source) return
    const pane: WorkspacePane = { ...source, id: createDefaultPane().id }
    if (source.name) pane.name = `${source.name} copy`
    workspace.panes.splice(workspace.panes.indexOf(source) + 1, 0, pane)
    for (const view of workspace.views) setPaneOn(view, pane.id, isPaneOn(view, source.id))
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.editingPaneId = pane.id
    state.editingViewId = null
    this.render(state, true)
    await this.startAllPanes(state)
  }

  /**
   * The workspace's config file was edited and applied: bring its open tab in line
   * (title, colour, view), close panes that were removed and start new ones.
   */
  private async syncEdited(workspaceId: string, before: Workspace): Promise<void> {
    const workspace = this.workspaces.getWorkspace(workspaceId)
    const old = new Map(before.panes.map((p) => [p.id, p]))
    const changed = (workspace?.panes ?? []).filter((p) => {
      const o = old.get(p.id)
      if (!o) return false
      return (o.startupCommand ?? '') !== (p.startupCommand ?? '') || (o.cwd ?? '') !== (p.cwd ?? '') || o.profileId !== p.profileId
    }).map((p) => p.id)
    for (const state of [...this.active]) {
      if (state.workspaceId !== workspaceId) continue
      for (const id of changed) state.restartPending.add(id)
      await this.syncTab(state)
    }
  }

  private async syncTab(state: WorkspaceTabState): Promise<void> {
    // A layout change in progress would make this one a no-op: wait for it
    await this.waitFor(() => !state.busy && !state.starting, START_TIMEOUT_MS + 2000)
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace) return
    // In the background the grid can't be measured: sync when the tab is shown
    if (!this.paneArea(state)) {
      state.syncPending = true
      state.split.setTitle(workspace.name)
      this.applyTabColor(state)
      return
    }
    state.syncPending = false
    state.split.setTitle(workspace.name)
    this.applyTabColor(state)
    const ids = new Set(workspace.panes.map((p) => p.id))
    if (state.editingPaneId && !ids.has(state.editingPaneId)) state.editingPaneId = null
    if (state.editingViewId && !workspace.views.some((v) => v.id === state.editingViewId)) state.editingViewId = null
    if (state.view.kind === 'focus' && !ids.has(state.view.paneId)) state.view = { kind: 'all' }
    await this.reapplyView(state)
    const removed = () => [...this.livePanes(state)].filter(([id]) => !ids.has(id))
    const view = state.view
    if (removed().some(([, tab]) => tab.parent === state.split)) {
      // The view couldn't be shown without them: show the first pane, so the split never runs empty
      await this.showFocus(state, workspace.panes[0].id)
    }
    for (const [id, tab] of removed()) {
      if (tab.parent === state.split) continue
      state.parked.delete(id)
      tab.destroy()
    }
    // Back to the view from before the fallback
    if (view.kind === 'all' && state.view.kind === 'focus') await this.showAll(state, true)
    // Changed command, folder or profile: restart those panes, as the pane editor's Restart does
    for (const id of [...state.restartPending]) {
      state.restartPending.delete(id)
      if (ids.has(id) && this.livePanes(state).has(id)) await this.restartPane(state, id)
    }
    this.render(state, true)
    if (workspace.panes.some((p) => !this.livePanes(state).has(p.id))) await this.startAllPanes(state)
  }

  private async movePane(state: WorkspaceTabState, paneId: string, beforePaneId: string | null): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace) return
    const from = workspace.panes.findIndex((p) => p.id === paneId)
    if (from === -1 || paneId === beforePaneId) return
    const [pane] = workspace.panes.splice(from, 1)
    const to = beforePaneId ? workspace.panes.findIndex((p) => p.id === beforePaneId) : -1
    workspace.panes.splice(to === -1 ? workspace.panes.length : to, 0, pane)
    await this.workspaces.saveWorkspaceQuietly(workspace)
    if (state.view.kind === 'all') await this.showAll(state)
    else this.render(state, true)
  }

  private async addPane(state: WorkspaceTabState): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace) return
    await this.loadProfiles()
    const last = workspace.panes[workspace.panes.length - 1]
    const pane: WorkspacePane = {
      ...createDefaultPane(),
      profileId: last?.profileId || this.profiles[0]?.id || '',
      cwd: last?.cwd || '',
    }
    workspace.panes.push(pane)
    // A new pane is switched on in the selected view only
    const current = activeView(workspace)
    for (const view of workspace.views) {
      if (view !== current) setPaneOn(view, pane.id, false)
    }
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.editingPaneId = pane.id
    state.editingViewId = null
    state.menuOpen = false
    this.render(state, true)
  }

  private async savePane(state: WorkspaceTabState, paneId: string, fields: Partial<WorkspacePane>): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const pane = workspace?.panes.find((p) => p.id === paneId)
    if (!workspace || !pane) return
    Object.assign(pane, fields)
    // Optional fields are stored only when set (the config file never gets empty keys)
    for (const key of ['name', 'color'] as const) {
      if (!pane[key]) delete pane[key]
    }
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.editingPaneId = null
    this.render(state, true)
    // Every pane runs: a new pane starts as soon as it is saved
    if (!this.livePanes(state).has(paneId)) await this.startAllPanes(state)
  }

  /**
   * Closes the pane's terminal and starts it again with its current settings
   * (command, folder, profile). On screen it is swapped in place, so the tab stays open.
   */
  private async restartPane(state: WorkspaceTabState, paneId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const pane = workspace?.panes.find((p) => p.id === paneId)
    if (!workspace || !pane) return
    const old = this.livePanes(state).get(paneId)
    const fresh = await this.createPane(workspace, pane)
    if (!fresh) return
    if (old && state.parked.get(paneId) === old) {
      state.parked.set(paneId, fresh)
      old.destroy()
    } else if (old && old.parent === state.split) {
      fresh.parent = state.split
      ;(state.split as Any).replaceTab(old, fresh)
      ;(state.split as Any).viewRefs?.delete(old)
      old.destroy()
      ;(state.split as Any).layout()
      state.split.focus(fresh)
      this.nudgeResize()
    } else {
      state.parked.set(paneId, fresh)
    }
    this.render(state, true)
  }

  private async removePane(state: WorkspaceTabState, paneId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const pane = workspace?.panes.find((p) => p.id === paneId)
    if (!workspace || !pane) return
    if (workspace.panes.length <= 1) {
      window.alert('A workspace needs at least one pane. Delete the workspace from its menu instead.')
      return
    }
    const label = pane.name || pane.startupCommand || 'this pane'
    if (!window.confirm(`Remove "${label}" from ${workspace.name}? Its terminal is closed.`)) return

    workspace.panes = workspace.panes.filter((p) => p.id !== paneId)
    for (const view of workspace.views) setPaneOn(view, paneId, true)
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.editingPaneId = null

    const tab = this.livePanes(state).get(paneId)
    const onScreen = !!tab && tab.parent === state.split
    if (onScreen) {
      // Show the rest first, so the split never runs empty (an empty split closes the tab)
      if (state.view.kind === 'focus' && state.view.paneId === paneId) state.view = { kind: 'all' }
      await this.reapplyView(state)
    }
    const still = this.livePanes(state).get(paneId)
    if (still && still.parent === state.split && state.split.getAllTabs().length <= 1) {
      // Nothing else can be shown: switch another pane on and show it
      const other = workspace.panes[0]
      setPaneOn(activeView(workspace), other.id, true)
      await this.workspaces.saveWorkspaceQuietly(workspace)
      await this.showFocus(state, other.id)
    }
    state.parked.delete(paneId)
    this.livePanes(state).get(paneId)?.destroy()
    tab?.destroy()
    this.render(state, true)
  }

  // ---------- views ----------

  /** Selects a view (saved with the workspace) and shows its grid. */
  private async selectView(state: WorkspaceTabState, viewId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace || !workspace.views.some((v) => v.id === viewId)) return
    if (workspace.activeViewId !== viewId) {
      workspace.activeViewId = viewId
      await this.workspaces.saveWorkspaceQuietly(workspace)
    }
    await this.showAll(state, true)
  }

  /** New view with every pane switched on; selected and opened for naming. */
  private async addView(state: WorkspaceTabState): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace) return
    const names = new Set(workspace.views.map((v) => v.name))
    let n = workspace.views.length + 1
    while (names.has(`View ${n}`)) n++
    const view = createDefaultView(`View ${n}`)
    workspace.views.push(view)
    workspace.activeViewId = view.id
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.editingViewId = view.id
    state.editingPaneId = null
    state.menuOpen = false
    await this.showAll(state, true)
  }

  private async renameView(state: WorkspaceTabState, viewId: string, name: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const view = workspace?.views.find((v) => v.id === viewId)
    if (!workspace || !view) return
    view.name = name.trim() || view.name
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.editingViewId = null
    this.render(state, true)
  }

  /** Copy of a view (same switches), selected and opened for naming. */
  private async duplicateView(state: WorkspaceTabState, viewId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const source = workspace?.views.find((v) => v.id === viewId)
    if (!workspace || !source) return
    const view: WorkspaceView = { ...createDefaultView(`${source.name} copy`), ...(source.hidden?.length ? { hidden: [...source.hidden] } : {}) }
    workspace.views.splice(workspace.views.indexOf(source) + 1, 0, view)
    workspace.activeViewId = view.id
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.editingViewId = view.id
    await this.showAll(state, true)
  }

  private async deleteView(state: WorkspaceTabState, viewId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const view = workspace?.views.find((v) => v.id === viewId)
    if (!workspace || !view) return
    if (workspace.views.length <= 1) {
      window.alert('A workspace needs at least one view.')
      return
    }
    if (!window.confirm(`Delete the view "${view.name}"? Its panes keep running.`)) return
    const wasActive = activeView(workspace) === view
    workspace.views = workspace.views.filter((v) => v !== view)
    if (wasActive) workspace.activeViewId = workspace.views[0].id
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.editingViewId = null
    if (wasActive && state.view.kind === 'all') await this.showAll(state, true)
    else this.render(state, true)
  }

  // ---------- workspace changes from the sidebar ----------

  private async saveWorkspaceSettings(
    state: WorkspaceTabState,
    fields: { name: string, minPaneWidth: number | null, minPaneHeight: number | null, launchOnStartup: boolean, color: string, folder: string }
  ): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace) return
    workspace.name = fields.name.trim() || workspace.name
    for (const key of ['minPaneWidth', 'minPaneHeight'] as const) {
      const value = fields[key]
      if (value && value > 0) workspace[key] = Math.round(value)
      else delete workspace[key]
    }
    if (fields.launchOnStartup) workspace.launchOnStartup = true
    else workspace.launchOnStartup = false
    if (fields.color) workspace.color = fields.color
    else delete workspace.color
    if (fields.folder.trim()) workspace.folder = fields.folder.trim()
    else delete workspace.folder
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.split.setTitle(workspace.name)
    this.applyTabColor(state)
    state.menuOpen = false
    if (state.view.kind === 'all') await this.showAll(state)
    else this.render(state, true)
  }

  private async deleteWorkspace(state: WorkspaceTabState): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace) return
    if (!window.confirm(`Delete the workspace "${workspace.name}"? Its tab and all its panes are closed.`)) return
    await this.workspaces.deleteWorkspace(workspace.id)
    const app = this.app as Any
    if (typeof app.closeTab === 'function') app.closeTab(state.split, false)
    else state.split.destroy()
  }

  // ---------- sidebar ----------

  /**
   * DOM element of the workspace tab. Tabby's tab-body inserts a top-level tab's
   * `hostView` directly (viewContainerEmbeddedRef is only set for panes inside a split).
   */
  private splitElement(state: WorkspaceTabState): HTMLElement | null {
    const split = state.split as Any
    for (const ref of [split.hostView, split.viewContainerEmbeddedRef]) {
      const el = ref?.rootNodes?.[0]
      if (el instanceof HTMLElement) return el
    }
    return null
  }

  private mountSidebar(state: WorkspaceTabState): void {
    const splitEl = this.splitElement(state)
    const host = splitEl?.parentElement
    if (!splitEl || !host) {
      // Not in the DOM yet: retry shortly (also retried by every scan of the split)
      setTimeout(() => {
        if (!state.sidebar?.isConnected && this.active.has(state)) this.mountSidebar(state)
      }, 500)
      return
    }
    if (!state.sidebar) {
      state.sidebar = document.createElement('div')
      state.sidebar.className = 'paneworks-sidebar'
      this.ensureStyles()
    }
    host.insertBefore(state.sidebar, splitEl)
    // Scope for the pane frames (see ensureStyles)
    splitEl.setAttribute('data-paneworks', '')
    this.render(state, true)
    this.nudgeResize()
    // The pane area is known now: fit the grid to it
    setTimeout(() => this.refreshGrid(state), 100)
  }

  /**
   * Pane label colours. Tabby renders one <split-tab-pane-label> per pane, in the
   * order of split.getAllTabs(), and recreates them when panes change; so this runs
   * on every sidebar tick and after every layout change.
   */
  private applyLabelColors(state: WorkspaceTabState, workspace: Workspace | undefined): void {
    const splitEl = this.splitElement(state)
    if (!splitEl || !workspace) return
    const colors = new Map(workspace.panes.map((p) => [p.id, p.color]))
    const labels = Array.from(splitEl.querySelectorAll(':scope > split-tab-pane-label'))
    const tabs = state.split.getAllTabs()
    labels.forEach((label, i) => {
      const name = label.querySelector('.custom-name') as HTMLElement | null
      if (!name) return
      const id = tabs[i] ? this.paneIdOf(tabs[i]) : null
      const color = id ? colors.get(id) : undefined
      if (color) {
        name.style.background = color
        name.style.color = readableTextColor(color)
      } else {
        name.style.removeProperty('background')
        name.style.removeProperty('color')
      }
    })
  }

  /**
   * Subscribes once to each pane's terminal output for "NEW": output while the pane
   * is off screen, after the grace period, marks it until the pane is shown again.
   */
  private watchOutput(state: WorkspaceTabState): void {
    for (const [id, tab] of this.livePanes(state)) {
      const session = (tab as Any).session
      if (!session?.output$ || this.watchedSessions.has(session)) continue
      this.watchedSessions.add(session)
      session.output$.subscribe(() => {
        if (tab.parent === state.split || state.unseen.has(id)) return // on screen, or already marked
        if (Date.now() - (state.leftAt.get(id) ?? 0) < NEW_OUTPUT_GRACE_MS) return
        state.unseen.add(id)
      })
    }
  }

  private render(state: WorkspaceTabState, force = false): void {
    const el = state.sidebar
    if (!el || !el.isConnected || state.dragging) return
    this.watchOutput(state)
    this.applyLabelColors(state, this.workspaces.getWorkspace(state.workspaceId))
    if (!force && (state.editingPaneId || state.editingViewId || state.menuOpen)) return
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const live = this.livePanes(state)
    const onScreen = new Set(state.split.getAllTabs().map((t) => this.paneIdOf(t)))

    // Redraw only on change: a redraw between mousedown and mouseup would swallow the click
    const signature = JSON.stringify([
      state.collapsed, state.view, state.editingPaneId, state.editingViewId, state.menuOpen, workspace,
      workspace?.panes.map((p) => {
        const tab = live.get(p.id)
        return [tab?.customTitle, tab?.title, state.unseen.has(p.id), onScreen.has(p.id)]
      }),
    ])
    if (!force && (el as Any).__pwSignature === signature) return
    ;(el as Any).__pwSignature = signature

    // Open editors are rebuilt below: keep what was typed and where the cursor was
    const owner = state.editingPaneId ? `p:${state.editingPaneId}` : state.editingViewId ? `v:${state.editingViewId}`
      : state.menuOpen ? 'm' : null
    const opened = owner !== state.draftOwner
    if (opened) {
      state.drafts.clear()
      state.draftOwner = owner
    }
    const active = document.activeElement as HTMLInputElement | null
    const focusKey = active && el.contains(active) ? active.dataset?.draft ?? null : null
    const selection = focusKey && typeof active!.selectionStart === 'number' ? [active!.selectionStart, active!.selectionEnd] : null
    this.autofocus = opened

    el.classList.toggle('collapsed', state.collapsed)
    el.style.flex = `0 0 ${state.collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH}px`
    el.textContent = ''

    const toggle = this.button('pw-icon-btn pw-toggle', state.collapsed ? '»' : '«',
      state.collapsed ? 'Show sidebar' : 'Hide sidebar', () => {
        state.collapsed = !state.collapsed
        this.saveCollapsed(state.workspaceId, state.collapsed)
        this.render(state, true)
        this.nudgeResize()
      })
    if (state.collapsed || !workspace) {
      el.append(toggle)
      return
    }

    // Header: workspace name opens the workspace menu
    const header = this.node('div', 'pw-header')
    const wsButton = this.button('pw-ws', '', 'Workspace menu', () => {
      state.menuOpen = !state.menuOpen
      state.editingPaneId = null
      state.editingViewId = null
      this.render(state, true)
    })
    wsButton.append(this.node('span', 'pw-ws-name', workspace.name), this.node('span', 'pw-caret', state.menuOpen ? '▴' : '▾'))
    const folder = this.workspaces.projectFolder(workspace)
    const code = this.button('pw-icon-btn pw-code', '',
      folder ? `Open ${folder.path} in VS Code` : 'Open in VS Code (no project folder yet: set one in the workspace menu)',
      () => this.workspaces.openInVsCode(workspace))
    code.innerHTML = ICON_CODE
    const copy = this.button('pw-icon-btn pw-code', '',
      folder ? `Copy ${folder.path}` : 'Copy the project folder path (no project folder yet: set one in the workspace menu)',
      () => this.workspaces.copyProjectFolder(workspace))
    copy.innerHTML = ICON_COPY
    header.append(wsButton, copy, code, toggle)
    el.append(header)
    if (state.menuOpen) el.append(this.workspaceMenu(state, workspace))

    // Views: click one to show its switched-on panes in a grid
    const current = activeView(workspace)
    const views = this.node('div', 'pw-section')
    views.append(
      this.node('span', '', 'Views'),
      this.button('pw-icon-btn pw-add', '+', 'Add a view (all panes on)', () => this.addView(state))
    )
    el.append(views)
    for (const view of workspace.views) {
      el.append(this.viewRow(state, workspace, view, view === current, onScreen))
      if (state.editingViewId === view.id) el.append(this.viewEditor(state, workspace, view))
    }
    if (!workspace.panes.some((p) => isPaneOn(current, p.id))) {
      el.append(this.node('div', 'pw-hint pw-empty-view', `Nothing is switched on in "${current.name}": switch panes on below.`))
    }

    // Panes; the switches belong to the selected view
    const section = this.node('div', 'pw-section')
    section.append(
      this.node('span', 'pw-section-title', `Panes · ${current.name}`),
      this.button('pw-icon-btn pw-add', '+', 'Add a pane', () => this.addPane(state))
    )
    el.append(section)

    const focused = state.view.kind === 'focus' ? state.view.paneId : null
    const list = this.node('div', 'pw-list')
    for (const pane of workspace.panes) {
      list.append(this.paneRow(state, pane, live.get(pane.id), onScreen.has(pane.id), focused, isPaneOn(current, pane.id), current.name))
      if (state.editingPaneId === pane.id) list.append(this.paneEditor(state, pane))
    }
    const endZone = this.node('div', 'pw-drop-end')
    this.makeDropTarget(state, endZone, null)
    list.append(endZone)
    el.append(list)

    if (focusKey) {
      const again = el.querySelector(`[data-draft="${focusKey}"]`) as HTMLInputElement | null
      if (again) {
        again.focus()
        if (selection) try { again.setSelectionRange(selection[0], selection[1]) } catch { /* not a text field */ }
      }
    }
  }

  /** Set while rendering: whether the open editor was just opened (and gets the focus). */
  private autofocus = false

  /** Ties a form field to the drafts: shows the unsaved value, records every change. */
  private draft<T extends HTMLInputElement | HTMLSelectElement>(state: WorkspaceTabState, key: string, field: T): T {
    field.dataset.draft = key
    const isCheck = field instanceof HTMLInputElement && field.type === 'checkbox'
    const saved = state.drafts.get(key)
    if (saved !== undefined) {
      if (isCheck) (field as HTMLInputElement).checked = saved === '1'
      else field.value = saved
    }
    const record = () => state.drafts.set(key, isCheck ? ((field as HTMLInputElement).checked ? '1' : '0') : field.value)
    field.addEventListener('input', record)
    field.addEventListener('change', record)
    return field
  }

  /** Colour picker whose choice is kept in the drafts. */
  private draftColor(state: WorkspaceTabState, key: string, initial: string): { element: HTMLElement, value: () => string } {
    return this.colorPicker(state.drafts.get(key) ?? initial, (color) => state.drafts.set(key, color))
  }

  private paneRow(
    state: WorkspaceTabState,
    pane: WorkspacePane,
    tab: BaseTabComponent | undefined,
    onScreen: boolean,
    focused: string | null,
    on: boolean,
    viewName: string
  ): HTMLElement {
    const title = (tab ? (tab.customTitle || tab.title) : '') || pane.name || pane.startupCommand || 'New pane'
    const sub = [pane.name, pane.startupCommand].filter(Boolean).join(' · ')
    const noRoom = on && !onScreen && state.view.kind === 'all'
    const hasNews = !onScreen && state.unseen.has(pane.id)

    const classes = ['pw-row', 'pw-pane']
    if (onScreen) classes.push('onscreen')
    if (pane.id === focused) classes.push('focused')
    if (!on) classes.push('off')
    if (state.editingPaneId === pane.id) classes.push('editing')
    const row = this.node('div', classes.join(' '))
    row.title = [
      onScreen ? 'On screen' : tab ? 'Running, not on screen' : 'Not running (shown again by a view or its title)',
      !on ? `switched off in "${viewName}"` : noRoom ? 'switched on, but no room at the minimum pane size' : '',
    ].filter(Boolean).join(' · ')

    // Sorting: drag the row (the handle shows where to grab)
    row.draggable = true
    row.append(this.node('span', 'pw-handle', '⋮⋮'))
    row.addEventListener('dragstart', (e) => {
      state.dragging = true
      e.dataTransfer?.setData('text/plain', pane.id)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      row.classList.add('dragging')
    })
    row.addEventListener('dragend', () => {
      state.dragging = false
      row.classList.remove('dragging')
      this.render(state, true)
    })
    this.makeDropTarget(state, row, pane.id)

    const swatch = this.node('span', 'pw-pane-color' + (pane.color ? '' : ' none'))
    if (pane.color) swatch.style.background = pane.color
    swatch.title = pane.color ? `Label colour ${pane.color}` : 'No label colour'
    row.append(swatch)

    const text = this.node('span', 'pw-text')
    const main = this.node('span', 'pw-main')
    main.append(this.node('span', 'pw-name', title))
    if (hasNews) {
      const news = this.node('span', 'pw-news', 'new')
      news.title = 'New output since it left the screen'
      main.append(news)
    }
    text.append(main)
    if (sub || noRoom) text.append(this.node('span', 'pw-sub', [sub, noRoom ? 'no room' : ''].filter(Boolean).join(' · ')))
    text.onclick = () => {
      if (pane.id === focused) this.showAll(state, true)
      else this.showFocus(state, pane.id)
    }
    text.title = pane.id === focused ? `Back to "${viewName}"` : 'Show this pane alone'

    const sw = this.node('label', 'pw-switch')
    sw.title = on ? `On: shown in "${viewName}"` : `Off: not in "${viewName}"`
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = on
    input.onchange = () => this.toggleShown(state, pane.id)
    sw.append(input, this.node('span', 'pw-slider'))
    sw.addEventListener('click', (e) => e.stopPropagation())

    const more = this.button('pw-icon-btn pw-more', '⋯', 'Edit pane', () => {
      state.editingPaneId = state.editingPaneId === pane.id ? null : pane.id
      state.editingViewId = null
      state.menuOpen = false
      this.render(state, true)
    })

    row.append(text, sw, more)
    return row
  }

  private viewRow(
    state: WorkspaceTabState,
    workspace: Workspace,
    view: WorkspaceView,
    selected: boolean,
    onScreen: Set<string | null>
  ): HTMLElement {
    const enabled = workspace.panes.filter((p) => isPaneOn(view, p.id))
    const showing = selected && state.view.kind === 'all'
    const shownCount = enabled.filter((p) => onScreen.has(p.id)).length
    const classes = ['pw-row', 'pw-all', 'pw-view']
    if (showing) classes.push('active')
    else if (selected) classes.push('selected')
    if (state.editingViewId === view.id) classes.push('editing')
    const row = this.node('div', classes.join(' '))
    row.append(
      this.node('span', 'pw-main', view.name),
      this.node('span', 'pw-count', showing ? `${shownCount} / ${enabled.length}` : `${enabled.length} on`),
      this.button('pw-icon-btn pw-more', '⋯', 'Edit view', () => {
        state.editingViewId = state.editingViewId === view.id ? null : view.id
        state.editingPaneId = null
        state.menuOpen = false
        this.render(state, true)
      })
    )
    row.title = selected
      ? 'Selected view: the pane switches below belong to it. Click to show its panes in a grid'
      : 'Select this view and show its switched-on panes in a grid'
    row.onclick = () => this.selectView(state, view.id)
    return row
  }

  private viewEditor(state: WorkspaceTabState, workspace: Workspace, view: WorkspaceView): HTMLElement {
    const box = this.node('div', 'pw-form')
    const name = this.draft(state, 'name', this.input('text', view.name, 'View name'))
    box.append(
      this.field('Name', name),
      this.node('div', 'pw-hint', 'Select the view, then use the pane switches to choose what it shows.'),
    )
    const save = () => this.renameView(state, view.id, name.value)
    name.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save()
      if (e.key === 'Escape') { state.editingViewId = null; this.render(state, true) }
    })
    const actions = this.node('div', 'pw-actions')
    actions.append(
      this.button('pw-btn primary', 'Save', 'Save the view name', save),
      this.button('pw-btn', 'Duplicate', 'New view with the same switches', () => this.duplicateView(state, view.id)),
    )
    if (workspace.views.length > 1) {
      actions.append(this.button('pw-btn danger', 'Delete', 'Delete this view (panes keep running)', () => this.deleteView(state, view.id)))
    }
    box.append(actions)
    if (this.autofocus) setTimeout(() => { name.focus(); name.select() }, 0)
    return box
  }

  private paneEditor(state: WorkspaceTabState, pane: WorkspacePane): HTMLElement {
    const box = this.node('div', 'pw-form')
    const name = this.draft(state, 'name', this.input('text', pane.name ?? '', 'optional'))
    const command = this.draft(state, 'command', this.input('text', pane.startupCommand ?? '', 'e.g. c 1'))
    const cwd = this.draft(state, 'cwd', this.input('text', pane.cwd ?? '', 'C:\\path or /home/user'))
    const profile = document.createElement('select')
    profile.className = 'pw-input'
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = '-- profile --'
    profile.append(empty)
    for (const p of this.profiles) {
      const option = document.createElement('option')
      option.value = p.id
      option.textContent = p.name
      profile.append(option)
    }
    profile.value = pane.profileId ?? ''
    this.draft(state, 'profile', profile)

    const colors = this.draftColor(state, 'color', pane.color ?? '')

    box.append(
      this.field('Name', name),
      this.field('Label colour', colors.element),
      this.field('Startup command', command),
      this.field('Folder', cwd),
      this.field('Profile', profile),
      this.node('div', 'pw-hint', 'Command, folder and profile apply when the pane (re)starts.'),
    )
    const save = () => this.savePane(state, pane.id, {
      name: name.value.trim(),
      color: colors.value(),
      startupCommand: command.value.trim(),
      cwd: cwd.value.trim(),
      profileId: profile.value,
    })
    for (const field of [name, command, cwd]) {
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') { state.editingPaneId = null; this.render(state, true) }
      })
    }
    const actions = this.node('div', 'pw-actions')
    actions.append(
      this.button('pw-btn primary', 'Save', 'Save the pane settings', save),
      this.button('pw-btn', 'Restart', 'Save, then close and start the pane again', async () => {
        await save()
        await this.restartPane(state, pane.id)
      }),
      this.button('pw-btn', 'Duplicate', 'Save, then add a copy of this pane (same settings and view switches)', async () => {
        await save()
        await this.duplicatePane(state, pane.id)
      }),
      this.button('pw-btn danger', 'Remove', 'Remove the pane from the workspace', () => this.removePane(state, pane.id)),
    )
    box.append(actions)
    if (this.autofocus) setTimeout(() => name.focus(), 0)
    return box
  }

  /** Colour choice: presets, a custom picker, or none (''). */
  private colorPicker(initial: string, onChange?: (color: string) => void): { element: HTMLElement, value: () => string } {
    let chosen = initial
    const colors = this.node('div', 'pw-colors')
    const custom = document.createElement('input')
    custom.type = 'color'
    custom.className = 'pw-color-custom'
    custom.title = 'Custom colour'
    const paint = () => {
      colors.querySelectorAll('.pw-swatch').forEach((s) => {
        s.classList.toggle('selected', (s as HTMLElement).dataset.color === chosen)
      })
      custom.classList.toggle('selected', !!chosen && !PANE_COLORS.includes(chosen))
      if (chosen) custom.value = chosen
    }
    for (const color of ['', ...PANE_COLORS]) {
      const swatch = this.button('pw-swatch' + (color ? '' : ' none'), '', color ? color : 'No colour', () => {
        chosen = color
        onChange?.(chosen)
        paint()
      })
      swatch.dataset.color = color
      if (color) swatch.style.background = color
      colors.append(swatch)
    }
    custom.addEventListener('input', () => {
      chosen = custom.value
      onChange?.(chosen)
      paint()
    })
    colors.append(custom)
    paint()
    return { element: colors, value: () => chosen }
  }

  private workspaceMenu(state: WorkspaceTabState, workspace: Workspace): HTMLElement {
    const box = this.node('div', 'pw-form pw-menu')
    const name = this.draft(state, 'name', this.input('text', workspace.name, 'Workspace name'))
    const minW = this.draft(state, 'minW', this.input('number', workspace.minPaneWidth ? String(workspace.minPaneWidth) : '', String(DEFAULT_MIN_PANE_WIDTH)))
    const minH = this.draft(state, 'minH', this.input('number', workspace.minPaneHeight ? String(workspace.minPaneHeight) : '', String(DEFAULT_MIN_PANE_HEIGHT)))
    minW.classList.add('pw-size')
    minH.classList.add('pw-size')
    const size = this.node('div', 'pw-size-row')
    size.append(minW, this.node('span', '', '×'), minH, this.node('span', '', 'px'))
    const startup = document.createElement('input')
    startup.type = 'checkbox'
    startup.checked = !!workspace.launchOnStartup
    this.draft(state, 'startup', startup)
    const startupLabel = this.node('label', 'pw-check')
    startupLabel.append(startup, this.node('span', '', 'Open when Tabby starts'))
    const tabColor = this.draftColor(state, 'color', workspace.color ?? '')
    const firstPaneFolder = workspace.panes.find((p) => p.cwd?.trim())?.cwd?.trim()
    const folder = this.draft(state, 'folder', this.input('text', workspace.folder ?? '', firstPaneFolder || 'C:\\path or /home/user'))

    box.append(
      this.field('Name', name),
      this.field('Tab colour', tabColor.element),
      this.field('Project folder', folder),
      this.node('div', 'pw-hint', 'Opened by the VS Code button. Empty: the first pane folder.'),
      this.field('Minimum pane size', size),
      this.node('div', 'pw-hint', 'A view fits as many switched-on panes as this size allows.'),
      startupLabel,
    )
    const save = () => this.saveWorkspaceSettings(state, {
      name: name.value,
      minPaneWidth: Number(minW.value) || null,
      minPaneHeight: Number(minH.value) || null,
      launchOnStartup: startup.checked,
      color: tabColor.value(),
      folder: folder.value,
    })
    for (const field of [name, folder, minW, minH]) {
      field.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') save()
        if (e.key === 'Escape') { state.menuOpen = false; this.render(state, true) }
      })
    }
    const actions = this.node('div', 'pw-actions')
    actions.append(
      this.button('pw-btn primary', 'Save', 'Save the workspace settings', save),
      this.button('pw-btn', 'Close', 'Close the menu', () => { state.menuOpen = false; this.render(state, true) }),
    )
    box.append(actions)
    box.append(
      this.button('pw-menu-item', 'Edit settings in VS Code', 'Open this workspace as a JSON file; every save there is applied right away', () => {
        state.menuOpen = false
        this.render(state, true)
        this.workspaces.openConfigInVsCode(workspace)
      }),
    )

    // Other workspaces
    box.append(this.node('div', 'pw-menu-title', 'Workspaces'))
    for (const other of this.workspaces.getWorkspaces()) {
      const isThis = other.id === workspace.id
      const open = !isThis && !!this.findOpenTab(other.id)
      const item = this.button('pw-menu-item' + (isThis ? ' current' : ''), '',
        isThis ? 'This workspace' : open ? 'Switch to its tab' : 'Open it', () => {
          if (isThis) return
          state.menuOpen = false
          this.render(state, true)
          this.openWorkspace(other.id)
        })
      item.append(this.node('span', 'pw-name', other.name), this.node('span', 'pw-count', isThis ? 'this' : open ? 'open' : ''))
      box.append(item)
    }
    box.append(
      this.button('pw-menu-item', '+ New workspace', 'Create a workspace from a profile, folder and command', () => {
        state.menuOpen = false
        this.render(state, true)
        this.createWorkspace()
      }),
      this.button('pw-menu-item danger', 'Delete this workspace…', 'Delete it and close its tab', () => this.deleteWorkspace(state)),
    )
    return box
  }

  private makeDropTarget(state: WorkspaceTabState, el: HTMLElement, beforePaneId: string | null): void {
    el.addEventListener('dragover', (e) => {
      if (!state.dragging) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      el.classList.add('drop-before')
    })
    el.addEventListener('dragleave', () => el.classList.remove('drop-before'))
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      el.classList.remove('drop-before')
      const paneId = e.dataTransfer?.getData('text/plain')
      state.dragging = false
      if (paneId) this.movePane(state, paneId, beforePaneId)
    })
  }

  // ---------- DOM helpers ----------

  private node(tag: string, className: string, text?: string): HTMLElement {
    const el = document.createElement(tag)
    if (className) el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }

  private button(className: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = className
    el.textContent = text
    el.title = title
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })
    return el
  }

  private input(type: string, value: string, placeholder: string): HTMLInputElement {
    const el = document.createElement('input')
    el.type = type
    el.className = 'pw-input'
    el.value = value
    el.placeholder = placeholder
    // Keep Tabby's hotkeys out of the sidebar's text fields
    el.addEventListener('keydown', (e) => e.stopPropagation())
    return el
  }

  private field(label: string, control: HTMLElement): HTMLElement {
    const el = this.node('label', 'pw-field')
    el.append(this.node('span', 'pw-label', label), control)
    return el
  }

  private ensureStyles(): void {
    if (document.getElementById('paneworks-sidebar-styles')) return
    const style = document.createElement('style')
    style.id = 'paneworks-sidebar-styles'
    style.textContent = `
      /* Pane frames in Paneworks tabs: every pane gets a frame and a small gap,
         the pane with keyboard focus an accent frame. Tabby positions the panes
         (class "child") absolutely; border-box keeps them inside their slot. */
      [data-paneworks] > .child {
        box-sizing: border-box;
        border: 3px solid var(--theme-bg-more, rgba(0,0,0,.35));
        border-radius: 6px;
        overflow: hidden;
        transition: border-color .12s;
      }
      [data-paneworks] > .child.focused {
        border-color: var(--theme-primary, #4c9aff);
      }
      [data-paneworks] split-tab-pane-label .custom-name {
        font-weight: 600;
      }
      /* Split handles: Tabby's handle is a 10px band centred on the border between two
         panes. A bright 4px bar in its middle (inset 3px works for both orientations)
         stands out against the panes; brighter on hover, accent while dragging. */
      [data-paneworks] > split-tab-spanner::after {
        content: '';
        position: absolute;
        inset: 3px;
        border-radius: 2px;
        background: rgba(255, 255, 255, .30);
        background: color-mix(in srgb, var(--theme-fg, #fff) 32%, transparent);
        pointer-events: none;
        transition: background .12s;
      }
      [data-paneworks] > split-tab-spanner:hover::after {
        background: rgba(255, 255, 255, .55);
        background: color-mix(in srgb, var(--theme-fg, #fff) 60%, transparent);
      }
      [data-paneworks] > split-tab-spanner.active::after {
        background: var(--theme-primary, #4c9aff);
      }

      .paneworks-overlay {
        position: fixed; inset: 0; z-index: 10000; display: flex; align-items: flex-start; justify-content: center;
        padding-top: 12vh; background: rgba(0,0,0,.45);
      }
      .paneworks-sidebar.pw-dialog {
        width: 380px; max-width: calc(100vw - 32px); border: 1px solid var(--theme-bg-more-2, rgba(255,255,255,.12));
        border-radius: 6px; background: var(--theme-bg, #1e1e1e); box-shadow: 0 10px 40px rgba(0,0,0,.5); overflow: visible;
      }
      .paneworks-sidebar.pw-dialog .pw-form { margin: 0; padding: 14px; gap: 8px; background: none; }
      .paneworks-sidebar .pw-dialog-title { font-size: 14px; font-weight: 600; margin-bottom: 2px; }
      .paneworks-sidebar .pw-folder-row { display: flex; gap: 4px; }
      .paneworks-sidebar .pw-folder-row .pw-input { flex: 1; min-width: 0; }
      .paneworks-sidebar .pw-folder-row .pw-btn { flex: none; }

      .paneworks-sidebar {
        --pw-accent: var(--theme-primary, #4c9aff);
        display: flex; flex-direction: column; overflow-y: auto; overflow-x: hidden;
        background: var(--theme-bg-more, rgba(0,0,0,.25));
        border-right: 1px solid var(--theme-bg-more-2, rgba(255,255,255,.08));
        color: var(--theme-fg, inherit); font-size: 12px; user-select: none;
      }
      .paneworks-sidebar.collapsed { align-items: center; }
      .paneworks-sidebar button { font: inherit; color: inherit; }
      .paneworks-sidebar .pw-icon-btn {
        background: none; border: none; opacity: .6; cursor: pointer; padding: 2px 6px; line-height: 1; font-size: 13px;
      }
      .paneworks-sidebar .pw-icon-btn:hover { opacity: 1; }
      .paneworks-sidebar .pw-code { display: flex; align-items: center; }
      .paneworks-sidebar.collapsed .pw-toggle { margin-top: 8px; }

      .paneworks-sidebar .pw-header { display: flex; align-items: center; padding: 6px 4px 4px 4px; }
      .paneworks-sidebar .pw-ws {
        flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; background: none; border: none;
        padding: 4px 6px; border-radius: 4px; cursor: pointer; font-weight: 600; text-align: left;
      }
      .paneworks-sidebar .pw-ws:hover { background: rgba(127,127,127,.15); }
      .paneworks-sidebar .pw-ws-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .paneworks-sidebar .pw-caret { opacity: .5; font-size: 10px; }

      .paneworks-sidebar .pw-section {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 6px 2px 10px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; opacity: .6;
      }
      .paneworks-sidebar .pw-add { font-size: 15px; opacity: .9; }

      .paneworks-sidebar .pw-row {
        display: flex; align-items: center; gap: 6px; padding: 5px 4px 5px 4px;
        border-left: 3px solid transparent; border-top: 2px solid transparent;
      }
      .paneworks-sidebar .pw-row:hover { background: rgba(127,127,127,.10); }
      .paneworks-sidebar .pw-all { cursor: pointer; padding-left: 10px; }
      .paneworks-sidebar .pw-all .pw-main { flex: 1; font-weight: 600; }
      .paneworks-sidebar .pw-all.active { border-left-color: var(--pw-accent); background: rgba(127,127,127,.14); }
      .paneworks-sidebar .pw-count { font-size: 10px; opacity: .55; }
      .paneworks-sidebar .pw-view { padding-right: 4px; }
      .paneworks-sidebar .pw-view .pw-main { font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .paneworks-sidebar .pw-view.active .pw-main, .paneworks-sidebar .pw-view.selected .pw-main { font-weight: 600; }
      .paneworks-sidebar .pw-view.selected { border-left-color: rgba(127,127,127,.5); }
      .paneworks-sidebar .pw-view.editing { background: rgba(127,127,127,.14); }
      .paneworks-sidebar .pw-empty-view { padding: 4px 10px; }
      .paneworks-sidebar .pw-section-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

      /* Pane states: on screen = accent bar + full brightness; running elsewhere = dimmed;
         switched off = dimmer; focus view = highlighted row. */
      .paneworks-sidebar .pw-pane .pw-text { opacity: .6; }
      .paneworks-sidebar .pw-pane.onscreen { border-left-color: var(--pw-accent); }
      .paneworks-sidebar .pw-pane.onscreen .pw-text { opacity: 1; }
      .paneworks-sidebar .pw-pane.off .pw-text { opacity: .38; }
      .paneworks-sidebar .pw-pane.focused { background: rgba(127,127,127,.20); }
      .paneworks-sidebar .pw-pane.focused .pw-name { font-weight: 600; }
      .paneworks-sidebar .pw-pane.editing { background: rgba(127,127,127,.14); }

      .paneworks-sidebar .pw-pane-color { flex: 0 0 8px; height: 8px; border-radius: 2px; }
      .paneworks-sidebar .pw-pane-color.none { border: 1px dashed rgba(127,127,127,.5); box-sizing: border-box; }
      .paneworks-sidebar .pw-colors { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
      .paneworks-sidebar .pw-swatch {
        width: 16px; height: 16px; padding: 0; border-radius: 3px; cursor: pointer;
        border: 2px solid transparent; box-sizing: border-box;
      }
      .paneworks-sidebar .pw-swatch.none {
        background: repeating-linear-gradient(45deg, transparent 0 3px, rgba(127,127,127,.5) 3px 4px);
        border-color: rgba(127,127,127,.4);
      }
      .paneworks-sidebar .pw-swatch.selected, .paneworks-sidebar .pw-color-custom.selected {
        border-color: var(--theme-fg, #fff);
      }
      .paneworks-sidebar .pw-color-custom {
        width: 22px; height: 18px; padding: 0; border: 2px solid transparent; border-radius: 3px;
        background: none; cursor: pointer;
      }
      .paneworks-sidebar .pw-handle { cursor: grab; opacity: .25; font-size: 10px; letter-spacing: -2px; }
      .paneworks-sidebar .pw-row:hover .pw-handle { opacity: .7; }
      .paneworks-sidebar .pw-row.dragging { opacity: .35; }
      .paneworks-sidebar .drop-before { border-top-color: var(--pw-accent); }
      .paneworks-sidebar .pw-drop-end { flex: 1; min-height: 24px; border-top: 2px solid transparent; }

      .paneworks-sidebar .pw-text { display: flex; flex-direction: column; min-width: 0; flex: 1; cursor: pointer; }
      .paneworks-sidebar .pw-main { display: flex; align-items: center; gap: 5px; min-width: 0; }
      .paneworks-sidebar .pw-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .paneworks-sidebar .pw-sub { font-size: 10px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .paneworks-sidebar .pw-news {
        flex: none; font-size: 9px; line-height: 1; padding: 2px 4px; border-radius: 3px;
        background: var(--pw-accent); color: var(--theme-bg, #000); font-weight: 600; text-transform: uppercase;
      }
      .paneworks-sidebar .pw-more { opacity: .35; font-size: 14px; }
      .paneworks-sidebar .pw-row:hover .pw-more, .paneworks-sidebar .pw-row.editing .pw-more { opacity: .9; }

      .paneworks-sidebar .pw-switch { position: relative; flex: 0 0 26px; height: 14px; cursor: pointer; }
      .paneworks-sidebar .pw-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
      .paneworks-sidebar .pw-slider {
        position: absolute; inset: 0; border-radius: 7px; background: rgba(127,127,127,.35); transition: background .15s;
      }
      .paneworks-sidebar .pw-slider::before {
        content: ''; position: absolute; left: 2px; top: 2px; width: 10px; height: 10px; border-radius: 50%;
        background: var(--theme-fg, #fff); transition: transform .15s;
      }
      .paneworks-sidebar .pw-switch input:checked + .pw-slider { background: var(--pw-accent); }
      .paneworks-sidebar .pw-switch input:checked + .pw-slider::before { transform: translateX(12px); }

      .paneworks-sidebar .pw-form {
        display: flex; flex-direction: column; gap: 6px; margin: 2px 6px 6px 7px; padding: 8px;
        border-radius: 4px; background: rgba(127,127,127,.10); user-select: text;
      }
      .paneworks-sidebar .pw-menu { margin-top: 0; }
      .paneworks-sidebar .pw-field { display: flex; flex-direction: column; gap: 2px; margin: 0; }
      .paneworks-sidebar .pw-label { font-size: 10px; opacity: .6; }
      .paneworks-sidebar .pw-input {
        width: 100%; box-sizing: border-box; padding: 3px 6px; font: inherit; color: inherit; border-radius: 3px;
        background: var(--theme-bg, rgba(0,0,0,.3)); border: 1px solid rgba(127,127,127,.35);
      }
      .paneworks-sidebar .pw-input:focus { outline: none; border-color: var(--pw-accent); }
      .paneworks-sidebar .pw-size-row { display: flex; align-items: center; gap: 4px; }
      .paneworks-sidebar .pw-size { width: 64px; }
      .paneworks-sidebar .pw-check { display: flex; align-items: center; gap: 6px; margin: 0; cursor: pointer; }
      .paneworks-sidebar .pw-hint { font-size: 10px; opacity: .55; }
      .paneworks-sidebar .pw-actions { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 2px; }
      .paneworks-sidebar .pw-btn {
        padding: 3px 8px; border-radius: 3px; cursor: pointer; background: rgba(127,127,127,.2);
        border: 1px solid transparent;
      }
      .paneworks-sidebar .pw-btn:hover { background: rgba(127,127,127,.3); }
      .paneworks-sidebar .pw-btn.primary { background: var(--pw-accent); color: var(--theme-bg, #000); }
      .paneworks-sidebar .pw-btn.danger:hover { background: #c0392b; color: #fff; }
      .paneworks-sidebar .pw-menu-title { margin-top: 8px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; opacity: .6; }
      .paneworks-sidebar .pw-menu-item {
        display: flex; align-items: center; justify-content: space-between; gap: 6px; width: 100%;
        background: none; border: none; padding: 4px 6px; border-radius: 3px; cursor: pointer; text-align: left;
      }
      .paneworks-sidebar .pw-menu-item:hover { background: rgba(127,127,127,.2); }
      .paneworks-sidebar .pw-menu-item.current { cursor: default; font-weight: 600; }
      .paneworks-sidebar .pw-menu-item.danger:hover { background: #c0392b; color: #fff; }
    `
    document.head.appendChild(style)
  }

  private loadCollapsed(workspaceId: string): boolean {
    try {
      return localStorage.getItem(`paneworks-sidebar-collapsed:${workspaceId}`) === '1'
    } catch {
      return false
    }
  }

  private saveCollapsed(workspaceId: string, collapsed: boolean): void {
    try {
      localStorage.setItem(`paneworks-sidebar-collapsed:${workspaceId}`, collapsed ? '1' : '0')
    } catch {
      // per-viewer convenience only
    }
  }
}
