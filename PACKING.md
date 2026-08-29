# Packing the Bunni Chrome extension

## Local development installation

Chrome normally blocks locally distributed CRX files. For local use, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select:

```text
<Bunni installation directory>\resources\extension
```

## Pack with Chrome's dialog

For the first package, select the extension root shown above and leave **Private key file** empty. Chrome creates a `.crx` package and a `.pem` private key.

For every later package, select the same extension root and reuse:

```text
private\Bunni-Extension.pem
```

Reusing this key preserves the extension ID and update identity. Never publish, email, or include the PEM file with the extension.

## Generated artifacts

- `release\Bunni-Extension-1.2.3.crx` — Chrome CRX3 package
- `release\Bunni-Extension-1.2.3.zip` — ZIP package for inspection or Chrome Web Store upload
- `private\Bunni-Extension.pem` — private update key; keep secret and backed up

Packed extension ID: `phdgcjnonmnoblhcdpjmebhkgceklgkc`
