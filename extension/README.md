# Bunni Download Manager — Chrome extension

Current extension version: **1.2.2**.

This original Manifest V3 extension sends HTTP and HTTPS links to the local Bunni desktop service on `127.0.0.1`. Port `17865` is the default.

## Install locally

1. Start the Bunni Download Manager desktop app.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select this `extension` folder.
5. Pin Bunni from Chrome’s Extensions menu if you want its button to stay visible.

After replacing an older unpacked copy, click **Reload** on Bunni’s `chrome://extensions` card. The toolbar badge shows **ON** when automatic capture is enabled and **OFF** when Chrome will keep downloads normally. The popup separately reports **Desktop app: CONNECTED/OFFLINE**, **Automatic capture: ON/OFF**, and **GoFile access: ON/OFF**.

No build step is required. The checked-in PNG icons can be regenerated with `node icons/generate-icons.js` from this folder.

## What it does

- Sends the current browser tab or a pasted URL from the toolbar popup.
- Adds right-click actions for links, pages, videos, audio, and images.
- Checks the local app with `GET /api/health`.
- Opens confirmations with `POST /api/captures` and polls `GET /api/captures/:id`.
- Adds `X-Bunni-Client: chrome-extension` to every service request.
- Lets you choose 1–32 parts in the extension options.
- Lets you set the local service port. It must match **Local server port** in the desktop app’s settings; the value is stored only on this computer.
- Intercepts new Chrome downloads by default on fresh installs, with a visible opt-out toggle in the popup. Existing saved on/off choices are preserved during upgrades. Bunni pauses Chrome, opens the desktop confirmation, and keeps the original paused while the choice is pending. **Start** and **Later** remove Chrome’s copy; **Cancel**, an error, an unavailable app, or a client timeout resumes it.
- Supports credential-protected GoFile downloads after the user explicitly chooses **Enable GoFile support** in extension Options.
- Detects an open GoFile tab when access is missing and offers a one-click, GoFile-only permission button. After permission is granted, return to the page and click its **Download** button again.

Automatic interception is deliberately conservative. The extension waits at most five minutes for a desktop choice and uses a persisted capture-to-Chrome mapping plus a Chrome alarm, so an MV3 worker restart can continue the decision. Temporary status failures use three persisted, backoff-delayed retries; if all fail, the extension best-effort rejects the desktop capture before restoring Chrome. A pre-capture restart, invalid response, rejected/error state, unavailable app, or timeout restores Chrome’s original. A persisted terminal acceptance finishes cancelling Chrome after a restart. Browser credentials are not copied for ordinary sites, and credentials are never stored in the recovery mapping.

Only `http://` and `https://` URLs are accepted. The extension always has host access only to HTTP ports on the `127.0.0.1` loopback address. It declares optional access only for `https://gofile.io/*` and `https://*.gofile.io/*`; Chrome grants that access only after the user clicks the button in Options. It never requests all-sites access.

## Optional GoFile support

GoFile’s browser downloads can depend on an account cookie that Chrome normally attaches to the download request. The downloads API does not expose that cookie in a `DownloadItem`, so Bunni cannot reproduce a protected GoFile request unless the user grants narrowly scoped access.

When GoFile support is enabled:

- GoFile capture requests use one connection instead of the general parts setting, avoiding HTTP 429 responses caused by concurrent range requests; other hosts keep the configured part count;
- the extension checks cookies matching the exact GoFile download URL;
- it requires a non-partitioned `accountToken` cookie before handing the download to the desktop app;
- it sends matching GoFile cookies as a `Cookie` request header only for a `gofile.io` hostname or subdomain;
- it does not include cookie values in notifications, logs, or responses to popup callers.

Incognito and partitioned-cookie handoffs fail closed. If permission or a usable GoFile account cookie is missing, Bunni resumes Chrome’s original download and tells the user how to enable support. The toolbar popup can request the same narrowly scoped GoFile permission directly; Options can also enable or remove it. Removing GoFile access immediately returns the extension to the no-cookie behavior.

## If clicking Download appears to do nothing

1. Click the Bunni toolbar icon and confirm **Automatic capture: ON**.
2. Confirm **Desktop app: CONNECTED**. If it says **OFFLINE**, open Bunni and click the connection card to retry.
3. On a GoFile tab, confirm **GoFile access: ON**. If it is OFF, use **Enable GoFile access**, approve Chrome’s GoFile-only prompt, then click the website’s **Download** button again.
4. The original Chrome download is briefly paused while the Bunni dialog is waiting. Choose **Start**, **Later**, or **Cancel** in the desktop app. If handoff fails, Bunni resumes Chrome’s copy instead of leaving it stranded.

## Desktop API contract

Health request:

```http
GET /api/health
X-Bunni-Client: chrome-extension
```

Capture request:

```http
POST /api/captures
X-Bunni-Client: chrome-extension
Content-Type: application/json
```

```json
{
  "url": "https://example.com/archive.zip",
  "segments": 8,
  "source": "popup-pasted-url",
  "referrer": "https://example.com/",
  "filename": "archive.zip"
}
```

`referrer` and `filename` are included only when available. Creation requires HTTP 202 and a response shaped like `{ "ok": true, "capture": { "id": "…", "state": "pending", "download": { … } } }`. The extension polls `GET /api/captures/:id`. `accepted` and `accepted-paused` cancel and erase Chrome’s copy; `rejected` and `error` resume it. On its five-minute timeout the extension best-effort calls `DELETE /api/captures/:id` before resuming Chrome. For non-credentialed errors, it displays `error`, `message`, or `detail` when present.

For a GoFile URL, and only after optional access is granted, the request may also contain `headers.Cookie`. That value is credential material: the desktop side must redact it from logs and responses and must not persist it as ordinary download metadata.

The desktop service accepts syntactically valid Chrome-extension origins and the custom `X-Bunni-Client` header, and it binds only to `127.0.0.1`. Because the browser assigns unpacked extensions a machine-specific origin, it does not hard-code one extension ID. The client header is a protocol marker, not a secret: other software already running on the same computer can call a loopback service, so the server must never be exposed on a LAN interface.
