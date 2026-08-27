# CachyOS and Arch Linux

Bunni can be built as a native `pacman` package on x86_64 CachyOS or Arch Linux. The desktop application is installed by `pacman`; its Chrome/Chromium extension is then loaded manually from the installed, read-only application files.

## Install the published package

```bash
curl -fL --retry 5 -o bunni-download-manager-0.2.2-1-x86_64.pkg.tar.zst https://github.com/Matei02355/bunni-download-manager/releases/download/v0.2.2/bunni-download-manager-0.2.2-1-x86_64.pkg.tar.zst
echo 'd485d05299aee17eb10ab570a18fc466d4e6a0d7f59895fcc0c7795dc8cdf657  bunni-download-manager-0.2.2-1-x86_64.pkg.tar.zst' | sha256sum -c -
sudo pacman -U ./bunni-download-manager-0.2.2-1-x86_64.pkg.tar.zst
```

Then run `bunni-extension-folder --chrome` and manually load `/usr/share/bunni-download-manager/extension` from `chrome://extensions`.

This repository provides the Linux build recipe and CI job. A Linux package has not been built or validated by the Windows checkout that created these files; run the build on CachyOS/Arch or use the Linux CI artifact.

## Build the package

Install the standard Arch build tools and Bunni's build dependencies:

```bash
sudo pacman -Syu --needed base-devel git libsecret nodejs npm python
```

From the repository root, build as your normal user. Do not use `sudo` for this command because `makepkg` refuses to run as root:

```bash
bash scripts/build-arch-package.sh
```

The script uses `npm ci` and the committed lockfile, compiles Bunni, creates Electron's Linux x64 application directory, prepares the PKGBUILD source archive, and runs `makepkg`. For version 0.2.2, the installable result is:

```text
release/bunni-download-manager-0.2.2-1-x86_64.pkg.tar.zst
```

## Install, update, or remove Bunni

Install the package:

```bash
sudo pacman -U ./release/bunni-download-manager-0.2.2-1-x86_64.pkg.tar.zst
```

Launch **Bunni Download Manager** from the desktop application menu, or run:

```bash
bunni-download-manager
```

To update, build or download the newer package and pass its exact filename to the same command. Reinstalling the current 0.2.2 package uses:

```bash
sudo pacman -U ./release/bunni-download-manager-0.2.2-1-x86_64.pkg.tar.zst
```

Confirm the installed version:

```bash
pacman -Q bunni-download-manager
```

Remove Bunni and dependencies that are no longer required by another installed package:

```bash
sudo pacman -Rns bunni-download-manager
```

## Load the extension manually

The package installs the unpacked extension here:

```text
/usr/share/bunni-download-manager/extension
```

For either Google Chrome or Chromium:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `/usr/share/bunni-download-manager/extension`.
5. Pin Bunni from the browser's Extensions menu, open it, and confirm that the desktop app is connected.

After a Bunni package update, return to `chrome://extensions` and select **Reload** on the Bunni extension. Browser profiles are per-user, so repeat the manual load for each profile that should use Bunni.

## Secure browser-session storage

Bunni never falls back to plaintext storage for cookies or other resumable browser credentials. Run Bunni from your logged-in desktop session, not with `sudo`, and make sure one supported credential store is installed, running, and unlocked:

- On KDE Plasma, use an available KWallet service (normally the Arch `kwallet` package).
- On desktops using Secret Service, install `libsecret` and a provider such as `gnome-keyring`, then unlock that keyring when you log in.

For example, install the commonly used KDE or GNOME components with one of these commands:

```bash
sudo pacman -S --needed kwallet
```

```bash
sudo pacman -S --needed libsecret gnome-keyring
```

Ordinary public downloads still work when no secure backend is available. Browser-session or cookie-based handoffs that must be saved will stop with `Operating-system credential encryption is unavailable` until KWallet or Secret Service is available and unlocked.
