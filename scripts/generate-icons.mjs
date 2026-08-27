import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const projectRoot = new URL("../", import.meta.url);
const source = new URL("assets/bunni-logo.svg", projectRoot);
const buildDirectory = new URL("build/", projectRoot);
const appPng = new URL("assets/bunni-logo.png", projectRoot);
const buildPng = new URL("build/icon.png", projectRoot);
const buildIco = new URL("build/icon.ico", projectRoot);

await mkdir(buildDirectory, { recursive: true });
const svg = await readFile(source);
const png = await sharp(svg).resize(512, 512).png().toBuffer();
await Promise.all([writeFile(appPng, png), writeFile(buildPng, png)]);
// Passing one PNG (rather than an array) lets png-to-ico generate the standard
// 256, 48, 32, and 16 pixel entries expected by Windows shell and NSIS.
await writeFile(buildIco, await pngToIco(png));
