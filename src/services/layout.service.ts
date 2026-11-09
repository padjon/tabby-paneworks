import { Injectable } from '@angular/core'
import {
  AppService,
  BaseTabComponent,
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
  createDefaultPane,
  createDefaultWorkspace,
  isLayoutSplit,
  layoutPaneIds,
  parsePaneMarker,
} from '../models/workspace.model'
import { PaneRuntimeService } from './paneRuntime.service'
import { SIDEBAR_WIDTH, WorkspaceEditorService } from './workspaceEditor.service'

const SIDEBAR_COLLAPSED_WIDTH = 22
const REFRESH_MS = 1000
const RESIZE_DEBOUNCE_MS = 250

/** What a workspace tab shows: all switched-on panes in a grid, or one pane. */
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
  menuOpen: boolean
  timer: ReturnType<typeof setInterval> | null
}

// Tabby internals used here (stable across 1.0.x, not in the public typings):
// split.viewRefs, split.attachTabView(), split.onAfterTabAdded(), split.replaceTab(),
// split.maximizedTab, split.visibility$, tab.hostView (the top-level tab's DOM).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

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

  constructor(
    private app: AppService,
    private profilesService: ProfilesService,
    private runtime: PaneRuntimeService,
    private workspaces: WorkspaceEditorService,
    private tabsService: TabsService,
    private tabRecovery: TabRecoveryService
  ) {
    this.runtime.workspaceSplitFound$.subscribe(({ split, workspaceId }) => this.attach(split, workspaceId))
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
    const profile = await this.workspaces.generateTabbyProfile(workspace)
    if (profile) {
      this.profilesService.openNewTabForProfile(profile as Any)
    } else {
      // Nothing switched on: open the first pane so the tab (and its sidebar) exists
      const first = workspace.panes[0]
      if (!first) return
      first.hidden = false
      delete first.hidden
      await this.workspaces.saveWorkspaceQuietly(workspace)
      await this.openWorkspace(workspaceId)
    }
  }

  /** New workspace with one pane (profile of the first local shell); opened right away. */
  async createWorkspace(): Promise<void> {
    await this.loadProfiles()
    const existing = new Set(this.workspaces.getWorkspaces().map((w) => w.name))
    let n = 1
    while (existing.has(`Workspace ${n}`)) n++
    const workspace = createDefaultWorkspace(`Workspace ${n}`)
    const local = this.profiles.find((p) => p.type === 'local' || p.type?.startsWith('local:')) ?? this.profiles[0]
    workspace.panes = [{ ...createDefaultPane(), profileId: local?.id ?? '' }]
    await this.workspaces.addWorkspace(workspace)
    await this.openWorkspace(workspace.id)
  }

  private async loadProfiles(): Promise<void> {
    if (!this.profiles.length) {
      this.profiles = await this.workspaces.getAvailableProfiles()
    }
  }

  // ---------- attaching to a workspace tab ----------

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
      menuOpen: false,
      timer: null,
    }
    this.states.set(split, state)
    this.active.add(state)
    this.loadProfiles()

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
      if (visible) setTimeout(() => this.refreshGrid(state), 50)
    })

    this.mountSidebar(state)
    state.timer = setInterval(() => this.render(state), REFRESH_MS)
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
    if (state.view.kind === 'all' && !state.busy) this.showAll(state)
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
          if (id) state.parked.set(id, tab)
          else tab.destroy() // not a workspace pane (e.g. a manual split): close it
        }
      }

      const root = this.buildContainer(tree, live)
      if (!root) return false
      split.maximizedTab = null
      split.root = root

      // Attach the panes that enter the split
      for (const id of shown) {
        const tab = live.get(id)!
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
    if (pane.hidden) delete pane.hidden
    else pane.hidden = true
    await this.workspaces.saveWorkspaceQuietly(workspace)
    if (state.view.kind === 'all') await this.showAll(state)
    else this.render(state, true)
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
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.editingPaneId = pane.id
    state.menuOpen = false
    this.render(state, true)
  }

  private async savePane(state: WorkspaceTabState, paneId: string, fields: Partial<WorkspacePane>): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const pane = workspace?.panes.find((p) => p.id === paneId)
    if (!workspace || !pane) return
    Object.assign(pane, fields)
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.editingPaneId = null
    this.render(state, true)
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
      delete other.hidden
      await this.workspaces.saveWorkspaceQuietly(workspace)
      await this.showFocus(state, other.id)
    }
    state.parked.delete(paneId)
    this.livePanes(state).get(paneId)?.destroy()
    tab?.destroy()
    this.render(state, true)
  }

  // ---------- workspace changes from the sidebar ----------

  private async saveWorkspaceSettings(
    state: WorkspaceTabState,
    fields: { name: string, minPaneWidth: number | null, minPaneHeight: number | null, launchOnStartup: boolean }
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
    await this.workspaces.saveWorkspaceQuietly(workspace)
    state.split.setTitle(workspace.name)
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

  private render(state: WorkspaceTabState, force = false): void {
    const el = state.sidebar
    if (!el || !el.isConnected || state.dragging) return
    if (!force && (state.editingPaneId || state.menuOpen)) return
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const live = this.livePanes(state)
    const onScreen = new Set(state.split.getAllTabs().map((t) => this.paneIdOf(t)))

    // Redraw only on change: a redraw between mousedown and mouseup would swallow the click
    const signature = JSON.stringify([
      state.collapsed, state.view, state.editingPaneId, state.menuOpen, workspace,
      workspace?.panes.map((p) => {
        const tab = live.get(p.id)
        return [tab?.customTitle, tab?.title, tab?.hasActivity, onScreen.has(p.id)]
      }),
    ])
    if (!force && (el as Any).__pwSignature === signature) return
    ;(el as Any).__pwSignature = signature

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
      this.render(state, true)
    })
    wsButton.append(this.node('span', 'pw-ws-name', workspace.name), this.node('span', 'pw-caret', state.menuOpen ? '▴' : '▾'))
    header.append(wsButton, toggle)
    el.append(header)
    if (state.menuOpen) el.append(this.workspaceMenu(state, workspace))

    // View all
    const enabled = workspace.panes.filter((p) => !p.hidden)
    const shownCount = enabled.filter((p) => onScreen.has(p.id)).length
    const allRow = this.node('div', 'pw-row pw-all' + (state.view.kind === 'all' ? ' active' : ''))
    allRow.append(
      this.node('span', 'pw-main', 'View all'),
      this.node('span', 'pw-count', state.view.kind === 'all' ? `${shownCount} / ${enabled.length}` : `${enabled.length} on`)
    )
    allRow.title = 'Show all switched-on panes in a grid'
    allRow.onclick = () => this.showAll(state, true)
    el.append(allRow)

    // Panes
    const section = this.node('div', 'pw-section')
    section.append(
      this.node('span', '', 'Panes'),
      this.button('pw-icon-btn pw-add', '+', 'Add a pane', () => this.addPane(state))
    )
    el.append(section)

    const focused = state.view.kind === 'focus' ? state.view.paneId : null
    const list = this.node('div', 'pw-list')
    for (const pane of workspace.panes) {
      list.append(this.paneRow(state, pane, live.get(pane.id), onScreen.has(pane.id), focused))
      if (state.editingPaneId === pane.id) list.append(this.paneEditor(state, pane))
    }
    const endZone = this.node('div', 'pw-drop-end')
    this.makeDropTarget(state, endZone, null)
    list.append(endZone)
    el.append(list)
  }

  private paneRow(
    state: WorkspaceTabState,
    pane: WorkspacePane,
    tab: BaseTabComponent | undefined,
    onScreen: boolean,
    focused: string | null
  ): HTMLElement {
    const title = (tab ? (tab.customTitle || tab.title) : '') || pane.name || pane.startupCommand || 'New pane'
    const sub = [pane.name, pane.startupCommand].filter(Boolean).join(' · ')
    const noRoom = !pane.hidden && !onScreen && state.view.kind === 'all'
    const hasNews = !!tab && tab.hasActivity && !onScreen

    const classes = ['pw-row', 'pw-pane']
    if (onScreen) classes.push('onscreen')
    if (pane.id === focused) classes.push('focused')
    if (pane.hidden) classes.push('off')
    if (state.editingPaneId === pane.id) classes.push('editing')
    const row = this.node('div', classes.join(' '))
    row.title = [
      onScreen ? 'On screen' : tab ? 'Running, not on screen' : 'Not started yet',
      pane.hidden ? 'switched off (not in "View all")' : noRoom ? 'switched on, but no room at the minimum pane size' : '',
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
    text.title = pane.id === focused ? 'Back to "View all"' : 'Show this pane alone'

    const sw = this.node('label', 'pw-switch')
    sw.title = pane.hidden ? 'Off: not in "View all"' : 'On: in "View all"'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = !pane.hidden
    input.onchange = () => this.toggleShown(state, pane.id)
    sw.append(input, this.node('span', 'pw-slider'))
    sw.addEventListener('click', (e) => e.stopPropagation())

    const more = this.button('pw-icon-btn pw-more', '⋯', 'Edit pane', () => {
      state.editingPaneId = state.editingPaneId === pane.id ? null : pane.id
      state.menuOpen = false
      this.render(state, true)
    })

    row.append(text, sw, more)
    return row
  }

  private paneEditor(state: WorkspaceTabState, pane: WorkspacePane): HTMLElement {
    const box = this.node('div', 'pw-form')
    const name = this.input('text', pane.name ?? '', 'optional')
    const command = this.input('text', pane.startupCommand ?? '', 'e.g. c 1')
    const cwd = this.input('text', pane.cwd ?? '', 'C:\\path or /home/user')
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

    box.append(
      this.field('Name', name),
      this.field('Startup command', command),
      this.field('Folder', cwd),
      this.field('Profile', profile),
      this.node('div', 'pw-hint', 'Command, folder and profile apply when the pane (re)starts.'),
    )
    const save = () => this.savePane(state, pane.id, {
      name: name.value.trim(),
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
      this.button('pw-btn danger', 'Remove', 'Remove the pane from the workspace', () => this.removePane(state, pane.id)),
    )
    box.append(actions)
    setTimeout(() => name.focus(), 0)
    return box
  }

  private workspaceMenu(state: WorkspaceTabState, workspace: Workspace): HTMLElement {
    const box = this.node('div', 'pw-form pw-menu')
    const name = this.input('text', workspace.name, 'Workspace name')
    const minW = this.input('number', workspace.minPaneWidth ? String(workspace.minPaneWidth) : '', String(DEFAULT_MIN_PANE_WIDTH))
    const minH = this.input('number', workspace.minPaneHeight ? String(workspace.minPaneHeight) : '', String(DEFAULT_MIN_PANE_HEIGHT))
    minW.classList.add('pw-size')
    minH.classList.add('pw-size')
    const size = this.node('div', 'pw-size-row')
    size.append(minW, this.node('span', '', '×'), minH, this.node('span', '', 'px'))
    const startup = document.createElement('input')
    startup.type = 'checkbox'
    startup.checked = !!workspace.launchOnStartup
    const startupLabel = this.node('label', 'pw-check')
    startupLabel.append(startup, this.node('span', '', 'Open when Tabby starts'))

    box.append(
      this.field('Name', name),
      this.field('Minimum pane size', size),
      this.node('div', 'pw-hint', '"View all" fits as many switched-on panes as this size allows.'),
      startupLabel,
    )
    const save = () => this.saveWorkspaceSettings(state, {
      name: name.value,
      minPaneWidth: Number(minW.value) || null,
      minPaneHeight: Number(minH.value) || null,
      launchOnStartup: startup.checked,
    })
    for (const field of [name, minW, minH]) {
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
      this.button('pw-menu-item', '+ New workspace', 'Create a workspace with one pane', () => {
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

      /* Pane states: on screen = accent bar + full brightness; running elsewhere = dimmed;
         switched off = dimmer; focus view = highlighted row. */
      .paneworks-sidebar .pw-pane .pw-text { opacity: .6; }
      .paneworks-sidebar .pw-pane.onscreen { border-left-color: var(--pw-accent); }
      .paneworks-sidebar .pw-pane.onscreen .pw-text { opacity: 1; }
      .paneworks-sidebar .pw-pane.off .pw-text { opacity: .38; }
      .paneworks-sidebar .pw-pane.focused { background: rgba(127,127,127,.20); }
      .paneworks-sidebar .pw-pane.focused .pw-name { font-weight: 600; }
      .paneworks-sidebar .pw-pane.editing { background: rgba(127,127,127,.14); }

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
      .paneworks-sidebar .pw-row:hover .pw-more, .paneworks-sidebar .pw-pane.editing .pw-more { opacity: .9; }

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
