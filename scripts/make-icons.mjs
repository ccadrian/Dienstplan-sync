// Rendert die PNG-Icons aus web/icons/icon.svg (benötigt Playwright/Chromium).
import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../web/icons/", import.meta.url));
const svg = await readFile(`${dir}icon.svg`, "utf8");
const browser = await chromium.launch(
  process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
);
const page = await browser.newPage();

async function render(file, size, { maskable = false, padRatio = 0 } = {}) {
  await page.setViewportSize({ width: size, height: size });
  const inner = Math.round(size * (1 - padRatio * 2));
  // Maskable: vollflächiger Hintergrund, Motiv in der sicheren Zone (80 %)
  const icon = maskable ? svg.replace(/<rect width="512" height="512" rx="112"/, '<rect width="512" height="512"') : svg;
  await page.setContent(
    `<html><body style="margin:0;background:${maskable ? "#0b0d10" : "transparent"};display:grid;place-items:center;width:${size}px;height:${size}px">
      <div style="width:${inner}px;height:${inner}px">${icon.replace("<svg ", `<svg width="${inner}" height="${inner}" `)}</div>
    </body></html>`,
  );
  await page.screenshot({ path: `${dir}${file}`, omitBackground: !maskable });
  console.log("geschrieben:", file);
}

await render("icon-192.png", 192);
await render("icon-512.png", 512);
await render("maskable-512.png", 512, { maskable: true, padRatio: 0.1 });
await render("apple-touch-icon.png", 180, { maskable: true });
await browser.close();
