#!/bin/sh
set -eu

case "$1" in
    remove|purge)
        if [ -L /usr/bin/antseed-ai-vpn ] && [ "$(readlink /usr/bin/antseed-ai-vpn)" = /opt/antseed-ai-vpn/antseed-ai-vpn ]; then
            rm /usr/bin/antseed-ai-vpn
        fi
        if command -v update-mime-database >/dev/null 2>&1; then
            update-mime-database /usr/share/mime || true
        fi
        if command -v update-desktop-database >/dev/null 2>&1; then
            update-desktop-database /usr/share/applications || true
        fi
        ;;
esac
