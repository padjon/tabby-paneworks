import { Injectable } from '@angular/core'
import { ConfigService, NotificationsService, ProfilesService } from 'tabby-core'
import {
  Workspace,
  WorkspacePane,
  LayoutSplit,
  isLayoutSplit,
  generateUUID,
  TabbyProfile,
  TabbyRecoveryToken,
  TabbySplitLayoutProfile,
  makePaneMarker,
  formatPaneLabel,
  normalizeWorkspace,
  planGrid,
  gridTree,
  DEFAULT_MIN_PANE_WIDTH,
  DEFAULT_MIN_PANE_HEIGHT,
} from '../models/workspace.model'

/** Width of the Paneworks sidebar in a workspace tab (px). */
export const SIDEBAR_WIDTH = 210
/** Tab bar and window chrome, used to estimate the pane area before the tab exists (px). */
const CHROME_HEIGHT = 80
import { CONFIG_KEY, DISPLAY_NAME } from '../build-config'
import { PendingCommand } from './paneRuntime.service'

@Injectable({ providedIn: 'root' })
export class WorkspaceEditorService {
  private cachedProfiles: TabbyProfile[] | null = null
  private cacheTimestamp: number = 0
  private readonly CACHE_TTL = 30000 // 30 seconds

  constructor(
    private config: ConfigService,
    private notifications: NotificationsService,
    private profilesService: ProfilesService
  ) {}

  private async getCachedProfiles(): Promise<TabbyProfile[]> {
    const now = Date.now()
    if (!this.cachedProfiles || now - this.cacheTimestamp > this.CACHE_TTL) {
      this.cachedProfiles = (await this.profilesService.getProfiles()) as TabbyProfile[]
      this.cacheTimestamp = now
    }
    return this.cachedProfiles
  }

  /** Returns all saved workspaces from config (old tree-shaped ones converted to a pane list). */
  getWorkspaces(): Workspace[] {
    const workspaces: Workspace[] = this.config.store?.[CONFIG_KEY]?.workspaces ?? []
    for (const workspace of workspaces) {
      if (!Array.isArray(workspace.panes)) normalizeWorkspace(workspace)
    }
    return workspaces
  }

  /**
   * Saves one workspace's changed fields (pane order, switches) without a notification.
   * Used by the sidebar.
   */
  async saveWorkspaceQuietly(workspace: Workspace): Promise<void> {
    const workspaces = this.getWorkspaces()
    const index = workspaces.findIndex((w) => w.id === workspace.id)
    if (index === -1) return
    workspaces[index] = workspace
    await this.saveWorkspaces(workspaces)
  }

  /** Minimum pane size of a workspace, with defaults. */
  minPaneSize(workspace: Workspace): { width: number, height: number } {
    return {
      width: workspace.minPaneWidth || DEFAULT_MIN_PANE_WIDTH,
      height: workspace.minPaneHeight || DEFAULT_MIN_PANE_HEIGHT,
    }
  }

  /**
   * "View all" grid of a workspace for a pane area: the switched-on panes in order,
   * as many as fit. Returns the tree and the ids of the panes that fit.
   */
  planViewAll(workspace: Workspace, width: number, height: number): { tree: LayoutSplit | null, shown: string[] } {
    const visible = workspace.panes.filter((p) => !p.hidden).map((p) => p.id)
    const min = this.minPaneSize(workspace)
    const rows = planGrid(visible.length, width, height, min.width, min.height)
    const count = rows.reduce((a, b) => a + b, 0)
    const shown = visible.slice(0, count)
    return { tree: shown.length ? gridTree(shown, rows) : null, shown }
  }

  /**
   * Grid with every pane of a workspace, switched off ones included, ignoring the
   * minimum size. A workspace opens with it: Tabby starts a terminal's shell only once
   * the terminal has been on screen, and every pane must run. The sidebar then switches
   * to "View all" (see LayoutService.startAllPanes).
   */
  allPanesLayout(workspace: Workspace, width?: number, height?: number): LayoutSplit | null {
    const ids = workspace.panes.map((p) => p.id)
    if (!ids.length) return null
    const w = Math.max(1, width ?? window.innerWidth - SIDEBAR_WIDTH)
    const h = Math.max(1, height ?? window.innerHeight - CHROME_HEIGHT)
    return gridTree(ids, planGrid(ids.length, w, h, 1, 1))
  }

  private initialLayout(workspace: Workspace): LayoutSplit | null {
    return this.allPanesLayout(workspace)
  }

  /**
   * Saves the workspace list to config.
   * @throws Error if config store is not initialized
   */
  async saveWorkspaces(workspaces: Workspace[]): Promise<void> {
    if (!this.config.store?.[CONFIG_KEY]) {
      throw new Error('Config store not initialized')
    }
    this.config.store[CONFIG_KEY].workspaces = workspaces
    await this.saveConfig()
  }

  /** Adds a new workspace and shows notification. */
  async addWorkspace(workspace: Workspace): Promise<void> {
    try {
      const workspaces = this.getWorkspaces()
      workspaces.push(workspace)
      await this.saveWorkspaces(workspaces)
      this.notifications.info(`Workspace "${workspace.name}" created`)
    } catch (error) {
      this.notifications.error(`Failed to create workspace "${workspace.name}"`)
      throw error
    }
  }

  /** Deletes a workspace by ID and shows notification. */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    const workspaces = this.getWorkspaces()
    const workspace = workspaces.find((w) => w.id === workspaceId)
    try {
      const filtered = workspaces.filter((w) => w.id !== workspaceId)
      await this.saveWorkspaces(filtered)
      if (workspace) {
        this.notifications.info(`Workspace "${workspace.name}" deleted`)
      }
    } catch (error) {
      this.notifications.error(`Failed to delete workspace "${workspace?.name || workspaceId}"`)
      throw error
    }
  }

  /** Returns all profiles available for use in workspaces (local, SSH, serial, etc.). */
  async getAvailableProfiles(): Promise<TabbyProfile[]> {
    const allProfiles = await this.profilesService.getProfiles()
    return allProfiles.filter(
      (p) => !p.id?.startsWith('split-layout:')
    ) as TabbyProfile[]
  }

  /**
   * Cleanup orphaned profiles from previous plugin versions.
   * Call this once on plugin init.
   */
  cleanupOrphanedProfiles(): void {
    if (!this.config.store?.profiles) {
      return
    }
    const profiles: TabbyProfile[] = this.config.store.profiles
    const prefix = `split-layout:${CONFIG_KEY}:`
    const filtered = profiles.filter((p) => !p.id?.startsWith(prefix))
    if (filtered.length !== profiles.length) {
      this.config.store.profiles = filtered
      this.config.save()
      console.log(`[${DISPLAY_NAME}] Cleaned up ${profiles.length - filtered.length} orphaned profiles`)
    }
  }

  /**
   * Generates a Tabby split-layout profile from a workspace for opening:
   * the "View all" grid of its switched-on panes; the others start when shown.
   */
  async generateTabbyProfile(workspace: Workspace): Promise<TabbySplitLayoutProfile | null> {
    await this.getCachedProfiles()
    const tree = this.initialLayout(workspace)
    if (!tree) return null
    const safeName = this.sanitizeForProfileId(workspace.name)
    return {
      id: `split-layout:${CONFIG_KEY}:${safeName}:${workspace.id}`,
      type: 'split-layout',
      name: workspace.name,
      group: DISPLAY_NAME,
      icon: workspace.icon,
      color: workspace.color,
      isBuiltin: false,
      options: {
        recoveryToken: this.generateRecoveryToken(tree, workspace),
      },
    }
  }

  /** Token for one pane of a workspace, used to create panes on demand (layouts, focus view). */
  async createPaneToken(workspace: Workspace, pane: WorkspacePane): Promise<TabbyRecoveryToken> {
    await this.getCachedProfiles()
    return this.generatePaneToken(pane, workspace.name, workspace.id)
  }

  private generateRecoveryToken(split: LayoutSplit, workspace: Workspace): TabbyRecoveryToken {
    return {
      type: 'app:split-tab',
      orientation: split.orientation === 'horizontal' ? 'h' : 'v',
      ratios: [...split.ratios],
      paneworksWorkspaceId: workspace.id,
      // The outer tab always shows the workspace name, never the pane titles
      tabTitle: workspace.name,
      disableDynamicTitle: true,
      children: split.children.map((child) => {
        if (isLayoutSplit(child)) {
          return this.generateRecoveryToken(child, workspace)
        }
        const pane = workspace.panes.find((p) => p.id === child.paneId)!
        return this.generatePaneToken(pane, workspace.name, workspace.id)
      }),
    }
  }

  private generatePaneToken(pane: WorkspacePane, workspaceName: string, workspaceId: string): TabbyRecoveryToken {
    const baseProfile = this.getProfileById(pane.profileId)

    // Marker: lets PaneRuntimeService find this pane (startup command, live label)
    // without putting anything visible on it. Initial label: the pane name.
    const marker = makePaneMarker(workspaceId, pane.id)
    const initialLabel = formatPaneLabel(pane.name, '')

    if (!baseProfile) {
      return {
        type: 'app:local-tab',
        profile: {
          type: 'local',
          name: 'Shell',
          group: marker,
        },
        savedState: false,
        tabTitle: pane.name || 'Shell',
        tabCustomTitle: initialLabel,
        paneworksWorkspaceId: workspaceId,
        disableDynamicTitle: false,
      }
    }

    // Non-local profiles (SSH, serial, telnet): pass profile through, Tabby handles the rest
    if (!this.isLocalProfile(baseProfile)) {
      return {
        type: `app:${baseProfile.type}-tab`,
        profile: {
          ...baseProfile,
          group: marker,
          disableDynamicTitle: false,
        },
        savedState: false,
        tabTitle: pane.name || baseProfile.name,
        tabCustomTitle: initialLabel,
        paneworksWorkspaceId: workspaceId,
        disableDynamicTitle: false,
      }
    }

    // Local profiles: build options with CWD/WSL handling
    const rawCwd = pane.cwd || baseProfile.options?.cwd || ''
    const isWsl = this.isWslProfile(baseProfile)
    const baseArgs = baseProfile.options?.args || []

    const options = {
      restoreFromPTYID: false,
      command: baseProfile.options?.command || '',
      // WSL: inject --cd to set Linux CWD directly (bypasses fs.existsSync validation)
      args: isWsl && rawCwd ? [...baseArgs, '--cd', rawCwd] : baseArgs,
      // WSL: don't set cwd (Unix paths fail fs.existsSync on Windows)
      cwd: isWsl ? '' : rawCwd,
      env: baseProfile.options?.env || {},
      width: null,
      height: null,
      pauseAfterExit: false,
      runAsAdministrator: false,
    }

    // Note: startupCommand is handled via sendInput() in StartupCommandService
    // to avoid re-execution when Tabby splits the pane

    const profile = {
      id: baseProfile.id,
      type: 'local',
      name: baseProfile.name || 'Shell',
      group: marker,
      options,
      icon: baseProfile.icon || '',
      color: baseProfile.color || '',
      disableDynamicTitle: false,
      weight: 0,
      isBuiltin: false,
      isTemplate: false,
      terminalColorScheme: null,
      behaviorOnSessionEnd: 'auto',
    }

    // tabTitle: follows the program's title (dynamic titles stay on)
    // tabCustomTitle: the pane label; PaneRuntimeService keeps it in sync with the program title
    // paneworksWorkspaceId: for duplicate detection after Tabby recovery
    return {
      type: 'app:local-tab',
      profile,
      savedState: false,
      tabTitle: pane.name || baseProfile.name || 'Shell',
      tabCustomTitle: initialLabel,
      paneworksWorkspaceId: workspaceId,
      disableDynamicTitle: false,
      cwd: isWsl ? '' : rawCwd,
    }
  }

  private sanitizeForProfileId(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      || 'workspace'
  }

  /** Checks if a profile is a local shell (local, local:wsl, local:powershell, etc.). */
  private isLocalProfile(profile: TabbyProfile): boolean {
    return profile.type === 'local' || profile.type?.startsWith('local:') || false
  }

  /** Detects WSL profiles by ID prefix (built-in) or command path (user-defined). */
  private isWslProfile(profile: TabbyProfile): boolean {
    // Built-in WSL profiles: id starts with 'local:wsl'
    if (profile.id?.startsWith('local:wsl')) {
      return true
    }
    // User-defined WSL profiles: type 'local' with command pointing to wsl.exe
    const command = (profile.options?.command || '').toLowerCase()
    return command === 'wsl.exe' || command === 'wsl' || command.endsWith('\\wsl.exe') || command.endsWith('/wsl.exe')
  }

  private getProfileById(profileId: string): TabbyProfile | undefined {
    // First: check user profiles in config
    const userProfiles: TabbyProfile[] = this.config.store?.profiles ?? []
    const found = userProfiles.find((p) => p.id === profileId)
    if (found) return found

    // Fallback: check cached profiles (includes built-ins)
    return this.cachedProfiles?.find((p) => p.id === profileId)
  }

  /** Startup commands of all panes (a workspace opens with all of them). */
  collectStartupCommands(workspace: Workspace): PendingCommand[] {
    return workspace.panes
      .filter((p) => p.startupCommand)
      .map((p) => ({ paneId: p.id, command: p.startupCommand }))
  }

  /** Returns the workspace with the given id, if it still exists. */
  getWorkspace(workspaceId: string): Workspace | undefined {
    return this.getWorkspaces().find((w) => w.id === workspaceId)
  }

  private async saveConfig(): Promise<void> {
    try {
      await this.config.save()
    } catch (error) {
      console.error(`[${DISPLAY_NAME}] Save error:`, error)
      throw error
    }
  }
}
