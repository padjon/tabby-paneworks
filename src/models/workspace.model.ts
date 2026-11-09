// Tabby profile interfaces
export interface TabbyProfileOptions {
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  restoreFromPTYID?: boolean
  width?: number | null
  height?: number | null
  pauseAfterExit?: boolean
  runAsAdministrator?: boolean
}

export interface TabbyProfile {
  id: string
  type: string
  name: string
  group?: string
  icon?: string
  color?: string
  options?: TabbyProfileOptions
  isBuiltin?: boolean
  isTemplate?: boolean
  weight?: number
  disableDynamicTitle?: boolean
  terminalColorScheme?: string | null
  behaviorOnSessionEnd?: string
}

export interface TabbyRecoveryToken {
  type: string
  orientation?: 'h' | 'v'
  ratios?: number[]
  children?: TabbyRecoveryToken[]
  profile?: Partial<TabbyProfile>
  savedState?: boolean
  tabTitle?: string
  tabCustomTitle?: string
  disableDynamicTitle?: boolean
  cwd?: string
  // Allow custom properties (matches Tabby's RecoveryToken interface)
  [key: string]: any
}

export interface TabbySplitLayoutProfile {
  id: string
  type: 'split-layout'
  name: string
  group: string
  icon?: string
  color?: string
  isBuiltin: boolean
  options: {
    recoveryToken: TabbyRecoveryToken
  }
}

// Workspace interfaces
export interface WorkspacePane {
  id: string
  name?: string
  profileId: string
  cwd?: string
  startupCommand?: string
  /** Switched off in the sidebar: not part of "View all" (still reachable by focus view). */
  hidden?: boolean
}

export interface WorkspaceBackground {
  type: 'none' | 'solid' | 'gradient' | 'image'
  value: string  // CSS value: hex, gradient string, or URL
}

export interface Workspace {
  id: string
  name: string
  icon?: string
  color?: string
  background?: WorkspaceBackground
  /** All panes, in sidebar and grid order. */
  panes: WorkspacePane[]
  /** Smallest pane size in px; decides how many panes fit and in how many rows. */
  minPaneWidth?: number
  minPaneHeight?: number
  launchOnStartup?: boolean
}

export const DEFAULT_MIN_PANE_WIDTH = 600
export const DEFAULT_MIN_PANE_HEIGHT = 260

/** Tree used internally to build Tabby's split layout. */
export interface LayoutPaneRef {
  paneId: string
}

export interface LayoutSplit {
  orientation: 'horizontal' | 'vertical'
  ratios: number[]
  children: (LayoutPaneRef | LayoutSplit)[]
}

export function isLayoutSplit(node: LayoutPaneRef | LayoutSplit): node is LayoutSplit {
  return 'children' in node
}

/** Pane ids of a layout tree in reading order. */
export function layoutPaneIds(split: LayoutSplit): string[] {
  return split.children.flatMap((c) => isLayoutSplit(c) ? layoutPaneIds(c) : [c.paneId])
}

/**
 * Grid plan: how many panes go in each row.
 * Fits as many of `count` panes as the minimum size allows in width x height,
 * and among the arrangements that fit picks the one with the largest panes
 * (relative to the minimum size); rows are filled evenly, fuller rows first.
 * Examples (min 600x260, area 1900x1000, capacity 3x3): 3 panes -> [2, 1];
 * 4 -> [2, 2]; 5 -> [2, 2, 1]; 8 -> [3, 3, 2]. In 1200x700 (capacity 2x2)
 * 8 panes -> [2, 2]: only the first 4 are shown.
 */
export function planGrid(count: number, width: number, height: number, minWidth: number, minHeight: number): number[] {
  if (count <= 0) return []
  const maxCols = Math.max(1, Math.floor(width / Math.max(1, minWidth)))
  const maxRows = Math.max(1, Math.floor(height / Math.max(1, minHeight)))
  const shown = Math.min(count, maxCols * maxRows)
  let best: { rows: number, score: number } | null = null
  for (let rows = 1; rows <= Math.min(shown, maxRows); rows++) {
    const perRow = Math.ceil(shown / rows)
    if (perRow > maxCols) continue
    const score = Math.min(width / perRow / minWidth, height / rows / minHeight)
    if (!best || score > best.score + 1e-9) best = { rows, score }
  }
  const rows = best?.rows ?? 1
  const base = Math.floor(shown / rows)
  const extra = shown % rows
  return Array.from({ length: rows }, (_, i) => base + (i < extra ? 1 : 0))
}

/** Layout tree for panes arranged by a grid plan (rows stacked, panes side by side). */
export function gridTree(paneIds: string[], rows: number[]): LayoutSplit {
  let offset = 0
  const rowNodes = rows.map((n): LayoutPaneRef | LayoutSplit => {
    const ids = paneIds.slice(offset, offset + n)
    offset += n
    return ids.length === 1
      ? { paneId: ids[0] }
      : { orientation: 'horizontal', ratios: ids.map(() => 1 / ids.length), children: ids.map((paneId) => ({ paneId })) }
  })
  if (rowNodes.length === 1 && isLayoutSplit(rowNodes[0])) return rowNodes[0]
  return { orientation: 'vertical', ratios: rowNodes.map(() => 1 / rowNodes.length), children: rowNodes }
}

/**
 * Brings a stored workspace to the current shape: workspaces saved with a pane tree
 * (`root`, TabbySpaces style) get their panes as a flat list in reading order.
 */
export function normalizeWorkspace(workspace: Workspace): Workspace {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const legacy = workspace as any
  if (!Array.isArray(workspace.panes)) {
    const panes: WorkspacePane[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (node: any) => {
      if (!node) return
      if (Array.isArray(node.children)) node.children.forEach(walk)
      else if (node.id) panes.push(node)
    }
    walk(legacy.root)
    workspace.panes = [...panes, ...(legacy.extraPanes ?? [])]
  }
  delete legacy.root
  delete legacy.extraPanes
  delete legacy.layouts
  delete legacy.mainLayoutName
  return workspace
}

// Preset backgrounds for quick selection
export const BACKGROUND_PRESETS: WorkspaceBackground[] = [
  { type: 'none', value: '' },
  // Existing presets
  { type: 'gradient', value: 'linear-gradient(132deg, transparent 83%, rgba(6, 220, 249, 0.18) 100%), linear-gradient(210deg, transparent 85%, rgba(139, 92, 246, 0.2) 100%)' },
  { type: 'gradient', value: 'linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, transparent 50%)' },
  { type: 'gradient', value: 'linear-gradient(45deg, rgba(239, 68, 68, 0.1) 0%, transparent 50%)' },
  { type: 'gradient', value: 'linear-gradient(135deg, rgba(59, 130, 246, 0.15) 0%, transparent 50%)' },
  { type: 'gradient', value: 'linear-gradient(225deg, transparent 70%, rgba(249, 115, 22, 0.15) 100%)' },
  { type: 'gradient', value: 'linear-gradient(180deg, rgba(139, 92, 246, 0.1) 0%, transparent 40%)' },
  // New presets
  { type: 'gradient', value: 'linear-gradient(315deg, transparent 80%, rgba(236, 72, 153, 0.15) 100%)' }, // Pink bottom-right
  { type: 'gradient', value: 'linear-gradient(0deg, rgba(6, 182, 212, 0.12) 0%, transparent 35%)' }, // Cyan bottom
  { type: 'gradient', value: 'linear-gradient(45deg, transparent 85%, rgba(234, 179, 8, 0.18) 100%), linear-gradient(225deg, transparent 85%, rgba(249, 115, 22, 0.15) 100%)' }, // Gold corners
  { type: 'gradient', value: 'linear-gradient(160deg, rgba(34, 197, 94, 0.12) 0%, transparent 40%)' }, // Green top-left
  { type: 'gradient', value: 'linear-gradient(200deg, transparent 75%, rgba(99, 102, 241, 0.18) 100%)' }, // Indigo bottom-left
  { type: 'gradient', value: 'linear-gradient(135deg, rgba(20, 184, 166, 0.1) 0%, transparent 50%), linear-gradient(315deg, rgba(139, 92, 246, 0.1) 0%, transparent 50%)' }, // Teal + Violet diagonal
  { type: 'gradient', value: 'linear-gradient(90deg, rgba(239, 68, 68, 0.08) 0%, transparent 30%, transparent 70%, rgba(59, 130, 246, 0.08) 100%)' }, // Red-Blue sides
  { type: 'gradient', value: 'linear-gradient(180deg, transparent 60%, rgba(16, 185, 129, 0.12) 100%)' }, // Emerald bottom fade
  { type: 'gradient', value: 'linear-gradient(45deg, rgba(168, 85, 247, 0.1) 0%, transparent 40%), linear-gradient(225deg, rgba(6, 182, 212, 0.1) 0%, transparent 40%)' }, // Purple + Cyan corners
  { type: 'gradient', value: 'linear-gradient(150deg, transparent 70%, rgba(251, 146, 60, 0.15) 100%), linear-gradient(30deg, transparent 70%, rgba(251, 146, 60, 0.1) 100%)' }, // Warm orange accents
]

/**
 * Hidden marker that identifies a workspace pane at runtime.
 * Stored in the pane's profile `group` field: Tabby keeps that field on the tab
 * (including after app restart recovery) and never shows it on a running tab.
 * An unknown group id makes Tabby skip group defaults, nothing else.
 */
export const PANE_MARKER_PREFIX = 'paneworks:'

export function makePaneMarker(workspaceId: string, paneId: string): string {
  return `${PANE_MARKER_PREFIX}${workspaceId}:${paneId}`
}

export function parsePaneMarker(group: unknown): { workspaceId: string, paneId: string } | null {
  if (typeof group !== 'string' || !group.startsWith(PANE_MARKER_PREFIX)) {
    return null
  }
  const [workspaceId, paneId] = group.slice(PANE_MARKER_PREFIX.length).split(':')
  return workspaceId && paneId ? { workspaceId, paneId } : null
}

/**
 * Text of a pane label: the program's title, prefixed by the pane name when one is set.
 * Examples: ('C1', 'Claude Code') -> 'C1 · Claude Code'; ('', 'Claude Code') -> 'Claude Code'.
 */
export function formatPaneLabel(paneName: string | undefined, programTitle: string | undefined): string {
  const name = (paneName ?? '').trim()
  const title = (programTitle ?? '').trim()
  if (!name) return title
  if (!title || title === name || title.startsWith(`${name} · `)) return name
  return `${name} · ${title}`
}

/** Finds a pane of a workspace by id. */
export function findPane(workspace: Workspace, paneId: string): WorkspacePane | undefined {
  return workspace.panes.find((p) => p.id === paneId)
}

/**
 * Creates a new pane with default configuration.
 * @returns A new WorkspacePane with generated UUID and empty settings
 */
export function createDefaultPane(): WorkspacePane {
  return {
    id: generateUUID(),
    profileId: '',
    cwd: '',
    startupCommand: '',
  }
}

// Color palette for workspaces
const WORKSPACE_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
]

// Icon list for workspaces
const WORKSPACE_ICONS = [
  'columns', 'terminal', 'code', 'folder', 'home', 'briefcase',
  'cog', 'database', 'server', 'cloud', 'rocket', 'flask',
  'bug', 'wrench', 'cube', 'layer-group', 'sitemap', 'project-diagram'
]

/** Returns a random color from the workspace color palette. */
export function getRandomColor(): string {
  return WORKSPACE_COLORS[Math.floor(Math.random() * WORKSPACE_COLORS.length)]
}

/** Returns a random icon from the workspace icon set. */
export function getRandomIcon(): string {
  return WORKSPACE_ICONS[Math.floor(Math.random() * WORKSPACE_ICONS.length)]
}

/**
 * Creates a new workspace with default configuration.
 * @param name - Display name for the workspace (optional)
 * @returns A new Workspace with generated UUID, random icon/color and two panes
 */
export function createDefaultWorkspace(name: string = ''): Workspace {
  return {
    id: generateUUID(),
    name,
    icon: getRandomIcon(),
    color: getRandomColor(),
    panes: [createDefaultPane(), createDefaultPane()],
    launchOnStartup: false,
  }
}

/** Generates a random UUID v4 string. */
export function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/**
 * Creates a deep clone of an object, preserving type information.
 * More efficient than JSON.parse(JSON.stringify()) for simple objects.
 * @param obj - The object to clone
 * @returns A deep copy of the object
 */
export function deepClone<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') {
    return obj
  }
  if (Array.isArray(obj)) {
    return obj.map(item => deepClone(item)) as T
  }
  const cloned = {} as T
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone(obj[key])
    }
  }
  return cloned
}
