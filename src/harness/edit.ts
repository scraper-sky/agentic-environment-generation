import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/index";
import { GeneratedSceneSchema, SceneSchema, type GeneratedScene, type Scene } from "../schema/scene.js";
import { validateScene } from "../engine/validateScene.js";
import { getOpenAIClient, OPENAI_MODEL } from "./openaiClient.js";
import { embedPrompt, recordGeneration, toProjectRelative, WRITABLE_ROOT } from "../policy/feedback.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCENES_DIR = join(WRITABLE_ROOT, "scenes");
const SYSTEM_PROMPT = readFileSync(join(__dirname, "prompts", "edit.system.md"), "utf-8");

const MAX_ATTEMPTS = 3;

function formatIssues(issues: { path: string; message: string }[]): string {
  return issues.map((i) => `- ${i.path}: ${i.message}`).join("\n");
}

export interface EditTurn {
  role: "user" | "assistant";
  content: string;
}

export interface EditResult {
  scene: Scene;
  scenePath: string;
  attempts: number;
}

/**
 * Chat-style scene editing: takes the CURRENT scene plus a natural-language
 * instruction (and prior turns, for multi-step edits in one session) and
 * produces an updated scene through the same schema/validation/repair-loop
 * machinery as fresh generation — an edit is just a generation conditioned
 * on an existing scene instead of a blank one.
 */
export async function editScene(baseScene: Scene, instruction: string, history: EditTurn[] = []): Promise<EditResult> {
  const client = getOpenAIClient();

  const { id: _id, prompt: _prompt, metadata: _metadata, ...baseGenerated } = baseScene;

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Current scene:\n${JSON.stringify(baseGenerated)}` },
    ...history.map((h): ChatCompletionMessageParam => ({ role: h.role, content: h.content })),
    { role: "user", content: instruction },
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
      throw new Error(`OpenAI returned no parsed scene on edit attempt ${attempt} (refusal: ${choice?.message.refusal ?? "unknown"}).`);
    }

    generated = choice.message.parsed;
    issues = validateScene(generated);
    if (issues.length === 0) break;

    console.warn(`Edit attempt ${attempt} produced an invalid scene:\n${formatIssues(issues)}`);
    if (attempt < MAX_ATTEMPTS) {
      messages.push({ role: "assistant", content: JSON.stringify(generated) });
      messages.push({
        role: "user",
        content: `That scene has these problems:\n${formatIssues(issues)}\nOutput a corrected scene that fixes all of them.`,
      });
    }
  }

  if (!generated || issues.length > 0) {
    throw new Error(`Failed to produce a valid edited scene after ${MAX_ATTEMPTS} attempts:\n${formatIssues(issues)}`);
  }

  // A fresh id per edit (not reused from baseScene) — sceneId is the key the
  // feedback library, trace lookup, and rating widget all assume is unique
  // to one scene; reusing the base id across edits would make ratings and
  // trace matching ambiguous across a chain of edits. The lineage is still
  // readable from the id prefix and fully readable from `prompt`.
  const scene = SceneSchema.parse({
    ...generated,
    id: `${baseScene.id}-e${Date.now()}`,
    prompt: `${baseScene.prompt} (edited: ${instruction})`,
    metadata: { generatedAt: new Date().toISOString(), model: OPENAI_MODEL },
  });

  mkdirSync(SCENES_DIR, { recursive: true });
  const absoluteScenePath = join(SCENES_DIR, `${scene.id}.json`);
  writeFileSync(absoluteScenePath, JSON.stringify(scene, null, 2) + "\n");
  const scenePath = toProjectRelative(absoluteScenePath);

  const embedding = await embedPrompt(scene.prompt);
  recordGeneration({ sceneId: scene.id, prompt: scene.prompt, scenePath, embedding, attempts });

  return { scene, scenePath, attempts };
}
