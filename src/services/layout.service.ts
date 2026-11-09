import { Injectable } from '@angular/core'
import { BaseTabComponent, SplitContainer, SplitTabComponent, TabRecoveryService, TabsService } from 'tabby-core'
import { DISPLAY_NAME } from '../build-config'
import {
  LayoutSplit,
  Workspace,
  WorkspacePane,
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
  timer: ReturnType<typeof setInterval> | null
}

// Tabby internals used here (stable across 1.0.x, not in the public typings):
// split.viewRefs, split.attachTabView(), split.onAfterTabAdded(), split.maximizedTab,
// split.visibility$, tab.viewContainerEmbeddedRef (the top-level tab's DOM via its view).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/**
 * Sidebar, "View all" grid and focus view for Paneworks workspace tabs.
 * Showing and hiding moves live panes in and out of the split (the way Tabby's own
 * drag and drop does), so hidden panes keep running; panes never shown before are
 * created on demand with their startup command. Closing the tab closes all panes.
 */
@Injectable()
export class LayoutService {
  private states = new WeakMap<SplitTabComponent, WorkspaceTabState>()
  private active = new Set<WorkspaceTabState>()
  private resizeTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
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
      timer: null,
    }
    this.states.set(split, state)
    this.active.add(state)

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
    // The tab opened with a grid estimated from the window size; fit it to the real area
    setTimeout(() => this.refreshGrid(state), 300)
  }

  // ---------- views ----------

  private async showAll(state: WorkspaceTabState, force = false): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const area = this.paneArea(state)
    if (!workspace || !area) return
    const plan = this.workspaces.planViewAll(workspace, area.width, area.height)
    const signature = JSON.stringify(plan.tree)
    const wasAll = state.view.kind === 'all'
    state.view = { kind: 'all' }
    if (plan.tree && (force || !wasAll || signature !== state.appliedPlan)) {
      if (await this.apply(state, workspace, plan.tree)) {
        state.appliedPlan = signature
      }
    }
    this.render(state)
  }

  private async showFocus(state: WorkspaceTabState, paneId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace) return
    const tree: LayoutSplit = { orientation: 'horizontal', ratios: [1], children: [{ paneId }] }
    if (await this.apply(state, workspace, tree)) {
      state.view = { kind: 'focus', paneId }
      state.appliedPlan = null
    }
    this.render(state)
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
        if (id && !shown.includes(id)) {
          tab.removeFromContainer()
          split.viewRefs?.delete(tab)
          tab.parent = null
          state.parked.set(id, tab)
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

  // ---------- pane settings from the sidebar ----------

  private async toggleShown(state: WorkspaceTabState, paneId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const pane = workspace?.panes.find((p) => p.id === paneId)
    if (!workspace || !pane) return
    if (pane.hidden) delete pane.hidden
    else pane.hidden = true
    await this.workspaces.saveWorkspaceQuietly(workspace)
    if (state.view.kind === 'all') await this.showAll(state)
    else this.render(state)
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
    else this.render(state)
  }

  // ---------- sidebar ----------

  private splitElement(state: WorkspaceTabState): HTMLElement | null {
    const el = (state.split as Any).viewContainerEmbeddedRef?.rootNodes?.[0]
    return el instanceof HTMLElement ? el : null
  }

  private mountSidebar(state: WorkspaceTabState): void {
    const splitEl = this.splitElement(state)
    const host = splitEl?.parentElement
    if (!splitEl || !host) return // not in the DOM yet; the next scan of the split retries
    if (!state.sidebar) {
      state.sidebar = document.createElement('div')
      state.sidebar.className = 'paneworks-sidebar'
      this.ensureStyles()
    }
    host.insertBefore(state.sidebar, splitEl)
    this.render(state, true)
    this.nudgeResize()
  }

  private render(state: WorkspaceTabState, force = false): void {
    const el = state.sidebar
    if (!el || !el.isConnected || state.dragging) return
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const live = this.livePanes(state)
    const onScreen = new Set(state.split.getAllTabs().map((t) => this.paneIdOf(t)))

    // Redraw only on change: a redraw between mousedown and mouseup would swallow the click
    const signature = JSON.stringify([
      state.collapsed, state.view, workspace?.name,
      workspace?.panes.map((p) => {
        const tab = live.get(p.id)
        return [p.id, p.name, p.startupCommand, p.hidden, tab?.customTitle, tab?.title, tab?.hasActivity, onScreen.has(p.id)]
      }),
    ])
    if (!force && (el as Any).__pwSignature === signature) return
    ;(el as Any).__pwSignature = signature

    el.classList.toggle('collapsed', state.collapsed)
    el.style.flex = `0 0 ${state.collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH}px`
    el.textContent = ''

    const toggle = this.node('button', 'pw-toggle', state.collapsed ? '»' : '«')
    toggle.title = state.collapsed ? 'Show sidebar' : 'Hide sidebar'
    toggle.onclick = () => {
      state.collapsed = !state.collapsed
      this.saveCollapsed(state.workspaceId, state.collapsed)
      this.render(state, true)
      this.nudgeResize()
    }
    if (state.collapsed || !workspace) {
      el.append(toggle)
      return
    }

    const header = this.node('div', 'pw-header')
    header.append(this.node('span', 'pw-title', workspace.name), toggle)
    el.append(header)

    // View all
    const enabled = workspace.panes.filter((p) => !p.hidden)
    const allRow = this.node('div', 'pw-row pw-all' + (state.view.kind === 'all' ? ' active' : ''))
    allRow.append(this.node('span', 'pw-main', 'View all'))
    const shownCount = state.view.kind === 'all' ? enabled.filter((p) => onScreen.has(p.id)).length : 0
    allRow.append(this.node('span', 'pw-sub', state.view.kind === 'all'
      ? `${shownCount} of ${enabled.length}` : `${enabled.length} on`))
    allRow.title = 'Show all switched-on panes'
    allRow.onclick = () => this.showAll(state, true)
    el.append(allRow)

    el.append(this.node('div', 'pw-section', 'Panes'))
    const focused = state.view.kind === 'focus' ? state.view.paneId : null
    const list = this.node('div', 'pw-list')
    for (const pane of workspace.panes) {
      list.append(this.paneRow(state, pane, live.get(pane.id), onScreen.has(pane.id), focused))
    }
    // Dropping below the last row moves a pane to the end
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
    const title = (tab ? (tab.customTitle || tab.title) : '') || pane.name || pane.startupCommand || 'Pane'
    const sub = [pane.name, pane.startupCommand].filter(Boolean).join(' · ')
    const classes = ['pw-row', 'pw-pane']
    if (pane.id === focused) classes.push('active')
    if (onScreen) classes.push('shown')
    if (pane.hidden) classes.push('off')
    if (!tab) classes.push('stopped')
    if (!pane.hidden && !onScreen && state.view.kind === 'all') classes.push('noroom')
    const row = this.node('div', classes.join(' '))

    // Drag handle: the whole row is draggable, the handle shows it
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

    const dot = this.node('span', 'pw-dot' + (tab && tab.hasActivity && !onScreen ? ' activity' : ''))
    const text = this.node('span', 'pw-text')
    text.append(this.node('span', 'pw-main', title))
    if (sub) text.append(this.node('span', 'pw-sub', sub))
    text.title = pane.id === focused ? 'Back to "View all"' : 'Focus view'
    text.onclick = () => {
      if (pane.id === focused) this.showAll(state, true)
      else this.showFocus(state, pane.id)
    }

    const sw = this.node('label', 'pw-switch')
    sw.title = pane.hidden ? 'Off: not in "View all"' : 'On: in "View all"'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = !pane.hidden
    input.onchange = () => this.toggleShown(state, pane.id)
    sw.append(input, this.node('span', 'pw-slider'))
    sw.addEventListener('click', (e) => e.stopPropagation())

    row.append(dot, text, sw)
    if (!pane.hidden && !onScreen && state.view.kind === 'all') {
      row.title = 'On, but no room at the minimum pane size'
    }
    return row
  }

  private makeDropTarget(state: WorkspaceTabState, el: HTMLElement, beforePaneId: string | null): void {
    el.addEventListener('dragover', (e) => {
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

  private node(tag: string, className: string, text?: string): HTMLElement {
    const el = document.createElement(tag)
    el.className = className
    if (text !== undefined) el.textContent = text
    return el
  }

  private ensureStyles(): void {
    if (document.getElementById('paneworks-sidebar-styles')) return
    const style = document.createElement('style')
    style.id = 'paneworks-sidebar-styles'
    style.textContent = `
      .paneworks-sidebar {
        display: flex; flex-direction: column; overflow-y: auto; overflow-x: hidden;
        background: var(--theme-bg-more, rgba(0,0,0,.25));
        border-right: 1px solid var(--theme-bg-more-2, rgba(255,255,255,.08));
        color: var(--theme-fg, inherit); font-size: 12px; user-select: none;
      }
      .paneworks-sidebar.collapsed { align-items: center; }
      .paneworks-sidebar .pw-header { display: flex; align-items: center; padding: 8px 6px 6px 10px; }
      .paneworks-sidebar .pw-title { flex: 1; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .paneworks-sidebar .pw-toggle {
        background: none; border: none; color: inherit; opacity: .6; cursor: pointer;
        padding: 2px 6px; font-size: 13px; line-height: 1;
      }
      .paneworks-sidebar.collapsed .pw-toggle { margin-top: 8px; }
      .paneworks-sidebar .pw-toggle:hover { opacity: 1; }
      .paneworks-sidebar .pw-section {
        padding: 10px 10px 3px; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; opacity: .5;
      }
      .paneworks-sidebar .pw-row {
        display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 6px;
        border-left: 2px solid transparent; border-top: 2px solid transparent;
      }
      .paneworks-sidebar .pw-row:hover { background: rgba(127,127,127,.12); }
      .paneworks-sidebar .pw-row.active {
        background: rgba(127,127,127,.18); border-left-color: var(--theme-primary, #4c9aff);
      }
      .paneworks-sidebar .pw-all { cursor: pointer; padding-left: 10px; }
      .paneworks-sidebar .pw-all .pw-main { flex: 1; font-weight: 600; }
      .paneworks-sidebar .pw-handle { cursor: grab; opacity: .3; font-size: 10px; letter-spacing: -2px; }
      .paneworks-sidebar .pw-row:hover .pw-handle { opacity: .7; }
      .paneworks-sidebar .pw-row.dragging { opacity: .35; }
      .paneworks-sidebar .drop-before { border-top-color: var(--theme-primary, #4c9aff); }
      .paneworks-sidebar .pw-drop-end { flex: 1; min-height: 24px; border-top: 2px solid transparent; }
      .paneworks-sidebar .pw-text { display: flex; flex-direction: column; min-width: 0; flex: 1; cursor: pointer; }
      .paneworks-sidebar .pw-main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .paneworks-sidebar .pw-sub { font-size: 10px; opacity: .5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .paneworks-sidebar .pw-dot {
        flex: 0 0 7px; height: 7px; border-radius: 50%; border: 1px solid currentColor; opacity: .35;
      }
      .paneworks-sidebar .pw-pane.shown .pw-dot { background: currentColor; opacity: .7; }
      .paneworks-sidebar .pw-pane.off .pw-text, .paneworks-sidebar .pw-pane.stopped .pw-text { opacity: .55; }
      .paneworks-sidebar .pw-pane.noroom .pw-sub::after { content: ' · no room'; }
      .paneworks-sidebar .pw-dot.activity {
        background: var(--theme-primary, #4c9aff); border-color: var(--theme-primary, #4c9aff); opacity: 1;
      }
      .paneworks-sidebar .pw-switch { position: relative; flex: 0 0 26px; height: 14px; cursor: pointer; }
      .paneworks-sidebar .pw-switch input { opacity: 0; width: 0; height: 0; position: absolute; }
      .paneworks-sidebar .pw-slider {
        position: absolute; inset: 0; border-radius: 7px; background: rgba(127,127,127,.35); transition: background .15s;
      }
      .paneworks-sidebar .pw-slider::before {
        content: ''; position: absolute; left: 2px; top: 2px; width: 10px; height: 10px; border-radius: 50%;
        background: var(--theme-fg, #fff); transition: transform .15s;
      }
      .paneworks-sidebar .pw-switch input:checked + .pw-slider { background: var(--theme-primary, #4c9aff); }
      .paneworks-sidebar .pw-switch input:checked + .pw-slider::before { transform: translateX(12px); }
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
