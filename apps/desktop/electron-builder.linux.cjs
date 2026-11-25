const path = require('node:path');

module.exports = {
  extends: path.join(__dirname, 'electron-builder.yml'),
  productName: 'antseed-desktop',
  linux: {
    executableName: 'antseed-desktop',
    artifactName: 'Antseed-Desktop-${version}-${arch}.${ext}',
    desktop: {
      Name: 'Antseed Desktop',
      StartupWMClass: 'Antseed Desktop',
    },
  },
  deb: {
    packageName: 'antseed-desktop',
    // Renamed from antseed-ai-vpn: Conflicts + Replaces makes dpkg remove the
    // old package when this one is installed, so an upgrade (including
    // electron-updater's `dpkg -i`) replaces it instead of installing a second
    // copy. Provides keeps anything depending on the old name satisfied.
    afterInstall: path.join(__dirname, 'scripts/linux/postinst.sh'),
    afterRemove: path.join(__dirname, 'scripts/linux/postrm.sh'),
    fpm: [
      '--before-install', path.join(__dirname, 'scripts/linux/preinst.sh'),
      '--conflicts', 'antseed-ai-vpn',
      '--replaces', 'antseed-ai-vpn',
      '--provides', 'antseed-ai-vpn',
    ],
  },
};
