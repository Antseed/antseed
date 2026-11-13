#!/bin/sh
set -eu

case "$1" in
    install|upgrade)
        # The package was called antseed-ai-vpn before the Antseed Desktop
        # rename; dpkg removes it (Conflicts + Replaces) and runs its postrm,
        # so repair that script whichever name it was installed under.
        # electron-updater relaunches the running binary's path after `dpkg -i`;
        # remember to keep the old one working so the first update reopens.
        if [ -x /opt/antseed-ai-vpn/antseed-ai-vpn ] && [ ! -L /opt/antseed-ai-vpn/antseed-ai-vpn ]; then
            mkdir -p /var/lib/antseed-desktop
            touch /var/lib/antseed-desktop/relaunch-from-antseed-ai-vpn
        fi
        for previous_postrm in /var/lib/dpkg/info/antseed-ai-vpn.postrm /var/lib/dpkg/info/antseed-desktop.postrm; do
            if [ -f "$previous_postrm" ]; then
                sed -i "s|update-alternatives --remove 'AntSeed VPR' '/usr/bin/AntSeed VPR'|rm -f '/usr/bin/AntSeed VPR'|" "$previous_postrm"
            fi
        done
        ;;
esac
