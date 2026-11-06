const path = require('node:path');
const fs = require('node:fs');

module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'mobgap',
    appBundleId: 'org.mobilise-d.mobgap',
    appCategoryType: 'public.app-category.healthcare-fitness',
    // All dependencies are build tools; the installed app loads its own bundled runtime.
    ignore: (filename) => {
      if (!filename) return false;
      return !['/src', '/runtime', '/package.json', '/LICENSE', '/NOTICE'].some((prefix) =>
        filename === prefix || filename.startsWith(`${prefix}/`));
    },
  },
  makers: [
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'win32', 'linux'] },
    // Keep ZIP cross-builds available on macOS. Build the installer on the Windows CI runner.
    ...(process.platform === 'win32' ? [{
      name: '@electron-forge/maker-squirrel', platforms: ['win32'],
      config: { name: 'MobGap', exe: 'mobgap.exe', setupExe: 'MobGapSetup.exe', noMsi: true },
    }] : []),
  ],
  hooks: {
    generateAssets: async () => {
      const manifest = path.join(__dirname, 'runtime/manifest.json');
      if (!fs.existsSync(manifest)) throw new Error('Run npm run runtime:prepare before packaging.');
      for (const file of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(__dirname, file));
    },
  },
};
