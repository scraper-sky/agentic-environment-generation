import type { VercelRequest, VercelResponse } from "@vercel/node";
import { recordRating } from "../src/policy/feedback.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  try {
    const body = req.body as Record<string, unknown>;
    const sceneId = body["sceneId"];
    const prompt = body["prompt"];
    const scenePath = body["scenePath"];
    const rating = Number(body["rating"]);
    if (typeof sceneId !== "string" || typeof prompt !== "string" || typeof scenePath !== "string" || !Number.isFinite(rating)) {
      throw new Error("Missing/invalid sceneId, prompt, scenePath, or rating");
    }
    const entry = await recordRating({ sceneId, prompt, scenePath, rating });
    res.status(200).json({ ok: true, entry: { ...entry, embedding: undefined } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
