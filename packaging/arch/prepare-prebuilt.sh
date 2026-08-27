#!/usr/bin/bash
set -euo pipefail

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly package_version='0.2.2'
readonly default_output="${script_dir}/bunni-download-manager-${package_version}-linux-x64.tar.gz"

usage() {
  cat <<EOF
Usage: $(basename "$0") INPUT [OUTPUT]

Normalize a prebuilt Electron Builder Linux app into the archive expected by
PKGBUILD. INPUT may be:
  - the release/linux-unpacked directory;
  - a directory containing linux-unpacked; or
  - a .tar, .tar.gz, .tgz, .tar.xz, or .tar.zst archive containing either.

OUTPUT defaults to:
  ${default_output}
EOF
}

if (( $# < 1 || $# > 2 )); then
  usage >&2
  exit 2
fi

input="$1"
output="${2:-${default_output}}"

[[ -e "${input}" ]] || {
  printf 'prepare-prebuilt: input does not exist: %s\n' "${input}" >&2
  exit 1
}

command -v tar >/dev/null 2>&1 || {
  printf 'prepare-prebuilt: GNU tar is required.\n' >&2
  exit 1
}
command -v gzip >/dev/null 2>&1 || {
  printf 'prepare-prebuilt: gzip is required.\n' >&2
  exit 1
}

work_dir="$(mktemp -d -t bunni-arch-package.XXXXXXXX)"
output_dir="$(dirname -- "${output}")"
install -d "${output_dir}"
temporary_output=''

cleanup() {
  rm -rf -- "${work_dir}"
  if [[ -n "${temporary_output}" ]]; then
    rm -f -- "${temporary_output}"
  fi
}
trap cleanup EXIT INT TERM HUP

find_app_root() {
  local search_root="$1"
  local candidate
  local -a candidates=()

  if [[ -f "${search_root}/bunni-download-manager" ]]; then
    printf '%s\n' "${search_root}"
    return 0
  fi

  if [[ -f "${search_root}/linux-unpacked/bunni-download-manager" ]]; then
    printf '%s\n' "${search_root}/linux-unpacked"
    return 0
  fi

  while IFS= read -r -d '' candidate; do
    candidates+=("$(dirname -- "${candidate}")")
  done < <(find "${search_root}" -mindepth 2 -maxdepth 3 -type f \
    -name bunni-download-manager -print0)

  if (( ${#candidates[@]} == 1 )); then
    printf '%s\n' "${candidates[0]}"
    return 0
  fi

  printf 'prepare-prebuilt: expected exactly one executable named bunni-download-manager; found %d.\n' \
    "${#candidates[@]}" >&2
  return 1
}

validate_symlinks() {
  local root="$1"
  local link link_target resolved

  while IFS= read -r -d '' link; do
    link_target="$(readlink -- "${link}")"
    if [[ "${link_target}" == /* ]]; then
      printf 'prepare-prebuilt: refusing absolute symlink: %s -> %s\n' \
        "${link}" "${link_target}" >&2
      return 1
    fi
    resolved="$(realpath -m -- "$(dirname -- "${link}")/${link_target}")"
    case "${resolved}" in
      "${root}"|"${root}"/*) ;;
      *)
        printf 'prepare-prebuilt: refusing symlink outside app root: %s -> %s\n' \
          "${link}" "${link_target}" >&2
        return 1
        ;;
    esac
  done < <(find "${root}" -type l -print0)
}

if [[ -d "${input}" ]]; then
  app_root="$(find_app_root "$(cd -- "${input}" && pwd -P)")"
else
  command -v bsdtar >/dev/null 2>&1 || {
    printf 'prepare-prebuilt: bsdtar is required when INPUT is an archive.\n' >&2
    exit 1
  }

  while IFS= read -r member; do
    if [[ "${member}" == /* || "${member}" =~ (^|/)\.\.(/|$) ]]; then
      printf 'prepare-prebuilt: unsafe archive member: %s\n' "${member}" >&2
      exit 1
    fi
  done < <(bsdtar -tf "${input}")

  install -d "${work_dir}/input"
  bsdtar -xf "${input}" -C "${work_dir}/input"
  app_root="$(find_app_root "${work_dir}/input")"
fi

[[ -f "${app_root}/resources/extension/manifest.json" ]] || {
  printf 'prepare-prebuilt: missing resources/extension/manifest.json under %s\n' "${app_root}" >&2
  exit 1
}

validate_symlinks "${app_root}"

elf_magic="$(od -An -tx1 -N4 "${app_root}/bunni-download-manager" | tr -d '[:space:]')"
elf_machine="$(od -An -tx1 -j18 -N2 "${app_root}/bunni-download-manager" | tr -d '[:space:]')"
if [[ "${elf_magic}" != '7f454c46' || "${elf_machine}" != '3e00' ]]; then
  printf 'prepare-prebuilt: bunni-download-manager is not an x86-64 ELF executable.\n' >&2
  exit 1
fi

# Stage a normalized copy instead of changing Electron Builder's output. This
# also restores executable bits when a Linux prebuilt was copied through NTFS.
stage_root="${work_dir}/staged"
install -d "${stage_root}"
cp -a -- "${app_root}/." "${stage_root}/"
chmod -R u=rwX,go=rX "${stage_root}"
chmod 0755 "${stage_root}/bunni-download-manager"
[[ ! -f "${stage_root}/chrome_crashpad_handler" ]] || \
  chmod 0755 "${stage_root}/chrome_crashpad_handler"
[[ ! -f "${stage_root}/chrome-sandbox" ]] || \
  chmod 0755 "${stage_root}/chrome-sandbox"

source_date_epoch="${SOURCE_DATE_EPOCH:-0}"
[[ "${source_date_epoch}" =~ ^[0-9]+$ ]] || {
  printf 'prepare-prebuilt: SOURCE_DATE_EPOCH must be a non-negative integer.\n' >&2
  exit 1
}

# Normalize timestamps and ownership so identical input trees produce an
# identical gzip archive. gzip -n omits its own timestamp and original name.
temporary_output="$(mktemp "${output}.tmp.XXXXXXXX")"
tar --sort=name \
  --mtime="@${source_date_epoch}" \
  --owner=0 --group=0 --numeric-owner \
  -C "${stage_root}" -cf - . | gzip -n -9 > "${temporary_output}"

chmod 0644 "${temporary_output}"
mv -f -- "${temporary_output}" "${output}"

printf 'Prepared %s\n' "${output}"
printf 'SHA-256: '
sha256sum "${output}" | awk '{print $1}'
