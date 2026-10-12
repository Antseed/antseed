#!/bin/bash
set -Eeuo pipefail

if [ "$(id -u)" != 0 ] || [ ! -f /.dockerenv ]; then
    echo 'Run this destructive package-lifecycle test as root in a disposable Docker container.' >&2
    exit 2
fi

trap 'printf "FAIL at line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR

fixed_package="${1:?Provide the fixed .deb}"
legacy_package="${2:-}"
package_name=antseed-ai-vpn
desktop_entry=/usr/share/applications/antseed-ai-vpn.desktop
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT

expect_failure() {
    if "$@"; then
        echo "Expected failure: $*" >&2
        exit 1
    fi
}

assert_installed() {
    test "$(dpkg-query -W '-f=${Status}' "$package_name")" = 'install ok installed'
    test "$(stat -c '%U:%G %a' /opt/antseed-ai-vpn/chrome-sandbox)" = 'root:root 4755'
    test "$(readlink /usr/bin/antseed-ai-vpn)" = /opt/antseed-ai-vpn/antseed-ai-vpn
    test -x /usr/bin/antseed-ai-vpn
    test ! -e '/opt/Antseed AI VPN'
    test ! -L '/usr/bin/AntSeed VPR'
    test ! -e '/usr/share/applications/AntSeed VPR.desktop'
    desktop-file-validate "$desktop_entry"
    grep -Fx 'Name=Antseed AI VPN' "$desktop_entry"
    grep -Fx 'Icon=antseed-ai-vpn' "$desktop_entry"
    grep -Fx 'Exec=/opt/antseed-ai-vpn/antseed-ai-vpn %U' "$desktop_entry"
    gtk-update-icon-cache --force /usr/share/icons/hicolor
    apt-get check
    test -z "$(dpkg --audit)"
}

assert_removed() {
    dpkg --purge "$package_name"
    test ! -e /opt/antseed-ai-vpn
    test ! -L /usr/bin/antseed-ai-vpn
    test ! -e "$desktop_entry"
    apt-get check
    test -z "$(dpkg --audit)"
}

test "$(dpkg-deb -f "$fixed_package" Package)" = "$package_name"
dpkg-deb -x "$fixed_package" "$test_root/archive"
test "$(stat -c '%U:%G %a' "$test_root/archive/opt/antseed-ai-vpn/chrome-sandbox")" = 'root:root 4755'

echo 'TEST fresh install, same-version upgrade, removal, purge'
dpkg -i "$fixed_package"
assert_installed
dpkg -i "$fixed_package"
assert_installed
dpkg --remove "$package_name"
assert_removed

if [ -n "$legacy_package" ]; then
    echo 'TEST upgrade from installed legacy package'
    dpkg -i "$legacy_package"
    dpkg -i "$fixed_package"
    assert_installed
    assert_removed

    echo 'TEST recovery from failed legacy removal'
    dpkg -i "$legacy_package"
    expect_failure dpkg --remove "$package_name"
    expect_failure apt-get -y -f install
    dpkg -i "$fixed_package"
    assert_installed
    assert_removed

    echo 'TEST recovery from legacy reinstreq state'
    dpkg -i "$legacy_package"
    expect_failure dpkg --remove "$package_name"
    expect_failure dpkg -i "$legacy_package"
    test "$(dpkg-query -W '-f=${Status}' "$package_name")" = 'install reinstreq half-installed'
    expect_failure apt-get check
    dpkg -i "$fixed_package"
    assert_installed
    assert_removed
fi

echo 'TEST removal preserves a launcher replaced by the administrator'
dpkg -i "$fixed_package"
ln -sfn /bin/true /usr/bin/antseed-ai-vpn
dpkg --purge "$package_name"
test "$(readlink /usr/bin/antseed-ai-vpn)" = /bin/true
rm /usr/bin/antseed-ai-vpn
apt-get check
test -z "$(dpkg --audit)"
echo 'PASS: Linux Debian packaging lifecycle'
