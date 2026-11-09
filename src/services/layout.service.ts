import { Injectable } from '@angular/core'
import { BaseTabComponent, SplitContainer, SplitTabComponent, TabRecoveryService, TabsService } from 'tabby-core'
import { DISPLAY_NAME } from '../build-config'
import {
  LayoutSplit,
  Workspace,
  WorkspacePane,
  allLayouts,
  allPanes,
  isLayoutSplit,
  layoutPaneIds,
  parsePaneMarker,
} from '../models/workspace.model'
import { PaneRuntimeService } from './paneRuntime.service'
import { WorkspaceEditorService } from './workspaceEditor.service'

const SIDEBAR_WIDTH = 210
const SIDEBAR_COLLAPSED_WIDTH = 22
const REFRESH_MS = 1000

/** What a workspace tab currently shows. */
type View =
  | { kind: 'layout', layoutId: string }
  | { kind: 'focus', paneId: string, previousLayoutId: string | null }
  | { kind: 'unknown' }

interface WorkspaceTabState {
  split: SplitTabComponent
  workspaceId: string
  view: View
  /** Panes taken out of the split by a layout switch; alive, not shown. */
  parked: Map<string, BaseTabComponent>
  sidebar: HTMLElement | null
  collapsed: boolean
  busy: boolean
  timer: ReturnType<typeof setInterval> | null
}

// Tabby internals used here (stable across 1.0.x, not in the public typings):
// split.viewRefs, split.attachTabView(), split.onAfterTabAdded(), split.maximizedTab,
// tab.viewContainerEmbeddedRef (the top-level tab's DOM via its view).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/**
 * Sidebar and layouts for Paneworks workspace tabs.
 * A layout switch moves live panes in and out of the split (the way Tabby's own
 * drag and drop does), so hidden panes keep running; panes never shown before
 * are created on demand with their startup command.
 */
@Injectable()
export class LayoutService {
  private states = new WeakMap<SplitTabComponent, WorkspaceTabState>()

  constructor(
    private runtime: PaneRuntimeService,
    private workspaces: WorkspaceEditorService,
    private tabsService: TabsService,
    private tabRecovery: TabRecoveryService
  ) {
    this.runtime.workspaceSplitFound$.subscribe(({ split, workspaceId }) => this.attach(split, workspaceId))
  }

  private attach(split: SplitTabComponent, workspaceId: string): void {
    const existing = this.states.get(split)
    if (existing) {
      if (existing.view.kind === 'unknown' && !existing.busy) {
        existing.view = this.detectView(existing)
        this.render(existing)
      }
      if (!existing.sidebar?.isConnected) this.mountSidebar(existing)
      return
    }
    const state: WorkspaceTabState = {
      split,
      workspaceId,
      view: { kind: 'unknown' },
      parked: new Map(),
      sidebar: null,
      collapsed: this.loadCollapsed(workspaceId),
      busy: false,
      timer: null,
    }
    this.states.set(split, state)
    state.view = this.detectView(state)

    split.destroyed$.subscribe(() => {
      // Parked panes are outside the split: close them with it
      for (const tab of state.parked.values()) tab.destroy()
      state.parked.clear()
      if (state.timer) clearInterval(state.timer)
      state.sidebar?.remove()
    })

    this.mountSidebar(state)
    state.timer = setInterval(() => this.render(state), REFRESH_MS)
  }

  // ---------- layout switching ----------

  private async showLayout(state: WorkspaceTabState, layoutId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    const layout = workspace ? allLayouts(workspace).find((l) => l.id === layoutId) : undefined
    if (!workspace || !layout) return
    if (await this.apply(state, workspace, layout.root)) {
      state.view = { kind: 'layout', layoutId }
    }
    this.render(state)
  }

  private async showFocus(state: WorkspaceTabState, paneId: string): Promise<void> {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace) return
    const previousLayoutId = state.view.kind === 'layout' ? state.view.layoutId
      : state.view.kind === 'focus' ? state.view.previousLayoutId : null
    const tree: LayoutSplit = { orientation: 'horizontal', ratios: [1], children: [{ paneId }] }
    if (await this.apply(state, workspace, tree)) {
      state.view = { kind: 'focus', paneId, previousLayoutId }
    }
    this.render(state)
  }

  /** Rebuilds the split to show exactly the panes of `tree`. Returns false if nothing could be shown. */
  private async apply(state: WorkspaceTabState, workspace: Workspace, tree: LayoutSplit): Promise<boolean> {
    if (state.busy) return false
    state.busy = true
    try {
      const split = state.split as Any
      const panes = new Map(allPanes(workspace).map((p) => [p.id, p]))
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

      // New tree with the live tabs
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
      console.error(`[${DISPLAY_NAME}] Layout switch failed:`, error)
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

  /** After a restart or a manual change: name the view if the split matches a layout. */
  private detectView(state: WorkspaceTabState): View {
    const workspace = this.workspaces.getWorkspace(state.workspaceId)
    if (!workspace) return { kind: 'unknown' }
    const shown = state.split.getAllTabs().map((t) => this.paneIdOf(t)).filter(Boolean).sort().join()
    const match = allLayouts(workspace).find((l) => layoutPaneIds(l.root).slice().sort().join() === shown)
    return match ? { kind: 'layout', layoutId: match.id } : { kind: 'unknown' }
  }

  /** Terminals refit on window resize; the split area changed size. */
  private nudgeResize(): void {
    setTimeout(() => window.dispatchEvent(new Event('resize')), 50)
  }

  // ---------- sidebar ----------

  private splitElement(state: WorkspaceTabState): HTMLElement | null {
    const ref = (state.split as Any).viewContainerEmbeddedRef
    const el = ref?.rootNodes?.[0]
    return el instanceof HTMLElement ? el : null
  }

  private mountSidebar(state: WorkspaceTabState): void {
    const splitEl = this.splitElement(state)
    const host = splitEl?.parentElement
    if (!splitEl || !host) {
      // Not in the DOM yet; the next scan of the split retries
      return
    }
    if (!state.sidebar) {
      state.sidebar = document.createElement('div')
      state.sidebar.className = 'paneworks-sidebar'
      this.ensureStyles()
    }
    host.insertBefore(state.sidebar, splitEl)
    this.render(state)
    this.nudgeResize()
  }

  private render(state: WorkspaceTabState): void {
    const el = state.sidebar
    if (!el || !el.isConnected) return
    const workspace = this.workspaces.getWorkspace(state.workspaceId)

    // Redraw only on change: a redraw between mousedown and mouseup would swallow the click
    const live = this.livePanes(state)
    const signature = JSON.stringify([
      state.collapsed, state.view, workspace?.name, workspace ? allLayouts(workspace).map((l) => [l.id, l.name]) : null,
      workspace ? allPanes(workspace).map((p) => {
        const tab = live.get(p.id)
        return [p.id, p.name, p.startupCommand, tab?.customTitle, tab?.title, tab?.hasActivity, !!tab?.parent]
      }) : null,
    ])
    if ((el as Any).__pwSignature === signature) return
    ;(el as Any).__pwSignature = signature

    el.classList.toggle('collapsed', state.collapsed)
    el.style.flex = `0 0 ${state.collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_WIDTH}px`
    el.textContent = ''

    const toggle = this.node('button', 'pw-toggle', state.collapsed ? '»' : '«')
    toggle.title = state.collapsed ? 'Show sidebar' : 'Hide sidebar'
    toggle.onclick = () => {
      state.collapsed = !state.collapsed
      this.saveCollapsed(state.workspaceId, state.collapsed)
      this.render(state)
      this.nudgeResize()
    }
    if (state.collapsed || !workspace) {
      el.append(toggle)
      return
    }

    const header = this.node('div', 'pw-header')
    header.append(this.node('span', 'pw-title', workspace.name), toggle)
    el.append(header)

    // Layouts
    el.append(this.node('div', 'pw-section', 'Layouts'))
    const activeLayout = state.view.kind === 'layout' ? state.view.layoutId : null
    for (const layout of allLayouts(workspace)) {
      const row = this.node('div', 'pw-row pw-layout' + (layout.id === activeLayout ? ' active' : ''))
      row.append(this.node('span', 'pw-main', layout.name))
      row.append(this.node('span', 'pw-sub', `${layoutPaneIds(layout.root).length}`))
      row.title = `Show layout "${layout.name}"`
      row.onclick = () => this.showLayout(state, layout.id)
      el.append(row)
    }

    // Panes
    el.append(this.node('div', 'pw-section', 'Panes'))
    const shown = new Set(state.split.getAllTabs().map((t) => this.paneIdOf(t)))
    const focused = state.view.kind === 'focus' ? state.view.paneId : null
    for (const pane of allPanes(workspace)) {
      const tab = live.get(pane.id)
      const title = (tab ? (tab.customTitle || tab.title) : '') || pane.name || pane.startupCommand || 'Pane'
      const sub = [pane.name, pane.startupCommand].filter(Boolean).join(' · ')
      const classes = ['pw-row', 'pw-pane']
      if (pane.id === focused) classes.push('active')
      if (shown.has(pane.id)) classes.push('shown')
      if (!tab) classes.push('stopped')
      const row = this.node('div', classes.join(' '))
      const dot = this.node('span', 'pw-dot' + (tab && tab.hasActivity && !shown.has(pane.id) ? ' activity' : ''))
      const text = this.node('span', 'pw-text')
      text.append(this.node('span', 'pw-main', title), this.node('span', 'pw-sub', sub))
      row.append(dot, text)
      row.title = pane.id === focused ? 'Back to the layout' : 'Focus view'
      row.onclick = () => {
        if (pane.id === focused && state.view.kind === 'focus' && state.view.previousLayoutId) {
          this.showLayout(state, state.view.previousLayoutId)
        } else {
          this.showFocus(state, pane.id)
        }
      }
      el.append(row)
    }
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
      .paneworks-sidebar .pw-header { display: flex; align-items: center; padding: 8px 6px 4px 10px; }
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
        display: flex; align-items: center; gap: 7px; padding: 4px 10px; cursor: pointer;
        border-left: 2px solid transparent;
      }
      .paneworks-sidebar .pw-row:hover { background: rgba(127,127,127,.12); }
      .paneworks-sidebar .pw-row.active {
        background: rgba(127,127,127,.18); border-left-color: var(--theme-primary, #4c9aff);
      }
      .paneworks-sidebar .pw-layout .pw-main { flex: 1; }
      .paneworks-sidebar .pw-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
      .paneworks-sidebar .pw-main { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .paneworks-sidebar .pw-sub { font-size: 10px; opacity: .5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .paneworks-sidebar .pw-dot {
        flex: 0 0 7px; height: 7px; border-radius: 50%; border: 1px solid currentColor; opacity: .35;
      }
      .paneworks-sidebar .pw-pane.shown .pw-dot { background: currentColor; opacity: .7; }
      .paneworks-sidebar .pw-pane.stopped { opacity: .55; }
      .paneworks-sidebar .pw-dot.activity {
        background: var(--theme-primary, #4c9aff); border-color: var(--theme-primary, #4c9aff); opacity: 1;
      }
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
