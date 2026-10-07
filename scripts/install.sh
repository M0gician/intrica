#!/usr/bin/env bash
set -euo pipefail

# The release tag is explicit so the installer and its packages stay together.
release=${1:?Usage: bash install.sh vX.Y.Z}
version=${release#v}
if [[ ! "$release" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo 'Expected a pinned stable release tag.' >&2
  exit 1
fi
command -v curl >/dev/null || { echo 'Required command: curl' >&2; exit 1; }
download_public() {
  local name=$1 destination=$2 url="https://github.com/M0gician/intrica/releases/download/$release/$1" next hop
  for hop in 0 1 2 3; do
    next=$(curl -q --fail --show-error --progress-bar --proto '=https' \
      --connect-timeout 15 --max-time 900 --max-filesize 2147483648 \
      --output "$destination" --write-out '%{redirect_url}' "$url") || return
    if [[ -z "$next" ]]; then return 0; fi
    case "$next" in
      "https://github.com/M0gician/intrica/releases/download/$release/$name"|https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*) url=$next ;;
      *) echo 'Untrusted release redirect.' >&2; return 1 ;;
    esac
  done
  echo 'Too many release redirects.' >&2
  return 1
}


case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    platform=mac
    asset="Intrica-${version}-mac-arm64.zip"
    if pgrep -f '/Intrica.app/Contents/MacOS/Intrica' >/dev/null; then
      echo 'Quit Intrica before installing, then run this command again.' >&2
      exit 1
    fi
    ;;
  Linux-x86_64)
    if command -v apt-get >/dev/null && command -v dpkg >/dev/null; then
      platform=deb
      asset="Intrica-${version}-linux-amd64.deb"
    else
      platform=appimage
      asset="Intrica-${version}-linux-x86_64.AppImage"
    fi
    ;;
  *) echo 'Supported platforms: macOS Apple Silicon and Linux x64.' >&2; exit 1 ;;
esac

temporary=$(mktemp -d)
stage=
destination=/Applications/Intrica.app
needs_sudo=0
run_install() {
  if [[ "$needs_sudo" == 1 ]]; then sudo "$@"; else "$@"; fi
}
cleanup() {
  status=$?
  if [[ -n "$stage" && -e "$stage/previous.app" && ! -e "$destination" ]]; then
    if ! run_install mv "$stage/previous.app" "$destination"; then
      echo "Previous app preserved at $stage/previous.app" >&2
      stage=
    fi
  fi
  if [[ -n "$stage" ]]; then run_install rm -rf "$stage"; fi
  rm -rf "$temporary"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "[1/4] Downloading Intrica $release ($platform)…"
download_public SHA256SUMS "$temporary/SHA256SUMS"
download_public "$asset" "$temporary/$asset"
echo '[2/4] Verifying package checksum…'
expected=$(awk -v name="./$asset" '$2 == name { print $1 }' "$temporary/SHA256SUMS")
if command -v sha256sum >/dev/null; then
  actual=$(sha256sum "$temporary/$asset" | awk '{ print $1 }')
else
  actual=$(shasum -a 256 "$temporary/$asset" | awk '{ print $1 }')
fi
if [[ ! "$expected" =~ ^[a-f0-9]{64}$ || "$actual" != "$expected" ]]; then
  echo 'Download checksum mismatch; nothing was installed.' >&2
  exit 1
fi

echo '[3/4] Installing Intrica…'
case "$platform" in
  mac)
    ditto -x -k "$temporary/$asset" "$temporary/unpacked"
    codesign --verify --deep --strict "$temporary/unpacked/Intrica.app"
    if [[ ! -w /Applications ]]; then needs_sudo=1; fi
    stage=$(run_install mktemp -d /Applications/.intrica-install.XXXXXX)
    run_install ditto "$temporary/unpacked/Intrica.app" "$stage/Intrica.app"
    if [[ -e "$destination" ]]; then
      run_install mv "$destination" "$stage/previous.app"
    fi
    run_install mv "$stage/Intrica.app" "$destination"
    echo '[4/4] Installed /Applications/Intrica.app. Open Intrica from Applications.'
    echo 'If macOS blocks the first launch: System Settings → Privacy & Security → Open Anyway.'
    ;;
  deb)
    if [[ $(id -u) != 0 ]]; then needs_sudo=1; fi
    chmod 755 "$temporary"
    run_install apt-get install -y --reinstall "$temporary/$asset"
    echo '[4/4] Installed Intrica. Open it from your application menu or run: intrica'
    ;;
  appimage)
    mkdir -p "$HOME/.local/bin"
    # Rename on the destination filesystem so replacement is atomic.
    stage=$(mktemp -d "$HOME/.local/bin/.intrica-install.XXXXXX")
    install -m 755 "$temporary/$asset" "$stage/intrica"
    mv "$stage/intrica" "$HOME/.local/bin/intrica"
    echo "[4/4] Installed $HOME/.local/bin/intrica. Run it to open Intrica."
    echo 'Without FUSE 2, launch with: APPIMAGE_EXTRACT_AND_RUN=1 ~/.local/bin/intrica'
    ;;
esac
