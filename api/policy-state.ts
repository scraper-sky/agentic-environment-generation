import type { VercelRequest, VercelResponse } from "@vercel/node";
import { loadLibrary } from "../src/policy/feedback.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET only" });
  try {
    const entries = loadLibrary().map((e) => ({
      sceneId: e.sceneId,
      prompt: e.prompt,
      attempts: e.attempts,
      rAuto: e.rAuto,
      rHuman: e.rHuman,
      createdAt: e.createdAt,
    }));
    res.status(200).json({ ok: true, entries });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
