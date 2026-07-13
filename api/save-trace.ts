import type { VercelRequest, VercelResponse } from "@vercel/node";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WRITABLE_ROOT } from "../src/policy/feedback.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  try {
    const body = req.body as Record<string, unknown>;
    const trace = body["trace"] as { sceneId?: unknown } | undefined;
    if (!trace || typeof trace.sceneId !== "string") throw new Error("Missing or invalid 'trace'");

    const tracesDir = join(WRITABLE_ROOT, "traces");
    mkdirSync(tracesDir, { recursive: true });
    writeFileSync(join(tracesDir, `${trace.sceneId}-${Date.now()}.json`), JSON.stringify(trace, null, 2) + "\n");
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
