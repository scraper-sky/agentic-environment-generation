import type { GeneratedScene, SceneObject } from "../schema/scene.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

function halfExtents(obj: SceneObject): { x: number; y: number } {
  if (obj.shape.kind === "box") return { x: obj.shape.width / 2, y: obj.shape.height / 2 };
  return { x: obj.shape.radius, y: obj.shape.radius };
}

/** Conservative AABB check — enough to catch an obviously-broken spawn without full shape-specific narrow-phase math. */
function overlaps(a: SceneObject, b: SceneObject): boolean {
  const aHalf = halfExtents(a);
  const bHalf = halfExtents(b);
  const dx = Math.abs(a.position.x - b.position.x);
  const dy = Math.abs(a.position.y - b.position.y);
  return dx < aHalf.x + bHalf.x && dy < aHalf.y + bHalf.y;
}

const SUPPORT_TOLERANCE = 6;

/** The static, non-sensor object `obj` is resting directly on top of (bottom edge ~= its top edge, with horizontal overlap), if any. */
function findSupportingPlatform(obj: SceneObject, objects: SceneObject[]): SceneObject | null {
  const objHalf = halfExtents(obj);
  const objBottom = obj.position.y - objHalf.y;
  return (
    objects.find((other) => {
      if (other.id === obj.id || other.bodyType !== "static" || other.sensor) return false;
      const otherHalf = halfExtents(other);
      const otherTop = other.position.y + otherHalf.y;
      const restingOnTop = Math.abs(objBottom - otherTop) <= SUPPORT_TOLERANCE;
      const horizontalOverlap = Math.abs(obj.position.x - other.position.x) < objHalf.x + otherHalf.x;
      return restingOnTop && horizontalOverlap;
    }) ?? null
  );
}

/**
 * Finds the best static-object candidate to rest `obj` on (by horizontal
 * overlap, closest vertically) and returns the exact y that would put it
 * there. Handing the model a precomputed number in the validation message is
 * far more reliable than a formula — small models are prone to arithmetic
 * slips when asked to compute this themselves under a repair prompt.
 */
function findSupportSuggestion(obj: SceneObject, objects: SceneObject[]): { platformId: string; suggestedY: number } | null {
  const objHalf = halfExtents(obj);
  let best: { platformId: string; suggestedY: number; dist: number } | null = null;
  for (const other of objects) {
    if (other.id === obj.id || other.bodyType !== "static" || other.sensor) continue;
    const otherHalf = halfExtents(other);
    const horizontalOverlap = Math.abs(obj.position.x - other.position.x) < objHalf.x + otherHalf.x;
    if (!horizontalOverlap) continue;
    const suggestedY = other.position.y + otherHalf.y + objHalf.y;
    const dist = Math.abs(obj.position.y - suggestedY);
    if (!best || dist < best.dist) best = { platformId: other.id, suggestedY, dist };
  }
  return best ? { platformId: best.platformId, suggestedY: best.suggestedY } : null;
}

const MAX_HORIZONTAL_GAP = 180;
const MAX_UPWARD_STEP = 90;

function platformSpanX(p: SceneObject): { left: number; right: number } {
  const half = halfExtents(p);
  return { left: p.position.x - half.x, right: p.position.x + half.x };
}
function platformTopY(p: SceneObject): number {
  return p.position.y + halfExtents(p).y;
}

/** Directed: can a player standing on platform `a` reach platform `b` by walking/jumping? A coarse sanity net calibrated to this engine's MOVE_SPEED/JUMP_SPEED — not exact physics, and deliberately ignores hazards (avoiding those is the traversal agent's job, not the level layout's). */
function canJumpBetweenPlatforms(a: SceneObject, b: SceneObject): boolean {
  const aSpan = platformSpanX(a);
  const bSpan = platformSpanX(b);
  const horizontalGap = Math.max(0, bSpan.left - aSpan.right, aSpan.left - bSpan.right);
  const verticalStep = platformTopY(b) - platformTopY(a); // positive = b is higher than a
  return horizontalGap <= MAX_HORIZONTAL_GAP && verticalStep <= MAX_UPWARD_STEP;
}

/** Same idea but to an arbitrary point (e.g. the objective's position), with `radius` slack since the player only needs to get within that distance, not land exactly there. */
function canJumpToPoint(a: SceneObject, point: { x: number; y: number }, radius: number): boolean {
  const aSpan = platformSpanX(a);
  const horizontalGap = Math.max(0, aSpan.left - point.x, point.x - aSpan.right) - radius;
  const verticalStep = point.y - platformTopY(a) - radius;
  return horizontalGap <= MAX_HORIZONTAL_GAP && verticalStep <= MAX_UPWARD_STEP;
}

/** BFS over jump edges from the platform the player spawns on — which platforms could a jumping agent plausibly reach at all? */
function reachablePlatforms(spawn: SceneObject, platforms: SceneObject[]): SceneObject[] {
  const visited = new Map<string, SceneObject>([[spawn.id, spawn]]);
  const queue = [spawn];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const candidate of platforms) {
      if (visited.has(candidate.id)) continue;
      if (canJumpBetweenPlatforms(current, candidate)) {
        visited.set(candidate.id, candidate);
        queue.push(candidate);
      }
    }
  }
  return [...visited.values()];
}

const BOUNDARY_TOLERANCE = 5;
/** A wall must span at least this fraction of the room's perpendicular dimension to count as a real boundary — otherwise an unrelated wall whose *corner* merely touches an edge (e.g. a full-width top wall's corner sitting at x=0) would falsely satisfy a left/right check without actually blocking that side. */
const MIN_BOUNDARY_SPAN_FRACTION = 0.6;

/** Is there a static, non-sensor object that actually runs along the given bounds edge (spans most of the perpendicular dimension, not just touches a corner)? */
function hasBoundaryAt(edge: "left" | "right" | "top" | "bottom", scene: GeneratedScene): boolean {
  return scene.objects.some((o) => {
    if (o.bodyType !== "static" || o.sensor) return false;
    const half = halfExtents(o);
    if (edge === "left" || edge === "right") {
      if (half.y * 2 < scene.bounds.height * MIN_BOUNDARY_SPAN_FRACTION) return false;
      return edge === "left" ? o.position.x - half.x <= BOUNDARY_TOLERANCE : o.position.x + half.x >= scene.bounds.width - BOUNDARY_TOLERANCE;
    }
    if (half.x * 2 < scene.bounds.width * MIN_BOUNDARY_SPAN_FRACTION) return false;
    return edge === "bottom" ? o.position.y - half.y <= BOUNDARY_TOLERANCE : o.position.y + half.y >= scene.bounds.height - BOUNDARY_TOLERANCE;
  });
}

/**
 * Semantic checks Zod's structural validation can't express: dangling id
 * references, wrong body types, and spawn overlaps. Run after Zod parsing,
 * on both LLM-generated and hand-authored scenes.
 */
export function validateScene(scene: GeneratedScene): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byId = new Map(scene.objects.map((o) => [o.id, o]));

  const ids = scene.objects.map((o) => o.id);
  const duplicateIds = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (duplicateIds.length > 0) {
    issues.push({ path: "objects", message: `Duplicate object ids: ${duplicateIds.join(", ")}` });
  }

  const checkRef = (path: string, id: string) => {
    if (!byId.has(id)) issues.push({ path, message: `References unknown object id '${id}'` });
  };

  const player = byId.get(scene.player.objectId);
  if (!player) {
    issues.push({ path: "player.objectId", message: `References unknown object id '${scene.player.objectId}'` });
  } else if (player.bodyType !== "dynamic") {
    issues.push({ path: "player.objectId", message: `Player object '${player.id}' must have bodyType 'dynamic'` });
  }

  checkRef("objective.target", scene.objective.target);
  if (scene.objective.type === "collect" && scene.objective.near) {
    checkRef("objective.near", scene.objective.near);
  }
  scene.hazards.forEach((id, i) => checkRef(`hazards[${i}]`, id));

  if (player && player.bodyType === "dynamic") {
    for (const other of scene.objects) {
      if (other.id === player.id || other.sensor || other.bodyType !== "static") continue;
      if (overlaps(player, other)) {
        issues.push({ path: "player.position", message: `Player spawn overlaps solid object '${other.id}'` });
      }
    }

    if (scene.player.controls === "platformer") {
      const spawnPlatform = findSupportingPlatform(player, scene.objects);
      if (!spawnPlatform) {
        const fix = findSupportSuggestion(player, scene.objects);
        const fixText = fix
          ? ` Set player.position.y to exactly ${fix.suggestedY} (keep position.x where it is, over platform '${fix.platformId}') to rest exactly on its top surface.`
          : ` No static platform overlaps the player's current x position at all — move player.position.x so it is directly above an existing platform, then set position.y to that platform's top surface plus the player's radius.`;
        issues.push({
          path: "player.position",
          message: `Player spawn at (${player.position.x}, ${player.position.y}) is not resting on top of any static platform (its bottom edge must be within ~${SUPPORT_TOLERANCE} units of a static object's top surface, with horizontal overlap). It will fall indefinitely instead of starting grounded.${fixText}`,
        });
      } else {
        const platforms = scene.objects.filter((o) => o.bodyType === "static" && !o.sensor);
        const reachable = reachablePlatforms(spawnPlatform, platforms);
        const target = byId.get(scene.objective.target);
        if (target && !reachable.some((p) => canJumpToPoint(p, target.position, scene.objective.radius))) {
          issues.push({
            path: "objective.target",
            message: `Objective target '${target.id}' at (${target.position.x}, ${target.position.y}) is not reachable by walking/jumping from the platforms connected to the player's spawn platform '${spawnPlatform.id}' (reachable platforms: ${reachable.map((p) => p.id).join(", ") || "none"}). Either move the target within about ${MAX_HORIZONTAL_GAP} horizontal units and ${MAX_UPWARD_STEP} units above a reachable platform's surface, or add intermediate platforms bridging the gap so every platform on the path to the target is reachable from the one before it.`,
          });
        }
      }
    }
  }

  if (scene.player.controls === "topdown") {
    for (const edge of ["left", "right", "top", "bottom"] as const) {
      if (!hasBoundaryAt(edge, scene)) {
        issues.push({
          path: "objects",
          message: `Topdown scene has no static wall along the ${edge} edge of bounds (0..${scene.bounds.width} x 0..${scene.bounds.height}) — the player can wander outside the intended play area indefinitely. Add enclosing boundary walls on all four sides.`,
        });
      }
    }
  }

  return issues;
}
