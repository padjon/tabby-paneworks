// Keeps a local Tabby in sync with the latest build: after a build, copies the build into
// every place the local Tabby loads the plugin from. Runs from build-prod.js / build-dev.js.
//
// Only touches a Tabby that already has the plugin installed (Settings → Plugins or
// `npm install <repo>/dist` in Tabby's plugins folder). Anywhere else (CI, a machine without
// Tabby) it does nothing. Works from Windows (%APPDATA%) and from WSL (/mnt/c/Users/*).
//
// Two targets per Tabby:
//  - plugins/node_modules/<package>: the copy Tabby actually loads
//  - the folder a `file:` dependency in plugins/package.json points to: npm copies from there
//    whenever Tabby's plugin manager reinstalls, so it must not hold an older build
const fs = require('fs')
const path = require('path')

function tabbyPluginDirs() {
  const dirs = []
  if (process.env.APPDATA) {
    dirs.push(path.join(process.env.APPDATA, 'tabby', 'plugins'))
  }
  const wslUsers = '/mnt/c/Users'
  if (process.platform === 'linux' && fs.existsSync(wslUsers)) {
    for (const user of safeReaddir(wslUsers)) {
      dirs.push(path.join(wslUsers, user, 'AppData', 'Roaming', 'tabby', 'plugins'))
    }
  }
  return dirs.filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** `file:D:/x/dist` → `D:/x/dist` (Windows) or `/mnt/d/x/dist` (WSL); null for non-file specs. */
function fileSpecToPath(spec, pluginsDir) {
  if (typeof spec !== 'string' || !spec.startsWith('file:')) return null
  let p = spec.slice('file:'.length).replace(/^\/\/(?=[A-Za-z]:)/, '')
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (drive && process.platform === 'linux') {
    p = `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`
  }
  return path.resolve(pluginsDir, p)
}

function installLocal(distDir, packageName) {
  for (const pluginsDir of tabbyPluginDirs()) {
    const installed = path.join(pluginsDir, 'node_modules', packageName)
    if (!fs.existsSync(installed)) continue

    const targets = [installed]
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'package.json'), 'utf8'))
      const source = fileSpecToPath((pkg.dependencies || {})[packageName], pluginsDir)
      if (source && path.resolve(source) !== path.resolve(distDir) && fs.existsSync(source)) {
        targets.push(source)
      }
    } catch {
      // unreadable plugins/package.json: still update the installed copy
    }

    for (const target of targets) {
      try {
        // Symlinked install (npm link): it already is the build
        if (fs.realpathSync(target) === fs.realpathSync(distDir)) continue
        // Only ever overwrite a build, never a source folder (e.g. a file: install of the repo root)
        if (fs.existsSync(path.join(target, 'src')) || fs.existsSync(path.join(target, '.git'))) {
          console.warn(`Skipped ${target}: looks like a source folder, not a build`)
          continue
        }
        // Overwrite in place (no delete first), so a failure never leaves Tabby without the plugin
        fs.cpSync(distDir, target, { recursive: true, force: true })
        console.log(`Local Tabby updated: ${target}`)
      } catch (e) {
        console.warn(`Could not update ${target}: ${e.message} (is Tabby holding a file open?)`)
      }
    }
  }
}

module.exports = { installLocal }
