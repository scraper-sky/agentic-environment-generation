import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateScene } from "../src/harness/generate.js";
import { traverse } from "../src/harness/traverse.js";
import { OPENAI_MODEL } from "../src/harness/openaiClient.js";

const PROMPTS = [
  "A platformer with two gaps to jump over and a flag at the far end, with a spike hazard on the middle platform.",
  "A top-down room split by a dividing wall; navigate around it to collect the can sitting on the table.",
];

async function main() {
  console.log(`Running end-to-end demo: generate -> traverse for ${PROMPTS.length} prompts (model: ${OPENAI_MODEL})`);

  for (const prompt of PROMPTS) {
    console.log(`\n=== "${prompt}" ===`);

    console.log("Generating scene...");
    const { scene, scenePath, retrievedExemplars } = await generateScene(prompt);
    console.log(`  wrote ${scenePath} (${scene.objects.length} objects, objective: ${scene.objective.type} -> ${scene.objective.target})`);
    if (retrievedExemplars.length > 0) {
      console.log(`  used ${retrievedExemplars.length} rated past example(s) as context`);
    }

    console.log("Traversing...");
    const trace = await traverse(scenePath);
    mkdirSync("traces", { recursive: true });
    const tracePath = join("traces", `${trace.sceneId}-${Date.now()}.json`);
    writeFileSync(tracePath, JSON.stringify(trace, null, 2) + "\n");
    const verdict = trace.verdict.status === "fail" ? `FAIL (${trace.verdict.reason})` : trace.verdict.status.toUpperCase();
    console.log(`  wrote ${tracePath}`);
    console.log(`  verdict: ${verdict} (${trace.decisions.length} decisions, ${trace.snapshots.length - 1} ticks)`);
  }

  console.log("\nDone. Run `npm run dev` and open the printed local URL to view and replay these scenes.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
