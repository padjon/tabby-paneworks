import { Injectable } from '@angular/core'
import { HotkeyDescription, HotkeyProvider } from 'tabby-core'
import { CONFIG_KEY, DISPLAY_NAME } from '../build-config'

/** Hotkey id; prefixed with the config key so the dev build gets its own. */
export const OPEN_MENU_HOTKEY = `${CONFIG_KEY}-open-menu`

/** Lists the hotkey under Settings → Hotkeys, where it can be rebound. */
@Injectable()
export class WorkspaceHotkeyProvider extends HotkeyProvider {
  async provide(): Promise<HotkeyDescription[]> {
    return [{ id: OPEN_MENU_HOTKEY, name: `${DISPLAY_NAME}: open menu` }]
  }
}
