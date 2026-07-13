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

const BRIDGE_WIDTH = 100;
const BRIDGE_HEIGHT = 20;
/** Suggest steps comfortably inside the max jump range, not right at the edge — leaves slack for the target's own radius and any minor repositioning the model does on top of this suggestion. */
const BRIDGE_STEP_MARGIN = 0.7;

/**
 * When the target isn't reachable, compute actual intermediate-platform
 * positions that would bridge the gap, rather than just describing the
 * constraint and hoping the model does that arithmetic itself. Mirrors
 * `findSupportSuggestion`'s approach below, which fixes spawn issues
 * reliably in 1-2 repair attempts — repeated testing showed the model
 * repeatedly nudging the target's position by a few pixels per retry instead
 * of adding a platform when only told the *rule*; handing it exact numbers
 * closes that gap the same way it did for spawn placement.
 */
/** Beyond this many single-jump steps in a row, a chain of individually-floating platforms is fragile in practice (one missed jump anywhere in a long chain drops the player past everything below, often out of the world entirely) even though each individual step is technically within jump range — better to flag it and suggest a smaller scene than hand back a long, brittle suggestion. */
const MAX_BRIDGE_STEPS = 5;

function suggestBridgePlatforms(
  reachable: SceneObject[],
  target: { x: number; y: number },
  radius: number,
): { platforms: Array<{ x: number; y: number; width: number; height: number }>; truncated: boolean } {
  let from = reachable[0]!;
  let bestDist = Infinity;
  for (const p of reachable) {
    const d = Math.hypot(p.position.x - target.x, p.position.y - target.y);
    if (d < bestDist) {
      bestDist = d;
      from = p;
    }
  }

  const startX = from.position.x;
  const startTopY = platformTopY(from);
  const dx = target.x - startX;
  const dy = target.y - startTopY; // positive = target sits higher than the starting platform

  const stepsForX = Math.ceil(Math.abs(dx) / (MAX_HORIZONTAL_GAP * BRIDGE_STEP_MARGIN));
  const stepsForY = dy > 0 ? Math.ceil(dy / (MAX_UPWARD_STEP * BRIDGE_STEP_MARGIN)) : 1;
  const rawSteps = Math.max(stepsForX, stepsForY, 2);
  const truncated = rawSteps > MAX_BRIDGE_STEPS;
  const steps = Math.min(rawSteps, MAX_BRIDGE_STEPS);

  const platforms: Array<{ x: number; y: number; width: number; height: number }> = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const topY = startTopY + dy * (rawSteps === steps ? t : (t * steps) / rawSteps);
    platforms.push({ x: Math.round(startX + dx * (rawSteps === steps ? t : (t * steps) / rawSteps)), y: Math.round(topY - BRIDGE_HEIGHT / 2), width: BRIDGE_WIDTH, height: BRIDGE_HEIGHT });
  }
  return { platforms, truncated };
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

    // Both `target` and `near` are frequently static (a can on a table, a key
    // by a well) — if they are, this distance never changes during play. A
    // scene generated with them already farther apart than `nearRadius` is
    // not just hard, it's mathematically unwinnable: checkObjective() re-reads
    // this exact distance every tick and it can never satisfy the threshold no
    // matter how the player/agent moves, silently burning the whole decision
    // budget (or a human's whole attempt) on a scene that could never succeed.
    const target = byId.get(scene.objective.target);
    const near = byId.get(scene.objective.near);
    if (target && near) {
      const actualDistance = Math.hypot(target.position.x - near.position.x, target.position.y - near.position.y);
      const nearRadius = scene.objective.nearRadius ?? 60;
      if (actualDistance > nearRadius) {
        issues.push({
          path: "objective.nearRadius",
          message: `objective.target '${target.id}' is ${actualDistance.toFixed(1)} units from objective.near '${near.id}', which exceeds nearRadius (${nearRadius}). If both are static this can never become true during play, no matter how the player moves — either move '${target.id}' within ${nearRadius} units of '${near.id}', or raise nearRadius to at least ${Math.ceil(actualDistance)}.`,
        });
      }
    }
  }
  scene.hazards.forEach((id, i) => checkRef(`hazards[${i}]`, id));

  if (player && player.bodyType === "dynamic") {
    for (const other of scene.objects) {
      if (other.id === player.id || other.sensor || other.bodyType !== "static") continue;
      if (overlaps(player, other)) {
        // Embedding is possible even while technically "resting" within
        // SUPPORT_TOLERANCE below, which would otherwise leave this as the
        // only issue reported with no concrete number to fix it by — testing
        // showed that alone gets the model stuck repeating the same overlap
        // across every repair attempt instead of converging.
        const fix = findSupportSuggestion(player, scene.objects);
        const fixText = fix ? ` Set player.position.y to exactly ${fix.suggestedY} (over platform '${fix.platformId}') to rest exactly on its surface without embedding in it.` : "";
        issues.push({ path: "player.position", message: `Player spawn overlaps solid object '${other.id}'.${fixText}` });
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
          const { platforms: bridges, truncated } = suggestBridgePlatforms(reachable, target.position, scene.objective.radius);
          const bridgeText = bridges
            .map((b, i) => `bridge-${i + 1}: {"id": "bridge-${i + 1}", "tags": ["platform"], "shape": {"kind": "box", "width": ${b.width}, "height": ${b.height}}, "position": {"x": ${b.x}, "y": ${b.y}}, "bodyType": "static", "sensor": false}`)
            .join("; ");
          const fixInstruction = truncated
            ? `The gap is too large to bridge with a reasonable number of single-jump platforms. Instead of a long fragile chain, shrink the distance: move '${target.id}' much closer to a reachable platform (well within ${MAX_HORIZONTAL_GAP} horizontal / ${MAX_UPWARD_STEP} vertical units), or reduce the scene's overall scale. As a partial start in the right direction, adding platforms like this would help — ${bridgeText} — but you likely also need to move the target closer rather than only adding more of these.`
            : `Fix this by ADDING platform object(s) at these exact positions to bridge the gap (don't just move the target) — ${bridgeText}. Add all of these to the scene's objects array unchanged, keeping the target where it is.`;
          issues.push({
            path: "objective.target",
            message: `Objective target '${target.id}' at (${target.position.x}, ${target.position.y}) is not reachable by walking/jumping from the platforms connected to the player's spawn platform '${spawnPlatform.id}' (reachable platforms: ${reachable.map((p) => p.id).join(", ") || "none"}). ${fixInstruction}`,
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
