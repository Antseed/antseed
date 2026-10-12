const path = require('node:path');

module.exports = {
  extends: path.join(__dirname, 'electron-builder.yml'),
  productName: 'antseed-ai-vpn',
  linux: {
    executableName: 'antseed-ai-vpn',
    artifactName: 'Antseed-AI-VPN-${version}-${arch}.${ext}',
    desktop: {
      Name: 'Antseed AI VPN',
      StartupWMClass: 'Antseed AI VPN',
    },
  },
  deb: {
    packageName: 'antseed-ai-vpn',
    afterInstall: path.join(__dirname, 'scripts/linux/postinst.sh'),
    afterRemove: path.join(__dirname, 'scripts/linux/postrm.sh'),
    fpm: ['--before-install', path.join(__dirname, 'scripts/linux/preinst.sh')],
  },
};
