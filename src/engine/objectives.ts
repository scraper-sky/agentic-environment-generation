import type { Scene } from "../schema/scene.js";
import { getSnapshot, isTouchingPlayer, type SimSnapshot, type SimWorld } from "./simulation.js";

export type ObjectiveResult = { status: "running" } | { status: "success" } | { status: "fail"; reason: string };

const DEFAULT_NEAR_RADIUS = 60;

function distance(snapshot: SimSnapshot, aId: string, bId: string): number {
  const a = snapshot[aId];
  const b = snapshot[bId];
  if (!a || !b) throw new Error(`checkObjective: unknown object id '${!a ? aId : bId}'`);
  return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
}

/**
 * Pure, deterministic, closed-vocabulary objective check — no eval, no
 * LLM-generated logic. Intended to be called once per physics substep.
 * Hazards use actual physics contact (accurate for any shape); reach/collect
 * use the schema's declared numeric radius (a deliberately loose "got close
 * enough" threshold, not exact geometric overlap).
 */
export function checkObjective(sim: SimWorld, scene: Scene): ObjectiveResult {
  for (const hazardId of scene.hazards) {
    if (isTouchingPlayer(sim, hazardId)) {
      return { status: "fail", reason: `hazard:${hazardId}` };
    }
  }

  const snapshot = getSnapshot(sim);
  const o = scene.objective;
  const playerDistance = distance(snapshot, scene.player.objectId, o.target);
  if (playerDistance > o.radius) return { status: "running" };

  if (o.type === "collect" && o.near) {
    const nearDistance = distance(snapshot, o.target, o.near);
    if (nearDistance > (o.nearRadius ?? DEFAULT_NEAR_RADIUS)) return { status: "running" };
  }

  return { status: "success" };
}
