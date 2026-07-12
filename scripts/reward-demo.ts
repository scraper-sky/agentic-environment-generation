import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeRewardCurve } from "../src/engine/reward.js";
import { SceneSchema } from "../src/schema/scene.js";
import type { TraceFile } from "../src/harness/traverse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const TRACES_DIR = join(PROJECT_ROOT, "traces");

function resolveScenePath(traceScenePath: string): string {
  return isAbsolute(traceScenePath) ? traceScenePath : join(PROJECT_ROOT, traceScenePath);
}

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

/** Downsamples a series into `width` averaged buckets and maps each to a block character — a quick shape-of-the-curve view without a plotting library. */
function sparkline(values: number[], width = 40): string {
  if (values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const bucketSize = Math.max(1, Math.ceil(values.length / width));
  const buckets: number[] = [];
  for (let i = 0; i < values.length; i += bucketSize) {
    const chunk = values.slice(i, i + bucketSize);
    buckets.push(chunk.reduce((a, b) => a + b, 0) / chunk.length);
  }
  return buckets.map((v) => SPARK_CHARS[Math.min(SPARK_CHARS.length - 1, Math.floor(((v - min) / range) * (SPARK_CHARS.length - 1)))]).join("");
}

function processTrace(traceFilePath: string): void {
  const trace = JSON.parse(readFileSync(traceFilePath, "utf-8")) as TraceFile;
  const scene = SceneSchema.parse(JSON.parse(readFileSync(resolveScenePath(trace.scenePath), "utf-8")));

  const curve = computeRewardCurve(trace, scene);
  const rewards = curve.steps.map((s) => s.reward);
  const distances = curve.steps.map((s) => s.distanceToGoal);

  const verdictText = trace.verdict.status === "fail" ? `fail: ${trace.verdict.reason}` : trace.verdict.status;
  console.log(`\n${trace.sceneId}  [${verdictText}]`);
  console.log(`  prompt: "${trace.prompt}"`);
  console.log(`  distance-to-goal  ${sparkline(distances)}  (${distances[0]!.toFixed(0)} -> ${distances[distances.length - 1]!.toFixed(0)})`);
  console.log(`  shaped reward     ${sparkline(rewards)}`);
  console.log(`  total return: ${curve.totalReturn.toFixed(3)}   discounted return: ${curve.discountedReturn.toFixed(3)}   ticks: ${curve.steps.length}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : readdirSync(TRACES_DIR).filter((f) => f.endsWith(".json")).map((f) => join(TRACES_DIR, f));

  if (targets.length === 0) {
    console.error("No traces found. Run `npm run traverse` or the viewer's Traverse button first.");
    process.exit(1);
  }

  console.log(`Computing shaped rewards for ${targets.length} trace(s) — purely from code-level ground truth (object positions each tick), no pixels involved.`);
  for (const target of targets) {
    try {
      processTrace(target);
    } catch (err) {
      console.warn(`  skipped ${target}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main();
