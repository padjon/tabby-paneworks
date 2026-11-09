import { Injectable } from '@angular/core'
import { ToolbarButtonProvider, ToolbarButton, AppService } from 'tabby-core'
import { WorkspaceEditorService } from '../services/workspaceEditor.service'
import { LayoutService } from '../services/layout.service'
import { DISPLAY_NAME, IS_DEV } from '../build-config'

const ICON_GRID = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="3" width="7" height="7"/>
  <rect x="14" y="3" width="7" height="7"/>
  <rect x="14" y="14" width="7" height="7"/>
  <rect x="3" y="14" width="7" height="7"/>
</svg>`

const ICON_BOLT = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
</svg>`

const NEW_WORKSPACE = '__new__'

/**
 * The toolbar button: the entry point outside a workspace tab. Lists the workspaces
 * (open one, or bring it to the front if already open) and creates new ones.
 * Everything else is managed in the workspace tab's sidebar.
 */
@Injectable()
export class WorkspaceToolbarProvider extends ToolbarButtonProvider {
  constructor(
    private workspaceService: WorkspaceEditorService,
    private app: AppService,
    private layout: LayoutService
  ) {
    super()
    // Wait for Tabby to finish recovering tabs before launching startup workspaces
    this.waitForTabbyReady().then(() => {
      this.workspaceService.cleanupOrphanedProfiles()
      this.launchStartupWorkspaces()
    })
  }

  private waitForTabbyReady(): Promise<void> {
    return new Promise(resolve => {
      let lastTabCount = -1
      const checkStable = () => {
        const currentCount = this.app.tabs.length
        if (currentCount === lastTabCount) {
          resolve()
        } else {
          lastTabCount = currentCount
          setTimeout(checkStable, 300)
        }
      }
      setTimeout(checkStable, 500)
    })
  }

  private async launchStartupWorkspaces(): Promise<void> {
    for (const workspace of this.workspaceService.getWorkspaces().filter((w) => w.launchOnStartup)) {
      if (this.layout.findOpenTab(workspace.id)) {
        console.log(`[${DISPLAY_NAME}] Workspace "${workspace.name}" already open, skipping`)
        continue
      }
      await this.layout.openWorkspace(workspace.id)
    }
  }

  provide(): ToolbarButton[] {
    return [
      {
        icon: IS_DEV ? ICON_BOLT : ICON_GRID,
        title: DISPLAY_NAME,
        weight: 5,
        click: () => this.showWorkspaceSelector(),
      },
    ]
  }

  private async showWorkspaceSelector(): Promise<void> {
    const options = this.workspaceService.getWorkspaces().map((ws) => ({
      name: ws.name,
      description: `${ws.panes.length} panes${this.layout.findOpenTab(ws.id) ? ' · open' : ''}`,
      icon: ws.icon || 'columns',
      color: ws.color,
      result: ws.id,
    }))
    options.push({
      name: 'New workspace',
      description: 'Create a workspace with one pane; set it up in its sidebar',
      icon: 'plus',
      color: undefined,
      result: NEW_WORKSPACE,
    })

    const selected = await this.app.showSelector(DISPLAY_NAME, options)
    if (selected === NEW_WORKSPACE) {
      await this.layout.createWorkspace()
    } else if (selected) {
      await this.layout.openWorkspace(selected)
    }
  }
}
