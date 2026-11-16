#!/bin/sh
set -eu

case "$1" in
    remove|purge)
        if [ -L /usr/bin/antseed-desktop ] && [ "$(readlink /usr/bin/antseed-desktop)" = /opt/antseed-desktop/antseed-desktop ]; then
            rm /usr/bin/antseed-desktop
        fi
        # The relaunch link left for the upgrade from antseed-ai-vpn.
        if [ -L /opt/antseed-ai-vpn/antseed-ai-vpn ] && [ "$(readlink /opt/antseed-ai-vpn/antseed-ai-vpn)" = /opt/antseed-desktop/antseed-desktop ]; then
            rm /opt/antseed-ai-vpn/antseed-ai-vpn
            rmdir /opt/antseed-ai-vpn 2>/dev/null || true
        fi
        if command -v update-mime-database >/dev/null 2>&1; then
            update-mime-database /usr/share/mime || true
        fi
        if command -v update-desktop-database >/dev/null 2>&1; then
            update-desktop-database /usr/share/applications || true
        fi
        ;;
esac
