#!/bin/sh
set -eu

if [ "$1" != configure ]; then
    exit 0
fi

chown root:root /opt/antseed-desktop/chrome-sandbox
chmod 4755 /opt/antseed-desktop/chrome-sandbox
ln -sfn /opt/antseed-desktop/antseed-desktop /usr/bin/antseed-desktop

# Upgraded from antseed-ai-vpn: the running app relaunches its own old path
# once the update is installed, so point that path at the new binary.
if [ -f /var/lib/antseed-desktop/relaunch-from-antseed-ai-vpn ]; then
    mkdir -p /opt/antseed-ai-vpn
    ln -sfn /opt/antseed-desktop/antseed-desktop /opt/antseed-ai-vpn/antseed-ai-vpn
    rm -f /var/lib/antseed-desktop/relaunch-from-antseed-ai-vpn
    rmdir /var/lib/antseed-desktop 2>/dev/null || true
fi

if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database /usr/share/mime || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
