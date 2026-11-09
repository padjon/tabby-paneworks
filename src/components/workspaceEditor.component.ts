import { Component, Input, Output, EventEmitter, OnInit, OnChanges, AfterViewInit, SimpleChanges, HostListener, ElementRef, ViewChild, ChangeDetectorRef } from '@angular/core'
import {
  Workspace,
  WorkspacePane,
  WorkspaceBackground,
  TabbyProfile,
  createDefaultPane,
  BACKGROUND_PRESETS,
  DEFAULT_MIN_PANE_WIDTH,
  DEFAULT_MIN_PANE_HEIGHT,
} from '../models/workspace.model'
import { WorkspaceEditorService } from '../services/workspaceEditor.service'

@Component({
  selector: 'pw-workspace-editor',
  template: require('./workspaceEditor.component.pug'),
  styles: [require('./workspaceEditor.component.scss')],
})
export class WorkspaceEditorComponent implements OnInit, OnChanges, AfterViewInit {
  @Input() workspace!: Workspace
  @Input() autoFocus = false
  @Input() hasUnsavedChanges = false
  @Output() save = new EventEmitter<Workspace>()
  @Output() cancel = new EventEmitter<void>()

  @ViewChild('nameInput') nameInput!: ElementRef<HTMLInputElement>

  profiles: TabbyProfile[] = []
  availableIcons = [
    'columns', 'terminal', 'code', 'folder', 'home', 'briefcase',
    'cog', 'database', 'server', 'cloud', 'rocket', 'flask',
    'bug', 'wrench', 'cube', 'layer-group', 'sitemap', 'project-diagram'
  ]
  iconDropdownOpen = false
  backgroundPresets = BACKGROUND_PRESETS
  backgroundDropdownOpen = false
  customBackgroundValue = ''
  readonly defaultMinWidth = DEFAULT_MIN_PANE_WIDTH
  readonly defaultMinHeight = DEFAULT_MIN_PANE_HEIGHT

  constructor(
    private workspaceService: WorkspaceEditorService,
    private elementRef: ElementRef,
    private cdr: ChangeDetectorRef
  ) {}

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    const target = event.target as Node
    const root = this.elementRef.nativeElement as HTMLElement
    const inside = (selector: string) => root.querySelector(selector)?.contains(target)
    if (this.iconDropdownOpen && !inside('.dropdown-trigger') && !inside('.icon-dropdown')) {
      this.iconDropdownOpen = false
    }
    if (this.backgroundDropdownOpen && !inside('.background-trigger') && !inside('.background-dropdown')) {
      this.backgroundDropdownOpen = false
    }
  }

  toggleIconDropdown(): void {
    this.iconDropdownOpen = !this.iconDropdownOpen
  }

  selectIcon(icon: string): void {
    this.workspace.icon = icon
    this.iconDropdownOpen = false
  }

  toggleBackgroundDropdown(): void {
    this.backgroundDropdownOpen = !this.backgroundDropdownOpen
  }

  selectBackgroundPreset(preset: WorkspaceBackground): void {
    if (preset.type === 'none') {
      this.workspace.background = undefined
      this.customBackgroundValue = ''
    } else {
      this.workspace.background = { ...preset }
      this.customBackgroundValue = preset.value
    }
    this.backgroundDropdownOpen = false
  }

  applyCustomBackground(): void {
    const value = this.customBackgroundValue.trim()
    this.workspace.background = value ? { type: 'gradient', value } : undefined
  }

  isBackgroundSelected(preset: WorkspaceBackground): boolean {
    if (preset.type === 'none') {
      return !this.workspace.background || this.workspace.background.type === 'none'
    }
    return this.workspace.background?.value === preset.value
  }

  async ngOnInit(): Promise<void> {
    this.profiles = await this.workspaceService.getAvailableProfiles()
    this.initializeWorkspace()
    this.cdr.detectChanges()
  }

  ngAfterViewInit(): void {
    if (this.autoFocus) {
      this.focusNameInput()
    }
  }

  private focusNameInput(): void {
    requestAnimationFrame(() => {
      setTimeout(() => {
        this.nameInput?.nativeElement?.focus()
        this.nameInput?.nativeElement?.select()
      }, 0)
    })
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['workspace'] && !changes['workspace'].firstChange) {
      if (changes['workspace'].previousValue?.id !== this.workspace.id) {
        this.focusNameInput()
      }
      this.iconDropdownOpen = false
      this.backgroundDropdownOpen = false
      this.customBackgroundValue = this.workspace.background?.value || ''
      this.initializeWorkspace()
    }
    if (changes['autoFocus']?.currentValue) {
      this.focusNameInput()
    }
  }

  private initializeWorkspace(): void {
    if (!Array.isArray(this.workspace.panes)) {
      this.workspace.panes = []
    }
    if (!this.workspace.panes.length) {
      this.addPane()
    }
  }

  // ---------- panes ----------

  get localProfiles(): TabbyProfile[] {
    return this.profiles.filter((p) => p.type === 'local' || p.type?.startsWith('local:'))
  }

  get sshProfiles(): TabbyProfile[] {
    return this.profiles.filter((p) => p.type === 'ssh')
  }

  get otherProfiles(): TabbyProfile[] {
    return this.profiles.filter((p) => p.type !== 'local' && !p.type?.startsWith('local:') && p.type !== 'ssh')
  }

  addPane(): void {
    const pane = createDefaultPane()
    const last = this.workspace.panes[this.workspace.panes.length - 1]
    pane.profileId = last?.profileId || this.localProfiles[0]?.id || this.profiles[0]?.id || ''
    pane.cwd = last?.cwd || ''
    this.workspace.panes.push(pane)
  }

  removePane(index: number): void {
    if (this.workspace.panes.length > 1) {
      this.workspace.panes.splice(index, 1)
    }
  }

  movePane(index: number, delta: number): void {
    const target = index + delta
    if (target < 0 || target >= this.workspace.panes.length) return
    const [pane] = this.workspace.panes.splice(index, 1)
    this.workspace.panes.splice(target, 0, pane)
  }

  toggleShown(pane: WorkspacePane): void {
    if (pane.hidden) delete pane.hidden
    else pane.hidden = true
  }

  /** Empty input = default; stored only when set. */
  setMinSize(key: 'minPaneWidth' | 'minPaneHeight', value: string | number | null): void {
    const n = Math.round(Number(value))
    if (n > 0) this.workspace[key] = n
    else delete this.workspace[key]
  }

  trackByPane(_index: number, pane: WorkspacePane): string {
    return pane.id
  }

  onSave(): void {
    if (!this.workspace.name?.trim()) {
      return
    }
    this.save.emit(this.workspace)
  }

  onCancel(): void {
    this.cancel.emit()
  }
}
