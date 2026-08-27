#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly PACKAGING_DIR="${REPOSITORY_ROOT}/packaging/arch"
readonly RELEASE_DIR="${REPOSITORY_ROOT}/release"
readonly APP_DIR="${RELEASE_DIR}/linux-unpacked"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

require_file() {
  [[ -f "$1" ]] || die "required file not found: ${1#"${REPOSITORY_ROOT}/"}"
}

[[ "$(uname -s)" == "Linux" ]] || die "this package must be built on Linux"
[[ "$(uname -m)" == "x86_64" ]] || die "this package currently supports x86_64 only"
(( EUID != 0 )) || die "do not run this script as root; makepkg intentionally refuses root builds"

for command_name in awk bash cp id makepkg node npm npx tar uname; do
  require_command "${command_name}"
done

for input_file in \
  "${REPOSITORY_ROOT}/package.json" \
  "${REPOSITORY_ROOT}/package-lock.json" \
  "${REPOSITORY_ROOT}/tsconfig.json" \
  "${REPOSITORY_ROOT}/extension/manifest.json" \
  "${PACKAGING_DIR}/PKGBUILD" \
  "${PACKAGING_DIR}/prepare-prebuilt.sh"; do
  require_file "${input_file}"
done

cd -- "${REPOSITORY_ROOT}"

readonly NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || die "could not determine the Node.js major version"
(( NODE_MAJOR >= 20 )) || die "Node.js 20 or newer is required (found $(node --version))"

readonly APP_VERSION="$(node -p 'require("./package.json").version')"
readonly PKGBUILD_VERSION="$(
  awk -F= '$1 == "pkgver" { print $2; exit }' \
    "${PACKAGING_DIR}/PKGBUILD"
)"
[[ "${PKGBUILD_VERSION}" =~ ^[0-9]+([.][0-9]+)*$ ]] || \
  die "could not read a canonical numeric pkgver from packaging/arch/PKGBUILD"
[[ "${APP_VERSION}" == "${PKGBUILD_VERSION}" ]] || \
  die "version mismatch: package.json is ${APP_VERSION}, but PKGBUILD is ${PKGBUILD_VERSION}"

printf 'Installing locked Node.js dependencies...\n'
npm ci

printf 'Compiling the application...\n'
npm run build

printf 'Packaging the Linux x64 application directory...\n'
npx --no-install electron-builder --linux dir --x64

require_file "${APP_DIR}/bunni-download-manager"
require_file "${APP_DIR}/resources/extension/manifest.json"
[[ -x "${APP_DIR}/bunni-download-manager" ]] || \
  die "the packaged application is not executable: release/linux-unpacked/bunni-download-manager"

printf 'Preparing the PKGBUILD source archive...\n'
bash "${PACKAGING_DIR}/prepare-prebuilt.sh" "${APP_DIR}"

printf 'Building the pacman package as user %s...\n' "$(id -un)"
mapfile -t expected_packages < <(
  cd -- "${PACKAGING_DIR}"
  makepkg --packagelist
)
(( ${#expected_packages[@]} > 0 )) || die "makepkg did not report an output package"

(
  cd -- "${PACKAGING_DIR}"
  makepkg -Ccf --noconfirm
)

mkdir -p -- "${RELEASE_DIR}"
for package_path in "${expected_packages[@]}"; do
  if [[ "${package_path}" != /* ]]; then
    package_path="${PACKAGING_DIR}/${package_path}"
  fi
  [[ -f "${package_path}" ]] || die "makepkg output not found: ${package_path}"
  destination="${RELEASE_DIR}/$(basename -- "${package_path}")"
  if [[ "${package_path}" != "${destination}" ]]; then
    cp -f -- "${package_path}" "${destination}"
  fi
  printf 'Created %s\n' "${destination}"
done
