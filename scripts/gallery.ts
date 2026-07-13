import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateScene } from "../src/harness/generate.js";
import { traverse } from "../src/harness/traverse.js";
import { OPENAI_MODEL } from "../src/harness/openaiClient.js";
import type { Scene } from "../src/schema/scene.js";

/**
 * Deliberately spans genre, control scheme (platformer vs topdown), objective
 * type (reach vs collect), and difficulty (open/undirected vs
 * hazard/obstacle) — the point of this script is to demonstrate breadth in
 * one skim, not just that generation works on the two examples committed
 * elsewhere in the repo.
 */
const PROMPTS = [
  "A platformer with three ascending platforms leading to a flag on a cliff, with a spike pit blocking the second jump.",
  "A person wandering through a foggy pine forest looking for a lost key near an old well.",
  "A desert canyon the player must jump across to reach an oasis with a flag.",
  "A small locked room with a table in the corner and a can sitting on top of it that must be grabbed.",
  "An obstacle gauntlet with lava pits and a narrow platform path to an exit door.",
  "A tranquil lakeside with a fishing dock, some rocks, and a distant campfire to reach.",
  "A vertical tower climb with stacked platforms rising toward a flag at the top.",
  "A maze of hedges in a garden, with a fountain goal at the center.",
  "A rocky mountain pass with boulders scattered around, ending at a cave entrance.",
  "An open meadow at sunset with scattered trees and a picnic basket to collect near a blanket.",
];

const GALLERY_DIR = join(process.cwd(), "gallery");
const MAX_DECISIONS = 50;

function renderSceneSVG(scene: Scene): string {
  const { width, height } = scene.bounds;
  const flipY = (y: number) => height - y;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="monospace">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#0c0a08"/>`,
    `<defs><pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#241d10"/></pattern></defs>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#dots)"/>`,
  ];
  for (const obj of scene.objects) {
    const color = obj.color ?? "#888888";
    const opacity = obj.sensor ? 0.88 : 1;
    if (obj.shape.kind === "box") {
      const w = obj.shape.width;
      const h = obj.shape.height;
      const x = obj.position.x - w / 2;
      const y = flipY(obj.position.y) - h / 2;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="${opacity}" stroke="#00000066" stroke-width="1" rx="2"/>`);
    } else {
      const r = obj.shape.radius;
      const cx = obj.position.x;
      const cy = flipY(obj.position.y);
      parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${color}" opacity="${opacity}" stroke="#00000066" stroke-width="1"/>`);
    }
  }
  parts.push(`<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#35291a" stroke-width="1"/>`);
  parts.push(`</svg>`);
  return parts.join("");
}

interface GalleryEntry {
  prompt: string;
  scenePath: string;
  svgPath: string;
  motif: string;
  controls: string;
  objective: string;
  objects: number;
  verdict: string;
  decisions: number;
}

async function main() {
  mkdirSync(GALLERY_DIR, { recursive: true });
  const entries: GalleryEntry[] = [];

  console.log(`Building gallery: ${PROMPTS.length} prompts, generate -> traverse (model: ${OPENAI_MODEL}, max ${MAX_DECISIONS} decisions each)`);

  for (const [i, prompt] of PROMPTS.entries()) {
    console.log(`\n[${i + 1}/${PROMPTS.length}] "${prompt}"`);
    try {
      const { scene, scenePath, motif } = await generateScene(prompt);
      console.log(`  generated ${scene.objects.length} objects, controls=${scene.player.controls}, objective=${scene.objective.type}, motif=${motif}`);

      const svgName = `${scene.id}.svg`;
      writeFileSync(join(GALLERY_DIR, svgName), renderSceneSVG(scene));

      const trace = await traverse(scenePath, { maxDecisions: MAX_DECISIONS });
      const tracePath = join("traces", `${trace.sceneId}-${Date.now()}.json`);
      writeFileSync(tracePath, JSON.stringify(trace, null, 2) + "\n");
      const verdict = trace.verdict.status === "fail" ? `FAIL (${trace.verdict.reason})` : trace.verdict.status.toUpperCase();
      console.log(`  agent: ${verdict} in ${trace.decisions.length} decisions`);

      entries.push({
        prompt,
        scenePath,
        svgPath: `gallery/${svgName}`,
        motif,
        controls: scene.player.controls,
        objective: scene.objective.type,
        objects: scene.objects.length,
        verdict,
        decisions: trace.decisions.length,
      });
    } catch (err) {
      console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
      entries.push({
        prompt,
        scenePath: "",
        svgPath: "",
        motif: "-",
        controls: "-",
        objective: "-",
        objects: 0,
        verdict: "GENERATION FAILED",
        decisions: 0,
      });
    }
  }

  const successCount = entries.filter((e) => e.verdict === "SUCCESS").length;
  console.log(`\n=== ${successCount}/${entries.length} scenes completed by the agent (cap: ${MAX_DECISIONS} decisions each) ===`);

  writeFileSync(join(GALLERY_DIR, "results.json"), JSON.stringify({ model: OPENAI_MODEL, maxDecisions: MAX_DECISIONS, successCount, total: entries.length, entries }, null, 2) + "\n");
  console.log(`Wrote gallery/results.json (${entries.length} entries) and gallery/*.svg previews.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
