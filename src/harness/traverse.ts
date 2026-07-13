import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/index";
import { SceneSchema, type Scene } from "../schema/scene.js";
import { PlatformerActionSchema, TopdownActionSchema } from "../schema/actions.js";
import {
  applyAction,
  createWorld,
  getSnapshot,
  isBlockedAhead,
  isGrounded,
  isGroundAhead,
  isWallAhead,
  step,
  type SimSnapshot,
  type SimWorld,
} from "../engine/simulation.js";
import { checkObjective, type ObjectiveResult } from "../engine/objectives.js";
import { getOpenAIClient, OPENAI_MODEL } from "./openaiClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..", "..");
const TRACES_DIR = join(PROJECT_ROOT, "traces");
const SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts", "traverse.system.md"), "utf-8");

/** Each LLM decision is held for this many physics substeps (~130ms of sim time at 60Hz). */
const SUBSTEPS_PER_DECISION = 8;
/** Safety cap on an airborne "noop" coast — long enough to cover a real jump arc (observed ~60-70 ticks), short enough to force a fresh decision if something is actually wrong. */
const COAST_MAX_SUBSTEPS = 90;

export interface DecisionLog {
  decisionIndex: number;
  tick: number;
  action: string;
  reasoning: string | null;
}

export interface TraceFile {
  sceneId: string;
  scenePath: string;
  prompt: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  verdict: ObjectiveResult;
  decisions: DecisionLog[];
  snapshots: Array<{ tick: number; objects: SimSnapshot }>;
}

/** Compact, non-pixel state summary — this is what the traversal agent actually "sees". */
function buildStateSummary(sim: SimWorld, scene: Scene, tick: number, recentActions: string[]) {
  const snapshot = getSnapshot(sim);
  const player = snapshot[scene.player.objectId]!;
  const objective = scene.objective;
  const target = snapshot[objective.target]!;
  const distanceToTarget = Math.hypot(player.position.x - target.position.x, player.position.y - target.position.y);
  // Signed per-axis remaining distance, separate from the combined straight-line
  // `distance`. A topdown agent routing around an obstacle needs to know which
  // axis still has the bigger gap (e.g. "I've cleared the wall horizontally,
  // now close the vertical gap") — Euclidean distance alone doesn't say that.
  const dx = target.position.x - player.position.x;
  const dy = target.position.y - player.position.y;

  const hazards = scene.hazards.map((id) => {
    const obj = snapshot[id]!;
    return {
      id,
      position: obj.position,
      distance: Math.hypot(player.position.x - obj.position.x, player.position.y - obj.position.y),
      // Straight-line distance can look "far" for a hazard like a pit sitting
      // well below the player's current height, even when it's directly
      // beneath their next few steps — horizontalDistance is the more
      // decision-relevant signal for a platformer's left/right movement.
      horizontalDistance: Math.abs(player.position.x - obj.position.x),
    };
  });

  return {
    controls: scene.player.controls,
    tick,
    stepsRemaining: scene.maxSteps - tick,
    // Each decision is otherwise a stateless call — without this, the agent
    // can't tell it's repeating a losing move and will oscillate forever
    // (e.g. alternating left/right at a wall) instead of trying something new.
    recentActions,
    player: {
      position: player.position,
      velocity: player.velocity,
      ...(scene.player.controls === "platformer"
        ? {
            grounded: isGrounded(sim),
            groundAheadRight: isGroundAhead(sim, 1),
            groundAheadLeft: isGroundAhead(sim, -1),
            wallAheadRight: isWallAhead(sim, 1),
            wallAheadLeft: isWallAhead(sim, -1),
          }
        : {
            blockedUp: isBlockedAhead(sim, "up"),
            blockedDown: isBlockedAhead(sim, "down"),
            blockedLeft: isBlockedAhead(sim, "left"),
            blockedRight: isBlockedAhead(sim, "right"),
          }),
    },
    objective:
      objective.type === "reach"
        ? { type: "reach", targetId: objective.target, targetPosition: target.position, distance: distanceToTarget, dx, dy, radius: objective.radius }
        : {
            type: "collect",
            targetId: objective.target,
            targetPosition: target.position,
            distance: distanceToTarget,
            dx,
            dy,
            radius: objective.radius,
            near: objective.near,
            nearRadius: objective.nearRadius,
          },
    hazards,
  };
}

export interface TraverseOptions {
  maxDecisions?: number;
  /** Fired synchronously right after each decision is made — lets a caller (e.g. a streaming API) surface progress live instead of waiting for the whole run to finish. */
  onDecision?: (decision: DecisionLog, context: { stepsRemaining: number; decisionBudget: number }) => void;
}

/**
 * Core decision loop, taking an already-parsed `Scene` directly rather than a
 * file path — the CLI and the local dev API both have a real scenes/ folder
 * to read from, but a stateless deploy (e.g. a Vercel function, where a
 * scene "written" by one request isn't guaranteed to exist on disk for a
 * later request handled by a different container) does not. Callers with a
 * path on disk should use `traverse()` below instead.
 */
export async function traverseScene(scene: Scene, scenePath: string, options: TraverseOptions = {}): Promise<TraceFile> {
  const sim = createWorld(scene);
  const client = getOpenAIClient();

  const actionSchema = scene.player.controls === "platformer" ? PlatformerActionSchema : TopdownActionSchema;
  const responseFormat = zodResponseFormat(actionSchema, "action");

  const decisionBudget = Math.min(Math.floor(scene.maxSteps / SUBSTEPS_PER_DECISION), options.maxDecisions ?? Infinity);

  const decisions: DecisionLog[] = [];
  const snapshots: Array<{ tick: number; objects: SimSnapshot }> = [{ tick: 0, objects: getSnapshot(sim) }];

  let verdict: ObjectiveResult = { status: "running" };
  let tick = 0;
  const startedAt = new Date().toISOString();
  const RECENT_ACTIONS_WINDOW = 8;
  const recentActions: string[] = [];

  decisionLoop: for (let decisionIndex = 0; decisionIndex < decisionBudget; decisionIndex++) {
    const state = buildStateSummary(sim, scene, tick, recentActions.slice(-RECENT_ACTIONS_WINDOW));
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(state) },
    ];

    const completion = await client.beta.chat.completions.parse({
      model: OPENAI_MODEL,
      messages,
      response_format: responseFormat,
      temperature: 0,
    });

    const choice = completion.choices[0];
    if (!choice?.message.parsed) {
      throw new Error(`OpenAI returned no parsed action on decision ${decisionIndex} (refusal: ${choice?.message.refusal ?? "unknown"}).`);
    }
    const { action, reasoning } = choice.message.parsed;
    const decision: DecisionLog = { decisionIndex, tick, action, reasoning: reasoning ?? null };
    decisions.push(decision);
    recentActions.push(action);
    options.onDecision?.(decision, { stepsRemaining: scene.maxSteps - tick, decisionBudget });

    // "noop" while airborne has nothing new to decide each tick — the arc is
    // already committed by momentum, and re-querying the LLM every 8 ticks
    // just to hear "still coasting" burns the decision budget on ticks where
    // no different action was ever possible. Let a held "noop" ride out the
    // whole arc (up to a safety cap) instead, and only ask again once landed
    // — that's the tick a real decision becomes possible again. Hazards and
    // the objective are still checked every physics tick regardless, so nothing
    // gets missed mid-coast, only the redundant LLM calls are skipped.
    const isCoasting = scene.player.controls === "platformer" && action === "noop" && !isGrounded(sim);
    const substepsThisDecision = isCoasting ? COAST_MAX_SUBSTEPS : SUBSTEPS_PER_DECISION;

    for (let i = 0; i < substepsThisDecision; i++) {
      applyAction(sim, scene.player.controls, action);
      step(sim);
      tick++;
      snapshots.push({ tick, objects: getSnapshot(sim) });
      verdict = checkObjective(sim, scene);
      if (verdict.status !== "running") break decisionLoop;
      if (tick >= scene.maxSteps) {
        verdict = { status: "fail", reason: "timeout" };
        break decisionLoop;
      }
      if (isCoasting && isGrounded(sim)) break;
    }
  }

  if (verdict.status === "running") {
    verdict = { status: "fail", reason: "decision-budget-exceeded" };
  }

  return {
    sceneId: scene.id,
    scenePath,
    prompt: scene.prompt,
    model: OPENAI_MODEL,
    startedAt,
    finishedAt: new Date().toISOString(),
    verdict,
    decisions,
    snapshots,
  };
}

/** Path-based entry point — CLI and local-dev API usage, where scenePath is a real file on disk. */
export async function traverse(scenePath: string, options: TraverseOptions = {}): Promise<TraceFile> {
  const scene = SceneSchema.parse(JSON.parse(readFileSync(scenePath, "utf-8")));
  return traverseScene(scene, scenePath, options);
}

async function main() {
  const args = process.argv.slice(2);

  let outPath: string | null = null;
  const outFlagIndex = args.indexOf("--out");
  if (outFlagIndex !== -1) {
    outPath = args[outFlagIndex + 1] ?? null;
    args.splice(outFlagIndex, 2);
  }

  let maxDecisions: number | undefined;
  const maxFlagIndex = args.indexOf("--max-decisions");
  if (maxFlagIndex !== -1) {
    maxDecisions = Number(args[maxFlagIndex + 1]);
    args.splice(maxFlagIndex, 2);
  }

  const scenePath = args[0];
  if (!scenePath) {
    console.error("Usage: npm run traverse -- <scene.json> [--max-decisions N] [--out <traceFile>]");
    process.exit(1);
  }

  console.log(`Traversing ${scenePath} (model: ${OPENAI_MODEL})`);
  const trace = await traverse(scenePath, { maxDecisions });

  mkdirSync(TRACES_DIR, { recursive: true });
  const filename = outPath ?? join(TRACES_DIR, `${trace.sceneId}-${Date.now()}.json`);
  writeFileSync(filename, JSON.stringify(trace, null, 2) + "\n");

  console.log(`Wrote trace to ${filename}`);
  console.log(`Decisions: ${trace.decisions.length}, ticks: ${trace.snapshots.length - 1}`);

  if (trace.verdict.status === "success") {
    console.log("VERDICT: SUCCESS");
    process.exitCode = 0;
  } else {
    console.log(`VERDICT: FAIL (${trace.verdict.status === "fail" ? trace.verdict.reason : "unknown"})`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
