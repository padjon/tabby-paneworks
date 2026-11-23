import { Injectable } from '@angular/core'
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { Subject } from 'rxjs'
import { ConfigService, NotificationsService, PlatformService, ProfilesService } from 'tabby-core'
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
  deepClone,
  planGrid,
  gridTree,
  DEFAULT_MIN_PANE_WIDTH,
  DEFAULT_MIN_PANE_HEIGHT,
  activeView,
  isPaneOn,
} from '../models/workspace.model'

/** Width of the Paneworks sidebar in a workspace tab (px). */
export const SIDEBAR_WIDTH = 210
/** Tab bar and window chrome, used to estimate the pane area before the tab exists (px). */
const CHROME_HEIGHT = 80
import { CONFIG_KEY, DISPLAY_NAME } from '../build-config'
import { PendingCommand } from './paneRuntime.service'

/** A workspace's config file open for editing. */
interface ConfigFile {
  file: string
  /** Text last written or read; a change to anything else is an edit. */
  written: string
  /** The last save was not valid: the sidebar doesn't write back, so the user's edits stay. */
  invalid?: boolean
}

@Injectable({ providedIn: 'root' })
export class WorkspaceEditorService {
  private cachedProfiles: TabbyProfile[] | null = null
  private cacheTimestamp: number = 0
  private readonly CACHE_TTL = 30000 // 30 seconds

  /** Workspace config files open for editing: workspace id -> file and the text last written to it. */
  private configFiles = new Map<string, ConfigFile>()
  /** Fires when a workspace's config file was saved and applied, with the settings from before. */
  readonly workspaceEdited$ = new Subject<{ workspaceId: string, before: Workspace }>()

  constructor(
    private config: ConfigService,
    private notifications: NotificationsService,
    private profilesService: ProfilesService,
    private platform: PlatformService
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
      if (!Array.isArray(workspace.panes) || !Array.isArray(workspace.views) || !workspace.views.length ||
        workspace.panes.some((p) => !p || 'hidden' in p) ||
        workspace.views.some((v) => !v || typeof v !== 'object' || (v.hidden !== undefined && !Array.isArray(v.hidden)))) {
        normalizeWorkspace(workspace)
      }
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
    this.writeConfigFile(workspace)
  }

  /** Minimum pane size of a workspace, with defaults. */
  minPaneSize(workspace: Workspace): { width: number, height: number } {
    return {
      width: workspace.minPaneWidth || DEFAULT_MIN_PANE_WIDTH,
      height: workspace.minPaneHeight || DEFAULT_MIN_PANE_HEIGHT,
    }
  }

  /**
   * Grid of the selected view for a pane area: the panes switched on in that view, in
   * order, as many as fit. Returns the tree and the ids of the panes that fit.
   */
  planViewAll(workspace: Workspace, width: number, height: number): { tree: LayoutSplit | null, shown: string[] } {
    const view = activeView(workspace)
    const visible = workspace.panes.filter((p) => isPaneOn(view, p.id)).map((p) => p.id)
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
      this.closeConfigFile(workspaceId)
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

  // ---------- VS Code ----------

  /**
   * The project folder: the workspace's own folder, else the first pane folder (usually the
   * project's working directory). For a Unix path on Windows, the WSL distro to open it in
   * (from the pane's profile; null = WSL's default distro).
   */
  projectFolder(workspace: Workspace): { path: string, wsl: boolean, distro: string | null } | null {
    const pane = workspace.panes.find((p) => p.cwd?.trim())
    let path = workspace.folder?.trim() || pane?.cwd?.trim()
    if (!path) return null
    // On Windows a Unix path (or ~) is a WSL folder; elsewhere ~ is the user's home
    const wsl = process.platform === 'win32' && (path.startsWith('/') || path === '~' || path.startsWith('~/'))
    if (!wsl && (path === '~' || path.startsWith('~/'))) path = os.homedir() + path.slice(1)
    if (!wsl) return { path, wsl, distro: null }
    // The distro of the first WSL pane (the folder's own pane first)
    const panes = pane ? [pane, ...workspace.panes] : workspace.panes
    for (const p of panes) {
      const profile = this.getProfileById(p.profileId)
      if (profile && this.isWslProfile(profile)) {
        return { path, wsl, distro: this.wslDistro(profile) }
      }
    }
    return { path, wsl, distro: null }
  }

  /** Opens the project folder in VS Code (`code` on PATH; WSL folders through WSL's `code`). */
  async openInVsCode(workspace: Workspace): Promise<void> {
    await this.getCachedProfiles() // built-in WSL profiles (for the distro) come from there
    const folder = this.projectFolder(workspace)
    if (!folder) {
      this.notifications.info('No project folder: set one in the workspace menu, or a folder on a pane')
      return
    }
    if (folder.wsl) {
      // wsl.exe is a real executable: arguments go through without a shell
      // --cd takes an absolute path or a bare ~; ~/x opens x relative to the home folder
      const home = folder.path.startsWith('~/')
      this.spawnCode('wsl.exe', [...(folder.distro ? ['-d', folder.distro] : []),
        '--cd', home ? '~' : folder.path, 'code', home ? folder.path.slice(2) : '.'])
    } else {
      this.spawnCode('code', [folder.path])
    }
  }

  /** Copies the project folder path to the clipboard. */
  copyProjectFolder(workspace: Workspace): void {
    const folder = this.projectFolder(workspace)
    if (!folder) {
      this.notifications.info('No project folder: set one in the workspace menu, or a folder on a pane')
      return
    }
    this.platform.setClipboard({ text: folder.path })
    this.notifications.info(`Copied ${folder.path}`)
  }

  /**
   * Opens a workspace's settings as a JSON file in VS Code. Tabby keeps its config.yaml
   * in memory and overwrites it on save, so the workspace gets a file of its own next to
   * it, written with the current settings on every open. Every save there is checked and
   * applied right away (workspaceEdited$); changes made in the sidebar are written back
   * to the file while it is watched (this session).
   */
  openConfigInVsCode(workspace: Workspace): void {
    const file = this.writeConfigFile(workspace, true)
    if (!file) return
    this.spawnCode('code', [file])
  }

  /**
   * Copies the path of the workspace's settings file (written with the current settings
   * and watched, so saves from any editor are applied, as with openConfigInVsCode).
   */
  copyConfigFilePath(workspace: Workspace): void {
    const file = this.writeConfigFile(workspace, true)
    if (!file) return
    this.platform.setClipboard({ text: file })
    this.notifications.info(`Copied ${file}`)
  }

  private configFilePath(workspace: Workspace): string {
    const configPath = this.platform.getConfigPath()
    const dir = path.join(configPath ? path.dirname(configPath) : os.tmpdir(), 'paneworks')
    const suffix = `-${workspace.id.replace(/[^A-Za-z0-9_-]/g, '_')}.json`
    // The name part follows the workspace name; after a rename, keep using the existing file
    try {
      const existing = fs.readdirSync(dir).find((f) => f.endsWith(suffix))
      if (existing) return path.join(dir, existing)
    } catch {
      // no folder yet
    }
    const slug = workspace.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'
    return path.join(dir, slug + suffix)
  }

  /** Writes the workspace to its config file (only one already watched, unless `start`). Returns the path. */
  private writeConfigFile(workspace: Workspace, start = false): string | null {
    let entry = this.configFiles.get(workspace.id)
    if (!entry && !start) return null
    const text = JSON.stringify(workspace, null, 2) + '\n'
    try {
      if (!entry) {
        const file = this.configFilePath(workspace)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        entry = { file, written: '' }
        this.configFiles.set(workspace.id, entry)
        const watched = entry
        fs.watchFile(file, { interval: 700 }, () => this.configFileChanged(workspace.id, watched))
      }
      // Opening it again starts over from the current settings (also after an invalid save)
      if (start) entry.invalid = false
      else {
        // A save the watcher hasn't picked up yet: apply it instead of writing over it
        let onDisk: string | null = null
        try { onDisk = fs.readFileSync(entry.file, 'utf8') } catch { /* gone: write it again */ }
        if (onDisk !== null && onDisk !== entry.written && onDisk.trim()) {
          this.configFileChanged(workspace.id, entry)
          return entry.file
        }
      }
      if (text !== entry.written && !entry.invalid) {
        fs.writeFileSync(entry.file, text)
        entry.written = text
      }
      return entry.file
    } catch (error) {
      console.error(`[${DISPLAY_NAME}] Could not write the workspace file:`, error)
      this.notifications.error(`Could not write the workspace file: ${error}`)
      return null
    }
  }

  private closeConfigFile(workspaceId: string): void {
    const entry = this.configFiles.get(workspaceId)
    if (!entry) return
    fs.unwatchFile(entry.file)
    this.configFiles.delete(workspaceId)
  }

  private async configFileChanged(workspaceId: string, entry: ConfigFile): Promise<void> {
    let text: string
    try {
      text = fs.readFileSync(entry.file, 'utf8')
    } catch {
      return // removed or being replaced; the next save triggers again
    }
    if (text === entry.written || !text.trim()) return
    entry.written = text
    const workspaces = this.getWorkspaces()
    const index = workspaces.findIndex((w) => w.id === workspaceId)
    if (index === -1) {
      this.closeConfigFile(workspaceId)
      return
    }
    let edited: Workspace
    try {
      edited = this.parseWorkspace(text, workspaces[index])
    } catch (error) {
      if (!entry.invalid) {
        this.notifications.error(`${workspaces[index].name}: not applied, ${(error as Error).message}. ` +
          'Until the file is valid, sidebar changes are not written to it; "Edit settings in VS Code" starts it over.')
      } else {
        this.notifications.error(`${workspaces[index].name}: not applied, ${(error as Error).message}`)
      }
      entry.invalid = true
      return
    }
    entry.invalid = false
    const target = workspaces[index]
    const before = deepClone(target)
    // In place, so sidebar actions holding this workspace see the edit instead of saving over it
    for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key]
    Object.assign(target, edited)
    await this.saveWorkspaces(workspaces)
    // Normalising may have changed it (e.g. ids added): show that in the file
    this.writeConfigFile(target)
    this.notifications.info(`${target.name}: settings applied from the file`)
    this.workspaceEdited$.next({ workspaceId, before })
  }

  /** Checks an edited workspace file. Ids missing on panes and views are generated; the workspace id stays. */
  private parseWorkspace(text: string, current: Workspace): Workspace {
    let data: Workspace
    try {
      data = JSON.parse(text)
    } catch (error) {
      throw new Error(`invalid JSON (${(error as Error).message})`)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('the file must hold one JSON object')
    if (!Array.isArray(data.panes) || !data.panes.length) throw new Error('"panes" must be a list with at least one pane')
    for (const pane of data.panes) {
      if (!pane || typeof pane !== 'object') throw new Error('every pane must be an object')
      if (typeof pane.id !== 'string' || !pane.id) pane.id = generateUUID()
      if (typeof pane.profileId !== 'string') throw new Error(`pane ${pane.name ?? pane.id}: "profileId" must be a string`)
      for (const key of ['name', 'cwd', 'startupCommand', 'color'] as const) {
        if (pane[key] === null) delete pane[key]
        if (pane[key] !== undefined && typeof pane[key] !== 'string') {
          throw new Error(`pane ${pane.id}: "${key}" must be a string`)
        }
      }
    }
    for (const key of ['name', 'folder', 'color', 'icon', 'activeViewId'] as const) {
      if (data[key] === null) delete data[key]
      if (data[key] !== undefined && typeof data[key] !== 'string') throw new Error(`"${key}" must be a string`)
    }
    for (const key of ['minPaneWidth', 'minPaneHeight'] as const) {
      if (data[key] === null) delete data[key]
      if (data[key] !== undefined && (typeof data[key] !== 'number' || !(data[key]! > 0))) {
        throw new Error(`"${key}" must be a number above 0`)
      }
    }
    if (data.launchOnStartup !== undefined && typeof data.launchOnStartup !== 'boolean') {
      throw new Error('"launchOnStartup" must be true or false')
    }
    const paneIds = data.panes.map((p) => p.id)
    if (new Set(paneIds).size !== paneIds.length) throw new Error('two panes have the same id')
    if (data.views !== undefined) {
      if (!Array.isArray(data.views)) throw new Error('"views" must be a list')
      const viewIds = new Set<string>()
      for (const view of data.views) {
        if (!view || typeof view !== 'object') throw new Error('every view must be an object')
        // Missing or repeated (a copied block): a new id
        if (typeof view.id !== 'string' || !view.id || viewIds.has(view.id)) view.id = generateUUID()
        viewIds.add(view.id)
        if (typeof view.name !== 'string' || !view.name.trim()) throw new Error('every view needs a "name"')
        if (view.hidden !== undefined && !Array.isArray(view.hidden)) throw new Error(`view ${view.name}: "hidden" must be a list of pane ids`)
        if (view.hidden) {
          if (view.hidden.some((id) => typeof id !== 'string')) throw new Error(`view ${view.name}: "hidden" must be a list of pane ids`)
          view.hidden = view.hidden.filter((id) => paneIds.includes(id))
          if (!view.hidden.length) delete view.hidden
        }
      }
    }
    data.id = current.id
    if (typeof data.name !== 'string' || !data.name.trim()) data.name = current.name
    return normalizeWorkspace(deepClone(data))
  }

  /**
   * Starts a program without a shell, so paths are never interpreted. On Windows `code` is a
   * batch file, which only cmd.exe can run: it gets the arguments quoted, and paths with
   * characters cmd.exe would still interpret (" % ! ^ & | < > and line breaks) are refused.
   */
  private spawnCode(program: string, args: string[]): void {
    let command = program
    let argv = args
    let options: Record<string, unknown> = { detached: true, stdio: 'ignore', windowsHide: true }
    if (process.platform === 'win32' && program === 'code') {
      // Inside quotes cmd.exe takes & | < > ^ literally (and ! with /v:off); " and % it would not
      if (args.some((a) => /["%\r\n]/.test(a))) {
        this.notifications.error('This path has characters that cannot be passed to VS Code safely: " or %')
        return
      }
      command = process.env.ComSpec || 'cmd.exe'
      // Backslashes before a closing quote are doubled (else C:\\ would escape the quote)
      argv = ['/d', '/v:off', '/s', '/c', `"code ${args.map((a) => `"${a.replace(/(\\+)$/, '$1$1')}"`).join(' ')}"`]
      options = { ...options, windowsVerbatimArguments: true }
    }
    try {
      const child = spawn(command, argv, options)
      child.on('error', (error: NodeJS.ErrnoException) => {
        // Started from Finder or a desktop launcher, Tabby may not have `code` on its PATH:
        // try again through the login shell (arguments as positional parameters, never parsed)
        if (error.code === 'ENOENT' && process.platform !== 'win32' && program === 'code') {
          // "$@" needs a POSIX shell (not fish); a login shell sets up the user's PATH
          const userShell = process.env.SHELL ?? ''
          const shell = /\/(ba|z|k|da)?sh$/.test(userShell) ? userShell : '/bin/sh'
          const retry = spawn(shell, ['-lc', 'exec code "$@"', 'code', ...args], options)
          retry.on('error', () => this.vsCodeFailed())
          retry.on('exit', (code) => { if (code) this.vsCodeFailed() })
          retry.unref()
          return
        }
        this.vsCodeFailed()
      })
      child.on('exit', (code) => { if (code) this.vsCodeFailed() })
      child.unref()
    } catch {
      this.vsCodeFailed()
    }
  }

  private vsCodeFailed(): void {
    this.notifications.error('Could not start VS Code. Is the "code" command on your PATH?')
  }

  /** `wsl.exe -d Ubuntu` / `--distribution Ubuntu` → Ubuntu; null when the profile uses the default. */
  private wslDistro(profile: TabbyProfile): string | null {
    const args = profile.options?.args ?? []
    const i = args.findIndex((a) => a === '-d' || a === '--distribution')
    return i >= 0 && args[i + 1] ? args[i + 1] : null
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
