import type { VercelRequest, VercelResponse } from "@vercel/node";
import { generateScene } from "../src/harness/generate.js";
import { DEFAULT_LAMBDA, DEFAULT_TAU } from "../src/policy/feedback.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  try {
    const body = req.body as Record<string, unknown>;
    const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
    if (!prompt) throw new Error("Missing 'prompt'");
    const lambda = typeof body["lambda"] === "number" ? body["lambda"] : DEFAULT_LAMBDA;
    const tau = typeof body["tau"] === "number" && body["tau"] > 0 ? body["tau"] : DEFAULT_TAU;

    const result = await generateScene(prompt, { policyParams: { lambda, tau } });
    res.status(200).json({
      ok: true,
      scene: result.scene,
      scenePath: result.scenePath,
      attempts: result.attempts,
      motif: result.motif,
      retrievedExemplars: result.retrievedExemplars.map((e) => ({
        prompt: e.entry.prompt,
        similarity: e.similarity,
        reward: e.reward,
        score: e.score,
        weight: e.weight,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
