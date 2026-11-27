import type { PaperStyle, Sketch, SketchOp, SketchPage, Stroke } from "./api";

export declare const SHEET_W: 1200;
export declare const SHEET_H: 1600;

export declare function drawPaper(ctx: CanvasRenderingContext2D, paper: PaperStyle, w?: number, h?: number): void;
export declare function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke): void;
export declare function renderInkToCanvas(canvas: HTMLCanvasElement, strokes: Stroke[], activeStroke?: Stroke | null): void;
export declare function renderPageToCanvas(canvas: HTMLCanvasElement, page: SketchPage, paper: PaperStyle, scale?: number): void;
export declare function strokeHitsSegment(stroke: Stroke, x1: number, y1: number, x2: number, y2: number, radius: number): boolean;
export declare function applySketchOp(sketch: Sketch, op: SketchOp): Sketch;
