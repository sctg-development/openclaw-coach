/** SVG to PNG with resvg and the bundled Inter font: output does not depend on the fonts of the host. */

import { fileURLToPath } from "node:url";
import path from "node:path";

export const RENDER_SCALE = 2;

const FONT_FILES = ["Inter_400Regular.ttf", "Inter_600SemiBold.ttf"].map((name) => fileURLToPath(new URL(`../../assets/fonts/${name}`, import.meta.url)));

export class ChartsUnavailableError extends Error {}

type ResvgModule = typeof import("@resvg/resvg-js");
let loaded: Promise<ResvgModule> | undefined;

function resvg(): Promise<ResvgModule> {
  loaded ??= import("@resvg/resvg-js").catch((error) => {
    loaded = undefined;
    throw new ChartsUnavailableError(`The PNG renderer (@resvg/resvg-js) is not installed for this platform: ${error instanceof Error ? error.message : "unknown error"}.`);
  });
  return loaded;
}

export async function renderPng(svg: string): Promise<{ png: Buffer; width: number; height: number }> {
  const { Resvg } = await resvg();
  const rendered = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Inter" },
    fitTo: { mode: "zoom", value: RENDER_SCALE },
    shapeRendering: 2,
    textRendering: 1,
  }).render();
  return { png: rendered.asPng(), width: rendered.width, height: rendered.height };
}

export const FONT_DIRECTORY = path.dirname(FONT_FILES[0]);
