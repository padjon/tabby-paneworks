import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { ConfigProvider, HotkeyProvider, ToolbarButtonProvider } from 'tabby-core'

import { WorkspaceEditorConfigProvider } from './providers/config.provider'
import { WorkspaceToolbarProvider } from './providers/toolbar.provider'
import { WorkspaceHotkeyProvider } from './providers/hotkey.provider'
import { WorkspaceEditorService } from './services/workspaceEditor.service'
import { PaneRuntimeService } from './services/paneRuntime.service'
import { LayoutService } from './services/layout.service'

/**
 * Paneworks: no settings page. The toolbar button (or F1) opens and creates workspaces;
 * everything else is managed in the sidebar of a workspace tab (LayoutService).
 */
@NgModule({
  imports: [CommonModule],
  providers: [
    { provide: ConfigProvider, useClass: WorkspaceEditorConfigProvider, multi: true },
    { provide: ToolbarButtonProvider, useClass: WorkspaceToolbarProvider, multi: true },
    { provide: HotkeyProvider, useClass: WorkspaceHotkeyProvider, multi: true },
    WorkspaceEditorService,
    PaneRuntimeService,
    LayoutService,
  ],
})
export default class PaneworksModule {}

export { WorkspaceEditorService }
