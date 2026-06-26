// electron-builder afterPack hook.
//
// We keep win.signAndEditExecutable=false so electron-builder never fetches
// winCodeSign (its bundle contains macOS symlinks that fail to extract on
// non-admin Windows). That also skips the default rcedit pass, so the app exe
// would otherwise keep Electron's default icon. Here we stamp the real Neurion
// icon + version strings onto the exe ourselves using the standalone rcedit
// binary (no winCodeSign / no signing involved).

const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const rcedit = require('rcedit');
  const exeName = `${context.packager.appInfo.productFilename}.exe`; // "Neurion.exe"
  const exe = path.join(context.appOutDir, exeName);
  const icon = path.join(__dirname, '..', 'build', 'icon.ico');

  await rcedit(exe, {
    icon,
    'version-string': {
      ProductName: 'Neurion',
      FileDescription: 'Neurion — distributed AI compute',
      CompanyName: 'JIT Engineering',
      LegalCopyright: '© 2026 JIT Engineering',
      OriginalFilename: exeName,
    },
  });

  console.log(`afterPack: stamped Neurion icon onto ${exe}`);
};
