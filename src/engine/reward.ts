import type { Scene } from "../schema/scene.js";
import type { TraceFile } from "../harness/traverse.js";

/**
 * Turns a recorded trace's code-level ground truth into a continuous reward
 * signal — the piece the brief's "reward model training" pillar actually
 * needs and that `checkObjective()` alone doesn't provide (it's binary:
 * running/success/fail). This computes the signal; it does not train a
 * model — see README for why that's the deliberate scope boundary.
 */

export interface RewardStep {
  tick: number;
  distanceToGoal: number;
  reward: number;
}

export interface RewardCurve {
  steps: RewardStep[];
  totalReturn: number;
  discountedReturn: number;
}

const STEP_PENALTY = 0.001;
const SUCCESS_BONUS = 10;
const HAZARD_PENALTY = -10;
const TIMEOUT_PENALTY = -3;
const DISCOUNT = 0.995;

function distanceAt(objects: TraceFile["snapshots"][number]["objects"], aId: string, bId: string): number {
  const a = objects[aId];
  const b = objects[bId];
  if (!a || !b) throw new Error(`computeRewardCurve: missing object '${!a ? aId : bId}' in snapshot`);
  return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
}

/**
 * Potential-based reward shaping (Ng, Harada & Russell, 1999): r_t =
 * Phi(s_t) - Phi(s_{t+1}) with Phi(s) = -distance_to_goal(s). This rewards
 * ticks that reduce distance to the objective, is provably policy-invariant
 * (shaping doesn't change what the optimal policy is, only how fast it's
 * findable), and — the point here — is computed entirely from simulation
 * ground truth (object positions each tick), never from pixels.
 *
 * Simplification: for "collect+near" objectives this only shapes on
 * distance to `target`, not `target`'s distance to `near` — a real reward
 * model would want both terms; this demonstrates the mechanism, not a
 * production-ready reward function.
 */
export function computeRewardCurve(trace: TraceFile, scene: Scene): RewardCurve {
  const playerId = scene.player.objectId;
  const targetId = scene.objective.target;

  const steps: RewardStep[] = [];
  let prevDistance = distanceAt(trace.snapshots[0]!.objects, playerId, targetId);

  for (let i = 1; i < trace.snapshots.length; i++) {
    const snapshot = trace.snapshots[i]!;
    const distance = distanceAt(snapshot.objects, playerId, targetId);
    const potentialGain = prevDistance - distance; // positive = got closer this tick
    let reward = potentialGain - STEP_PENALTY;

    if (i === trace.snapshots.length - 1) {
      if (trace.verdict.status === "success") reward += SUCCESS_BONUS;
      else if (trace.verdict.status === "fail" && trace.verdict.reason.startsWith("hazard")) reward += HAZARD_PENALTY;
      else if (trace.verdict.status === "fail") reward += TIMEOUT_PENALTY;
    }

    steps.push({ tick: snapshot.tick, distanceToGoal: distance, reward });
    prevDistance = distance;
  }

  const totalReturn = steps.reduce((sum, s) => sum + s.reward, 0);
  const discountedReturn = steps.reduce((sum, s, i) => sum + s.reward * Math.pow(DISCOUNT, i), 0);

  return { steps, totalReturn, discountedReturn };
}
