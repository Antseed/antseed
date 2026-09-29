#!/bin/sh
set -eu

if [ "$1" != configure ]; then
    exit 0
fi

chown root:root /opt/antseed-ai-vpn/chrome-sandbox
chmod 4755 /opt/antseed-ai-vpn/chrome-sandbox
ln -sfn /opt/antseed-ai-vpn/antseed-ai-vpn /usr/bin/antseed-ai-vpn

if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database /usr/share/mime || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
