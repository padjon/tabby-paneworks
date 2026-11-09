import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { first, timeout, of, Subject } from 'rxjs'
import { catchError } from 'rxjs/operators'
import { DISPLAY_NAME } from '../build-config'
import { findPane, formatPaneLabel, parsePaneMarker } from '../models/workspace.model'
import { WorkspaceEditorService } from './workspaceEditor.service'

export interface PendingCommand {
  paneId: string
  command?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TerminalTab = BaseTerminalTabComponent<any>

/**
 * A split tab is scanned when it reports initialized, whenever a pane is added,
 * and again after these delays, so panes that come up slowly are never missed.
 * Each pane is handled once (attachedPanes), so extra scans are free.
 */
const RESCAN_DELAYS_MS = [0, 300, 1000, 3000, 8000]

/**
 * Runtime behaviour of workspace panes, found by the hidden marker in their profile group:
 * - sends the pane's startup command once, after the shell's first output;
 * - keeps the outer tab titled with the workspace name;
 * - keeps the pane label (Tabby shows a pane's custom title inside the split)
 *   in sync with the title the program sets, prefixed by the pane name.
 *   A manual "Rename pane" stops the sync for that pane.
 *
 * Module-level singleton for the app lifetime; subscriptions intentionally run forever.
 */
@Injectable()
export class PaneRuntimeService {
  /** Emitted whenever a split tab containing Paneworks panes is scanned (may repeat). */
  readonly workspaceSplitFound$ = new Subject<{ split: SplitTabComponent, workspaceId: string }>()

  private pendingCommands = new Map<string, PendingCommand>()
  private watchedSplits = new WeakSet<SplitTabComponent>()
  private attachedPanes = new WeakSet<BaseTabComponent>()

  constructor(
    private app: AppService,
    private workspaces: WorkspaceEditorService
  ) {
    this.app.tabOpened$.subscribe((tab) => this.onTabOpened(tab))
  }

  registerCommands(commands: PendingCommand[]): void {
    for (const cmd of commands) {
      this.pendingCommands.set(cmd.paneId, cmd)
    }
  }

  private onTabOpened(tab: BaseTabComponent): void {
    if (tab instanceof SplitTabComponent) {
      this.watchSplit(tab)
    } else if (tab instanceof BaseTerminalTabComponent) {
      this.processPane(tab, null)
    }
  }

  private watchSplit(split: SplitTabComponent): void {
    if (this.watchedSplits.has(split)) return
    this.watchedSplits.add(split)

    const scan = () => this.scanSplit(split)
    // initialized$ completes once the layout exists (also immediately if it already did)
    split.initialized$?.subscribe({ complete: scan })
    split.tabAdded$?.subscribe(() => scan())
    for (const delay of RESCAN_DELAYS_MS) {
      setTimeout(scan, delay)
    }
  }

  private scanSplit(split: SplitTabComponent): void {
    for (const tab of split.getAllTabs()) {
      if (tab instanceof BaseTerminalTabComponent) {
        this.processPane(tab, split)
      }
    }
  }

  private processPane(tab: TerminalTab, split: SplitTabComponent | null): void {
    const marker = parsePaneMarker(tab.profile?.group)
    if (!marker) return

    if (split) {
      this.pinSplitTitle(split, marker.workspaceId)
      this.workspaceSplitFound$.next({ split, workspaceId: marker.workspaceId })
    }

    if (this.attachedPanes.has(tab)) return
    this.attachedPanes.add(tab)

    this.attachLabelSync(tab, marker.workspaceId, marker.paneId)
    this.runPendingCommand(tab, marker.paneId)
  }

  /** The outer tab shows the workspace name and ignores pane titles. */
  private pinSplitTitle(split: SplitTabComponent, workspaceId: string): void {
    const name = this.workspaces.getWorkspace(workspaceId)?.name
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(split as any).disableDynamicTitle = true
    if (name && split.title !== name) {
      split.setTitle(name)
    }
  }

  private attachLabelSync(tab: TerminalTab, workspaceId: string, paneId: string): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tabAny = tab as any
    tabAny.disableDynamicTitle = false

    let lastLabel: string = tab.customTitle
    let active = true

    const update = () => {
      if (!active) return
      if (tab.customTitle !== lastLabel) {
        // The user renamed the pane: their name wins from now on
        active = false
        return
      }
      const workspace = this.workspaces.getWorkspace(workspaceId)
      const paneName = workspace ? findPane(workspace.root, paneId)?.name : undefined
      const label = formatPaneLabel(paneName, tab.title)
      if (!label || label === tab.customTitle) return
      lastLabel = label
      if (typeof tabAny.setCustomTitle === 'function') {
        tabAny.setCustomTitle(label)
      } else {
        tab.customTitle = label
      }
    }

    // The terminal calls this.setTitle(title) for every title the program sends.
    // titleChange$ can't be used: it emits the display title, which is the
    // (unchanged) custom title, and is filtered by distinctUntilChanged.
    const originalSetTitle = tab.setTitle.bind(tab)
    tab.setTitle = (title: string) => {
      originalSetTitle(title)
      update()
    }
    update()
  }

  private runPendingCommand(tab: TerminalTab, paneId: string, waitedForSession = false): void {
    const pending = this.pendingCommands.get(paneId)
    if (!pending?.command) return
    this.pendingCommands.delete(paneId)
    const command = pending.command

    const send = () => {
      console.log(`[${DISPLAY_NAME}] Sending startup command:`, command)
      tab.sendInput(command + '\r')
      this.clearProfileArgs(tab)
    }

    // No session yet: wait for it (with a fallback), then continue as below
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sessionChanged$ = (tab as any).sessionChanged$
    if (!tab.session && sessionChanged$ && !waitedForSession) {
      this.pendingCommands.set(paneId, pending)
      sessionChanged$.pipe(
        first((s: unknown) => !!s),
        timeout(5000),
        catchError(() => of(null))
      ).subscribe(() => this.runPendingCommand(tab, paneId, true))
      return
    }

    // Wait for the shell's first output (its prompt), then send
    if (tab.session?.output$) {
      tab.session.output$.pipe(
        first(),
        timeout(2000),
        catchError(() => of(null))
      ).subscribe(() => setTimeout(send, 100))
    } else {
      setTimeout(send, 500)
    }
  }

  /** Prevents native splits of this pane from re-running the startup command. */
  private clearProfileArgs(tab: TerminalTab): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const profile = (tab as any).profile
    if (profile?.options?.args) {
      profile.options.args = []
    }
  }
}
