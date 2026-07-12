import * as THREE from "three";
import type { SceneObject } from "../schema/scene.js";

/**
 * Procedurally-drawn pixel-art textures instead of flat MeshBasicMaterial
 * blobs. The whole trick is: draw onto a tiny canvas by hand (fillRect per
 * "pixel", no anti-aliasing), then sample it with NearestFilter so it stays
 * crisp — no blur — no matter how much the plane it's mapped onto is scaled.
 */
const SPRITE_RESOLUTION = 10;
/** Roughly how many world units one tile of a repeating texture (bricks, spike strips) covers, so bricks stay a consistent apparent size regardless of how long the wall/hazard is instead of one texture getting stretched into a thin smear. */
const TILE_UNIT = 25;

type SpriteKind = "player" | "hazard" | "goal" | "collectible" | "tree" | "rock" | "water" | "structure" | "generic";
const TILING_KINDS = new Set<SpriteKind>(["structure", "hazard", "water"]);

function shade(hex: string, factor: number): string {
  const c = new THREE.Color(hex);
  c.multiplyScalar(factor);
  c.r = Math.min(1, c.r);
  c.g = Math.min(1, c.g);
  c.b = Math.min(1, c.b);
  return `#${c.getHexString()}`;
}

function pickSpriteKind(obj: SceneObject): SpriteKind {
  const has = (...tags: string[]) => tags.some((t) => obj.tags.includes(t));
  if (has("player")) return "player";
  if (has("hazard", "spike", "fire", "lava")) return "hazard";
  if (has("goal", "flag", "campfire", "exit")) return "goal";
  if (has("can", "collectible", "key", "coin", "item")) return "collectible";
  if (has("tree", "bush", "plant")) return "tree";
  if (has("rock", "stone", "boulder")) return "rock";
  if (has("water", "lake", "river", "pond")) return "water";
  if (obj.bodyType === "static" && !obj.sensor) return "structure";
  return "generic";
}

/** Brick/masonry pattern — for platforms, walls, tables, and anything else solid. */
function drawStructure(ctx: CanvasRenderingContext2D, size: number, base: string): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const mortar = shade(base, 0.55);
  const rows = 3;
  const rowH = size / rows;
  ctx.fillStyle = mortar;
  for (let r = 0; r <= rows; r++) ctx.fillRect(0, Math.round(r * rowH), size, 1);
  for (let r = 0; r < rows; r++) {
    const offset = r % 2 === 0 ? 0 : rowH / 2;
    for (let x = offset; x < size; x += rowH) ctx.fillRect(Math.round(x), Math.round(r * rowH), 1, Math.ceil(rowH));
  }
  ctx.fillStyle = shade(base, 1.25);
  ctx.fillRect(0, 0, size, 1);
  ctx.fillRect(0, 0, 1, size);
}

/** A small round pixel-art character with two eye pixels — reads as "the character," not a dot. */
function drawPlayer(ctx: CanvasRenderingContext2D, size: number, base: string): void {
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.44;
  ctx.fillStyle = base;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.fillStyle = shade(base, 1.35);
  ctx.fillRect(Math.round(cx - r * 0.5), Math.round(cy - r * 0.6), 1, 1);
  ctx.fillStyle = "#1c1c1c";
  ctx.fillRect(Math.round(cx - r * 0.5), Math.round(cy - 0.5), 1, 1);
  ctx.fillRect(Math.round(cx + r * 0.15), Math.round(cy - 0.5), 1, 1);
}

/** A row of triangular spikes — tiles cleanly across a long hazard strip. */
function drawHazard(ctx: CanvasRenderingContext2D, size: number, base: string): void {
  ctx.fillStyle = base;
  for (let y = 0; y < size; y++) {
    const t = y / size;
    const width = size * t;
    ctx.fillRect(Math.round((size - width) / 2), size - 1 - y, Math.max(1, Math.round(width)), 1);
  }
  ctx.fillStyle = shade(base, 0.6);
  ctx.fillRect(0, size - 1, size, 1);
}

/** A flag on a pole. */
function drawGoal(ctx: CanvasRenderingContext2D, size: number, base: string): void {
  const poleX = Math.round(size * 0.2);
  ctx.fillStyle = "#4a4a4a";
  ctx.fillRect(poleX, 0, 1, size);
  ctx.fillStyle = base;
  const flagHeight = size * 0.42;
  for (let y = 0; y < flagHeight; y++) {
    const width = size * 0.62 * (1 - y / flagHeight);
    ctx.fillRect(poleX + 1, Math.round(y), Math.max(1, Math.round(width)), 1);
  }
}

/** A little can/item silhouette with a rim highlight. */
function drawCollectible(ctx: CanvasRenderingContext2D, size: number, base: string): void {
  const x0 = Math.round(size * 0.28);
  const w = Math.max(1, Math.round(size * 0.44));
  const y0 = Math.round(size * 0.18);
  const h = Math.max(1, Math.round(size * 0.64));
  ctx.fillStyle = base;
  ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = shade(base, 0.6);
  ctx.fillRect(x0, y0, w, 1);
  ctx.fillRect(x0, y0 + h - 1, w, 1);
  ctx.fillStyle = shade(base, 1.3);
  ctx.fillRect(x0 + 1, y0 + 2, 1, Math.max(1, h - 4));
}

/** A trunk plus a round canopy — reads as "tree," not a generic block. */
function drawTree(ctx: CanvasRenderingContext2D, size: number, base: string): void {
  const trunkWidth = Math.max(1, Math.round(size * 0.18));
  const trunkX = Math.round((size - trunkWidth) / 2);
  const trunkHeight = Math.round(size * 0.3);
  ctx.fillStyle = "#6b4a2f";
  ctx.fillRect(trunkX, size - trunkHeight, trunkWidth, trunkHeight);

  ctx.fillStyle = base;
  const cx = size * 0.5;
  const cy = size * 0.4;
  const r = size * 0.42;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.fillStyle = shade(base, 1.3);
  ctx.fillRect(Math.round(cx - r * 0.4), Math.round(cy - r * 0.5), 2, 2);
  ctx.fillStyle = shade(base, 0.6);
  ctx.fillRect(Math.round(cx + r * 0.15), Math.round(cy + r * 0.3), 2, 1);
}

/** An irregular blob from overlapping circles, not a perfect circle — reads as "rock," not "ball." */
function drawRock(ctx: CanvasRenderingContext2D, size: number, base: string): void {
  const blobs = [
    { cx: size * 0.4, cy: size * 0.58, r: size * 0.36 },
    { cx: size * 0.63, cy: size * 0.52, r: size * 0.3 },
    { cx: size * 0.5, cy: size * 0.36, r: size * 0.26 },
  ];
  ctx.fillStyle = base;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = blobs.some((b) => (x + 0.5 - b.cx) ** 2 + (y + 0.5 - b.cy) ** 2 <= b.r * b.r);
      if (inside) ctx.fillRect(x, y, 1, 1);
    }
  }
  ctx.fillStyle = shade(base, 0.6);
  ctx.fillRect(Math.round(size * 0.32), Math.round(size * 0.62), 1, Math.round(size * 0.2));
  ctx.fillStyle = shade(base, 1.35);
  ctx.fillRect(Math.round(size * 0.42), Math.round(size * 0.3), 2, 1);
}

/** Horizontal ripple bands — tiles cleanly across a pond/river/lake. */
function drawWater(ctx: CanvasRenderingContext2D, size: number, base: string): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = shade(base, 1.3);
  for (let y = 1; y < size; y += 3) {
    for (let x = 0; x < size; x++) {
      if ((x + y) % 4 < 2) ctx.fillRect(x, y, 1, 1);
    }
  }
}

/** Fallback for anything untagged: a solid block with a defining border, not a flat blob. */
function drawGeneric(ctx: CanvasRenderingContext2D, size: number, base: string): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = shade(base, 0.55);
  ctx.fillRect(0, 0, size, 1);
  ctx.fillRect(0, size - 1, size, 1);
  ctx.fillRect(0, 0, 1, size);
  ctx.fillRect(size - 1, 0, 1, size);
}

const DRAWERS: Record<SpriteKind, (ctx: CanvasRenderingContext2D, size: number, base: string) => void> = {
  player: drawPlayer,
  hazard: drawHazard,
  goal: drawGoal,
  collectible: drawCollectible,
  tree: drawTree,
  rock: drawRock,
  water: drawWater,
  structure: drawStructure,
  generic: drawGeneric,
};

const masterTextureCache = new Map<string, THREE.Texture>();

function getMasterTexture(kind: SpriteKind, color: string): THREE.Texture {
  const key = `${kind}:${color}`;
  const cached = masterTextureCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = SPRITE_RESOLUTION;
  canvas.height = SPRITE_RESOLUTION;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  DRAWERS[kind](ctx, SPRITE_RESOLUTION, color);

  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  masterTextureCache.set(key, texture);
  return texture;
}

/** Per-object texture: clones the cached master (same drawn pixels) so each mesh can set its own tiling without fighting over shared state. */
export function getPixelTexture(obj: SceneObject, width: number, height: number): THREE.Texture {
  const kind = pickSpriteKind(obj);
  const master = getMasterTexture(kind, obj.color);
  const texture = master.clone();
  texture.needsUpdate = true;

  if (TILING_KINDS.has(kind)) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(Math.max(1, Math.round(width / TILE_UNIT)), Math.max(1, Math.round(height / TILE_UNIT)));
  }

  return texture;
}
