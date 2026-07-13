import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getOpenAIClient } from "../harness/openaiClient.js";

/**
 * Reward-weighted retrieval "policy" for scene generation: not a trained
 * model, a growing library of (prompt, scene, reward) triples that gets
 * re-ranked per new prompt and injected as few-shot context. See README for
 * the full equation writeup; this module is that equation, not a mockup of it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = join(__dirname, "..", "..");

/**
 * Where generated scenes/traces/feedback.json actually get written. Locally
 * (CLI, `vite dev`) that's the real project directory, same as always. On a
 * serverless deploy (Vercel sets `VERCEL=1`) the deployed bundle's filesystem
 * is read-only except `/tmp` — writing to PROJECT_ROOT there would throw.
 * `/tmp` is also ephemeral and not shared across invocations, which is fine:
 * generate/edit/traverse there work statelessly, passing scene data through
 * the request/response instead of round-tripping via disk (see traverseScene
 * in traverse.ts) — this write is just so the same code path doesn't need a
 * serverless-specific branch, not something later requests depend on.
 */
export const WRITABLE_ROOT = process.env.VERCEL ? "/tmp" : PROJECT_ROOT;
const FEEDBACK_FILE = join(WRITABLE_ROOT, "feedback.json");

/**
 * Every scenePath that crosses an API boundary (client<->server) or gets
 * stored in the feedback library must be root-relative, e.g.
 * "scenes/example-platformer.json" — never absolute. `join(WRITABLE_ROOT, x)`
 * silently double-prefixes if `x` is already absolute, so this is the one
 * place that conversion happens; every producer of a scenePath should route
 * through it before it leaves the process.
 */
export function toProjectRelative(path: string): string {
  const resolved = resolve(path);
  return resolved.startsWith(WRITABLE_ROOT) ? resolved.slice(WRITABLE_ROOT.length).replace(/^\/+/, "") : resolved;
}

export interface FeedbackEntry {
  sceneId: string;
  prompt: string;
  /** Project-root-relative path, e.g. "scenes/example-platformer.json". */
  scenePath: string;
  embedding: number[];
  /** How many generation attempts the repair loop needed — fewer is a cleaner automatic-quality signal. */
  attempts: number;
  /** Automatic quality proxy in [0,1], derived from attempts (and, later, traversal success). */
  rAuto: number;
  /** Human rating in [0,1] (normalized from 1-5 stars), null until rated. */
  rHuman: number | null;
  createdAt: string;
}

export function loadLibrary(): FeedbackEntry[] {
  if (!existsSync(FEEDBACK_FILE)) return [];
  return JSON.parse(readFileSync(FEEDBACK_FILE, "utf-8"));
}

function saveLibrary(entries: FeedbackEntry[]): void {
  writeFileSync(FEEDBACK_FILE, JSON.stringify(entries, null, 2) + "\n");
}

export async function embedPrompt(prompt: string): Promise<number[]> {
  const client = getOpenAIClient();
  const res = await client.embeddings.create({ model: "text-embedding-3-small", input: prompt });
  return res.data[0]!.embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export function combinedReward(entry: Pick<FeedbackEntry, "rHuman" | "rAuto">): number {
  // Human rating dominates (0.7) — it's literally what was asked for: "they rate
  // the accuracy of how well the scene matches." rAuto (0.3) is the free signal
  // we already have (did it validate cleanly) and fills in when unrated.
  const rHuman = entry.rHuman ?? entry.rAuto;
  return 0.7 * rHuman + 0.3 * entry.rAuto;
}

export interface ScoredExemplar {
  entry: FeedbackEntry;
  similarity: number;
  reward: number;
  score: number;
  weight: number;
}

/** Relevance vs. reward balance: default favors relevance, since a great-but-irrelevant exemplar teaches the wrong lesson. UI-tunable — see PolicyParams. */
export const DEFAULT_LAMBDA = 0.6;
/** Softmax temperature — low = sharp top-k-like cutoff, high = near-uniform. UI-tunable — see PolicyParams. */
export const DEFAULT_TAU = 0.2;

export interface PolicyParams {
  lambda: number;
  tau: number;
}

/**
 * score_i = lambda * sim(prompt, prompt_i) + (1 - lambda) * reward_i
 * weight_i = softmax(score_i / tau)
 * Only rated entries participate — unrated ones have no reward signal yet.
 */
export function scoreLibrary(promptEmbedding: number[], library: FeedbackEntry[], params: PolicyParams = { lambda: DEFAULT_LAMBDA, tau: DEFAULT_TAU }): ScoredExemplar[] {
  const rated = library.filter((e) => e.rHuman !== null);
  if (rated.length === 0) return [];

  const { lambda, tau } = params;
  const scored = rated.map((entry) => {
    const similarity = cosineSimilarity(promptEmbedding, entry.embedding);
    const reward = combinedReward(entry);
    const score = lambda * similarity + (1 - lambda) * reward;
    return { entry, similarity, reward, score, weight: 0 };
  });

  const maxScore = Math.max(...scored.map((s) => s.score));
  const expScores = scored.map((s) => Math.exp((s.score - maxScore) / tau));
  const sumExp = expScores.reduce((a, b) => a + b, 0);
  scored.forEach((s, i) => (s.weight = expScores[i]! / sumExp));

  return scored.sort((a, b) => b.score - a.score);
}

export function topExemplars(scored: ScoredExemplar[], k = 3): ScoredExemplar[] {
  return scored.slice(0, k);
}

export function attemptsToRAuto(attempts: number): number {
  if (attempts <= 1) return 1.0;
  if (attempts === 2) return 0.6;
  return 0.3;
}

export function recordGeneration(entry: {
  sceneId: string;
  prompt: string;
  scenePath: string;
  embedding: number[];
  attempts: number;
}): FeedbackEntry {
  const library = loadLibrary();
  const full: FeedbackEntry = {
    ...entry,
    rAuto: attemptsToRAuto(entry.attempts),
    rHuman: null,
    createdAt: new Date().toISOString(),
  };
  library.push(full);
  saveLibrary(library);
  return full;
}

/** Upserts a rating — creates a library entry on the fly if this scene (e.g. a hand-authored example) was never generated through this pipeline. */
export async function recordRating(params: { sceneId: string; prompt: string; scenePath: string; rating: number }): Promise<FeedbackEntry> {
  const library = loadLibrary();
  let entry = library.find((e) => e.sceneId === params.sceneId);
  if (!entry) {
    const embedding = await embedPrompt(params.prompt);
    entry = {
      sceneId: params.sceneId,
      prompt: params.prompt,
      scenePath: params.scenePath,
      embedding,
      attempts: 1,
      rAuto: attemptsToRAuto(1),
      rHuman: null,
      createdAt: new Date().toISOString(),
    };
    library.push(entry);
  }
  entry.rHuman = (params.rating - 1) / 4;
  saveLibrary(library);
  return entry;
}
