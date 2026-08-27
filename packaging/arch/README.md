# Arch Linux / CachyOS package

This directory packages the prebuilt x86-64 Electron application. It does not
compile Electron or JavaScript dependencies inside `makepkg`, and it does not
silently install or force-enable a browser extension.

## Build input

`PKGBUILD` expects this local archive beside it:

```text
bunni-download-manager-0.2.2-linux-x64.tar.gz
```

Create it from Electron Builder's unpacked Linux output:

```bash
bash packaging/arch/prepare-prebuilt.sh release/linux-unpacked
```

The helper also accepts a directory containing `linux-unpacked`, or a tarball
whose application is at its root or under one top-level directory. It verifies
that these required files exist:

```text
bunni-download-manager
resources/extension/manifest.json
```

The executable name is an intentional package contract. If Electron Builder
produces another name, set its Linux `executableName` to
`bunni-download-manager` before creating the prebuilt.

The helper verifies that the main binary is an x86-64 ELF file and stages a
copy without modifying the original directory. The recipe restores the known
Electron executable bits after extraction, so input copied through an NTFS
volume can still be packaged safely.

## Build and install on CachyOS / Arch

Install the standard packaging tools once:

```bash
sudo pacman -S --needed base-devel
```

Build as a regular user (never run `makepkg` as root):

```bash
cd packaging/arch
makepkg -sfc
```

Install the resulting package:

```bash
sudo pacman -U ./bunni-download-manager-0.2.2-1-x86_64.pkg.tar.zst
```

The package installs:

- the application at `/opt/bunni-download-manager`;
- `/usr/bin/bunni-download-manager` as a symlink to its executable;
- a desktop entry and scalable icon;
- its MIT license;
- the unpacked extension at
  `/usr/share/bunni-download-manager/extension`; and
- `bunni-extension-folder`, a convenience helper.

## Load the extension manually

Run:

```bash
bunni-extension-folder --chrome
```

The helper prints and opens the extension directory, then opens
`chrome://extensions` in the first supported installed Chromium-family
browser it finds. In the browser:

1. Enable **Developer mode**.
2. Click **Load unpacked**.
3. Select `/usr/share/bunni-download-manager/extension`.

Use `bunni-extension-folder --print-only` when you only want the path. The
package never writes Chrome enterprise policy, browser profiles, or extension
registries. After upgrading the package, click **Reload** for Bunni on
`chrome://extensions`.

Authenticated browser handoffs (including GoFile sessions) fail closed unless
Electron can use a secure Linux credential backend. Most full desktop installs
already provide one. Otherwise, install and configure `gnome-keyring` or
KWallet, then log out and back in so its user service is available.

## Packaging and security notes

- The prebuilt input checksum is `SKIP` because it is a locally generated
  artifact. Publish the exact prebuilt tarball and its SHA-256 alongside a
  release package, and replace `SKIP` with that digest for a reproducible
  public release recipe.
- `options=('!strip')` preserves Electron's already-built binaries and fuses.
- The bundled `chrome-sandbox` is deliberately **not** made setuid-root from a
  locally generated, checksum-skipped input. Bunni relies on the unprivileged
  user-namespace sandbox enabled by standard Arch and CachyOS kernels. On a
  heavily hardened kernel where user namespaces were disabled, restore that
  kernel capability instead of launching Bunni with `--no-sandbox`.
- The package does not remove user downloads or settings on uninstall.
- This recipe assumes the prebuilt was created from this same Bunni 0.2.2
  source tree and already contains all Electron runtime files.
