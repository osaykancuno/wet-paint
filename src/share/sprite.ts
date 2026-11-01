// A walking sprite of the people of the wall (Sprite Party, mirrored by the card service: people.json): a PNG of
// 192 × 192, a 4 × 4 grid of 48 × 48 frames, one row per direction, four steps of 130 ms. Pure drawing on a canvas:
// the games draw it live, the cards (src/share/card-draw.ts) draw one frame of it, in the browser and on the server.
export const FRAME = 48, STEPS = 4, STEP_MS = 130;
export const DIR = { UP: 0, RIGHT: 1, DOWN: 2, LEFT: 3 } as const;
export type SpriteSheet = CanvasImageSource & { width: number; height: number };

/** The step to show at time `ms` (performance.now() or any clock). */
export const stepAt = (ms: number): number => Math.floor(ms / STEP_MS) % STEPS;

/** One frame of `sheet`, `size` px square, its top-left at (x, y), pixels kept sharp. */
export function drawSprite(g: CanvasRenderingContext2D, sheet: SpriteSheet, x: number, y: number, size: number, step = 0, dir: number = DIR.DOWN): void {
  const smooth = g.imageSmoothingEnabled;
  g.imageSmoothingEnabled = false;
  g.drawImage(sheet, (step % STEPS) * FRAME, dir * FRAME, FRAME, FRAME, Math.round(x), Math.round(y), Math.round(size), Math.round(size));
  g.imageSmoothingEnabled = smooth;
}

/** "John  Kárp" → "JOHNKARP": the key people.json's names are matched with (on the arcade's card service). */
export const nameKey = (name: string): string => name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toUpperCase();
