/**
 * Browser export helpers built on top of the shared sketchEngine (also served to the iPad).
 */
import type { PaperStyle, SketchPage } from "./api";
import { renderPageToCanvas } from "./sketchEngine.js";

export { SHEET_H, SHEET_W, applySketchOp, drawPaper, drawStroke, renderInkToCanvas, renderPageToCanvas, strokeHitsSegment } from "./sketchEngine.js";

export function renderPageToDataUrl(page: SketchPage, paper: PaperStyle, scale = 1): string {
  const c = document.createElement("canvas");
  renderPageToCanvas(c, page, paper, scale);
  const url = c.toDataURL("image/png");
  c.width = 0;
  c.height = 0;
  return url;
}

export function renderPageToBlob(page: SketchPage, paper: PaperStyle, scale = 1): Promise<Blob> {
  const c = document.createElement("canvas");
  renderPageToCanvas(c, page, paper, scale);
  return new Promise<Blob>((resolve, reject) => {
    c.toBlob((blob) => {
      c.width = 0;
      c.height = 0;
      if (blob) resolve(blob);
      else reject(new Error("Could not render scratchpad image."));
    }, "image/png");
  });
}
