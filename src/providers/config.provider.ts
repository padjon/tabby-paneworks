import { Injectable } from '@angular/core'
import { ConfigProvider } from 'tabby-core'
import { CONFIG_KEY, IS_DEV } from '../build-config'
import { OPEN_MENU_HOTKEY } from './hotkey.provider'

@Injectable()
export class WorkspaceEditorConfigProvider extends ConfigProvider {
  defaults = {
    [CONFIG_KEY]: {
      workspaces: [],
    },
    hotkeys: {
      // F1 opens the menu; the dev build has no default so it doesn't open a second menu
      [OPEN_MENU_HOTKEY]: IS_DEV ? [] : ['F1'],
    },
  }
}
