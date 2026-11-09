const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

// 1. Clean dist
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true })
}

// 2. Run webpack
console.log('Building production version...')
const webpackCli = path.join(rootDir, 'node_modules', 'webpack-cli', 'bin', 'cli.js')
execSync(`node "${webpackCli}" --mode production`, {
  cwd: rootDir,
  stdio: 'inherit'
})

// 3. Create package.json
const pkg = require(path.join(rootDir, 'package.json'))
const prodPkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  main: 'index.js',
  keywords: pkg.keywords,
  peerDependencies: pkg.peerDependencies,
  author: pkg.author,
  license: pkg.license,
  repository: pkg.repository,
  homepage: pkg.homepage,
  bugs: pkg.bugs,
  tabbyPlugin: pkg.tabbyPlugin
}

fs.writeFileSync(
  path.join(distDir, 'package.json'),
  JSON.stringify(prodPkg, null, 2)
)

// 4. README (shown on npm) and LICENSE (required by MIT) go into the published package
for (const file of ['README.md', 'LICENSE']) {
  fs.copyFileSync(path.join(rootDir, file), path.join(distDir, file))
}

console.log('Production build complete: dist/')
