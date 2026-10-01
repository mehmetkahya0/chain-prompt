// node-pty spawns every macOS/Linux pty through a small `spawn-helper` binary.
// Some npm installs drop its executable bit, and then every launch fails with
// "posix_spawnp failed". Restore it after `npm install` and inside packaged apps.
//
// - `node scripts/fix-node-pty.cjs`  fixes ./node_modules (postinstall)
// - electron-builder `afterPack`     fixes the packaged app (default export)
const { chmodSync, existsSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

function fixPrebuilds(nodePtyDir) {
  for (const dir of [join(nodePtyDir, 'prebuilds'), join(nodePtyDir, 'build', 'Release')]) {
    if (!existsSync(dir)) continue
    const candidates = [join(dir, 'spawn-helper'), ...readdirSync(dir).map((d) => join(dir, d, 'spawn-helper'))]
    for (const file of candidates) if (existsSync(file)) chmodSync(file, 0o755)
  }
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName === 'win32') return
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources')
  fixPrebuilds(join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'))
}

if (require.main === module && process.platform !== 'win32') {
  fixPrebuilds(join(__dirname, '..', 'node_modules', 'node-pty'))
}
