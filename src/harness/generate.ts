import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/index";
import { GeneratedSceneSchema, SceneSchema, type GeneratedScene, type Scene } from "../schema/scene.js";
import { validateScene } from "../engine/validateScene.js";
import { getOpenAIClient, OPENAI_MODEL } from "./openaiClient.js";
import { pickMotif } from "./motifs.js";
import {
  DEFAULT_LAMBDA,
  DEFAULT_TAU,
  embedPrompt,
  loadLibrary,
  recordGeneration,
  scoreLibrary,
  toProjectRelative,
  topExemplars,
  WRITABLE_ROOT,
  type PolicyParams,
  type ScoredExemplar,
} from "../policy/feedback.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENES_DIR = join(WRITABLE_ROOT, "scenes");
const SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts", "generate.system.md"), "utf-8");

const MAX_ATTEMPTS = 4;
const MAX_EXEMPLARS = 3;

function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+|-+$)/g, "")
    .slice(0, 40);
  return base || "scene";
}

function formatIssues(issues: { path: string; message: string }[]): string {
  return issues.map((i) => `- ${i.path}: ${i.message}`).join("\n");
}

/** Builds the few-shot user/assistant pairs from retrieved exemplars — the visible output of the retrieval equation, not just a score. */
function buildExemplarMessages(exemplars: ScoredExemplar[]): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  for (const ex of exemplars) {
    try {
      const raw = JSON.parse(readFileSync(join(WRITABLE_ROOT, ex.entry.scenePath), "utf-8"));
      const { id: _id, prompt: _prompt, metadata: _metadata, ...generatedShape } = raw;
      messages.push({ role: "user", content: ex.entry.prompt });
      messages.push({ role: "assistant", content: JSON.stringify(generatedShape) });
    } catch {
      // Scene file missing/moved since it was recorded — skip this one exemplar rather than fail generation.
    }
  }
  if (messages.length === 0) return [];
  return [
    {
      role: "system",
      content:
        "The following user/assistant pairs are real examples from past well-rated generations for similar requests. Use them as style and structure references, but always tailor the scene to the new prompt below rather than reusing one verbatim.",
    },
    ...messages,
  ];
}

export interface GenerateResult {
  scene: Scene;
  scenePath: string;
  attempts: number;
  retrievedExemplars: ScoredExemplar[];
  motif: string;
}

export async function generateScene(prompt: string, options: { outPath?: string; policyParams?: PolicyParams } = {}): Promise<GenerateResult> {
  const client = getOpenAIClient();
  const policyParams = options.policyParams ?? { lambda: DEFAULT_LAMBDA, tau: DEFAULT_TAU };

  const promptEmbedding = await embedPrompt(prompt);
  const scored = scoreLibrary(promptEmbedding, loadLibrary(), policyParams);
  const exemplars = topExemplars(scored, MAX_EXEMPLARS);
  const motif = pickMotif();

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "system",
      content: `Structural scaffold for this scene: "${motif.name}" — ${motif.description} Use this as your default spatial layout so repeated prompts don't all collapse into the same shape, but adapt or drop it if it genuinely conflicts with what the prompt below actually asks for — the prompt always wins.`,
    },
    ...buildExemplarMessages(exemplars),
    { role: "user", content: prompt },
  ];

  let generated: GeneratedScene | null = null;
  let issues: { path: string; message: string }[] = [];
  let attempts = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attempts = attempt;
    const completion = await client.beta.chat.completions.parse({
      model: OPENAI_MODEL,
      messages,
      response_format: zodResponseFormat(GeneratedSceneSchema, "scene"),
    });

    const choice = completion.choices[0];
    if (!choice?.message.parsed) {
      throw new Error(`OpenAI returned no parsed scene on attempt ${attempt} (refusal: ${choice?.message.refusal ?? "unknown"}).`);
    }

    generated = choice.message.parsed;
    issues = validateScene(generated);
    if (issues.length === 0) break;

    console.warn(`Attempt ${attempt} produced a scene with validation issues:\n${formatIssues(issues)}`);
    if (attempt < MAX_ATTEMPTS) {
      messages.push({ role: "assistant", content: JSON.stringify(generated) });
      messages.push({
        role: "user",
        content: `That scene has these problems:\n${formatIssues(issues)}\nOutput a corrected scene that fixes all of them.`,
      });
    }
  }

  if (!generated || issues.length > 0) {
    throw new Error(`Failed to generate a valid scene after ${MAX_ATTEMPTS} attempts:\n${formatIssues(issues)}`);
  }

  const scene = SceneSchema.parse({
    ...generated,
    id: slugify(prompt),
    prompt,
    metadata: { generatedAt: new Date().toISOString(), model: OPENAI_MODEL },
  });

  mkdirSync(SCENES_DIR, { recursive: true });
  const absoluteScenePath = options.outPath ?? join(SCENES_DIR, `${scene.id}-${Date.now()}.json`);
  writeFileSync(absoluteScenePath, JSON.stringify(scene, null, 2) + "\n");

  // Always root-relative from here on — every consumer (CLI display, the
  // feedback library, the /api/generate response) must agree on this, or a
  // downstream `join(WRITABLE_ROOT, scenePath)` silently double-prefixes.
  const scenePath = toProjectRelative(absoluteScenePath);

  recordGeneration({
    sceneId: scene.id,
    prompt,
    scenePath,
    embedding: promptEmbedding,
    attempts,
  });

  return { scene, scenePath, attempts, retrievedExemplars: exemplars, motif: motif.name };
}

async function main() {
  const args = process.argv.slice(2);
  let outPath: string | null = null;
  const outFlagIndex = args.indexOf("--out");
  if (outFlagIndex !== -1) {
    outPath = args[outFlagIndex + 1] ?? null;
    args.splice(outFlagIndex, 2);
  }
  const prompt = args.join(" ").trim();
  if (!prompt) {
    console.error('Usage: npm run generate -- "<text prompt describing the scene>" [--out <path>]');
    process.exit(1);
  }

  console.log(`Generating scene for prompt: "${prompt}" (model: ${OPENAI_MODEL})`);
  const result = await generateScene(prompt, { outPath: outPath ?? undefined });

  console.log(`Wrote ${result.scenePath}`);
  console.log(`  objects: ${result.scene.objects.length}, objective: ${result.scene.objective.type} -> ${result.scene.objective.target}, motif: ${result.motif}`);
  if (result.retrievedExemplars.length > 0) {
    const top = result.retrievedExemplars[0]!;
    console.log(
      `  used ${result.retrievedExemplars.length} rated past example(s) as context (top match: "${top.entry.prompt}", sim=${top.similarity.toFixed(2)} reward=${top.reward.toFixed(2)} score=${top.score.toFixed(2)})`,
    );
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
