import snapshot from './wall.json' with { type: 'json' };

export type WallPanel = { p: number; n: string; h?: string };
export const WALL_PANELS: readonly WallPanel[] = snapshot.positions;
