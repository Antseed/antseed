#!/bin/sh
set -eu

case "$1" in
    install|upgrade)
        previous_postrm=/var/lib/dpkg/info/antseed-ai-vpn.postrm
        if [ -f "$previous_postrm" ]; then
            sed -i "s|update-alternatives --remove 'AntSeed VPR' '/usr/bin/AntSeed VPR'|rm -f '/usr/bin/AntSeed VPR'|" "$previous_postrm"
        fi
        ;;
esac
