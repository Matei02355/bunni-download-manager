# Bunni Download Manager

Bunni is an original Windows download manager with a desktop queue, resumable transfers, parallel HTTP range segments, and a Chrome extension. It is inspired by the workflow of familiar download managers, but it does not contain Internet Download Manager code, branding, or assets.

## What works

- Parallel segmented downloads when a server advertises byte-range support
- Automatic fallback to one connection for servers that do not support ranges
- Pause, resume, cancel, retry, remove, and open-file/open-folder actions
- Persistent queue and partial segment files, so interrupted downloads can continue after restarting the app
- Collision-safe filenames and `Content-Disposition` filename detection
- Chrome toolbar, context-menu, and optional browser-download interception
- Browser-click confirmation dialog with URL, category, filename, folder, and size before transfer
- Explicit, optional GoFile session access for links that require browser cookies
- Rejection of login/error HTML pages masquerading as archives or installers
- GoFile single-connection mode with automatic HTTP 429 backoff
- Destination-drive partial storage and verified migration of older partial files
- A localhost-only extension bridge with origin checks and no cloud service
- Configurable segment count, simultaneous downloads, output folder, notifications, and bridge port
- Windows NSIS installer packaging

Parallel connections can improve throughput when a server throttles individual connections. They cannot exceed your internet connection, the source server's total limit, or disk performance.

## Run from source

Requirements: Windows 10/11 and Node.js 20 or newer.

```powershell
npm install
npm start
```

The first run uses your normal Downloads folder. Incomplete data and queue metadata are kept under Electron's per-user application-data directory.

## Install the Chrome extension

1. Start Bunni Download Manager.
2. Open Settings and choose **Open Chrome extension folder**.
3. In Chrome, visit `chrome://extensions` and enable **Developer mode**.
4. Choose **Load unpacked**, then select the folder Bunni opened.
5. Pin the Bunni extension if you want quick access from the toolbar.
6. Open the extension popup and turn on **Catch website downloads**. A browser download now pauses in Chrome and opens Bunni's **Download information** dialog; choose **Start download**, **Later**, or **Cancel**.

For a GoFile download that depends on your browser session, open the extension's settings and choose **Enable GoFile session access**. Chrome shows the permission request and Bunni reads GoFile cookies only after you approve it. Cookie and authorization values are never stored in plaintext; Windows protects the resumable session data with its encrypted credential storage.

Chrome does not allow ordinary desktop installers to silently install unpacked extensions. Production distribution should publish the extension in the Chrome Web Store; Bunni deliberately does not change Chrome enterprise policies or registry force-install settings.

## Build the Windows installer

```powershell
npm install
npm test
npm run typecheck
npm run dist
```

The installer is written to `release/Bunni-Download-Manager-Setup-0.2.2.exe`. The installed app includes the extension folder and registers the `bunni://` URL scheme.

## CachyOS / Arch Linux

The repository includes a native `pacman` recipe and a prepared Linux x86-64 application archive. On CachyOS or Arch, build and install it as your normal user:

```bash
sudo pacman -S --needed base-devel
cd packaging/arch
makepkg -si
```

After installation, load the extension manually:

```bash
bunni-extension-folder --chrome
```

Enable Developer mode, choose **Load unpacked**, and select `/usr/share/bunni-download-manager/extension`. See [docs/CACHYOS.md](docs/CACHYOS.md) for package build, update, removal, and KWallet/libsecret instructions. The package never writes browser policy or silently enables the extension.

## Extension bridge

The desktop app listens only on `127.0.0.1:17865` by default. Requests from web pages are rejected; Chrome-extension origins must use the Bunni client header. You can change the port in both the desktop settings and extension options.

## Troubleshooting protected links

Some download links work only in the browser session that created them. If a server redirects an archive link to a login or HTML page, Bunni now rejects that response instead of creating a tiny fake archive. Without permission to reuse the required session, the Chrome extension leaves or resumes the original Chrome download.

For a failed link that says it returned a web page or requires a browser session, use **Open in Chrome** instead of **Retry**. Chrome recreates the request with its browser session and the Bunni extension can capture it again.

GoFile support is deliberately opt-in. Bunni requests access only to `gofile.io` and its subdomains, not every website. If the GoFile content has expired, was removed, or is unavailable on its server, neither Bunni nor Chrome can restore it.

GoFile transfers use one connection at a time because the service can return HTTP 429 when several ranges run concurrently. Bunni waits and retries rate limits automatically. Part files are stored in a hidden `.bunni-parts` folder on the selected destination drive; older partials are copied, size-verified, and removed from the legacy location only after migration succeeds.

## Responsible use

Only download files you are entitled to access. Bunni does not bypass authentication, digital rights management, paywalls, server limits, or network policy.
