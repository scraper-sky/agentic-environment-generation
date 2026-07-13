import type { VercelRequest, VercelResponse } from "@vercel/node";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { traverseScene } from "../src/harness/traverse.js";
import { SceneSchema } from "../src/schema/scene.js";
import { WRITABLE_ROOT } from "../src/policy/feedback.js";

// Vercel Hobby caps a function at 60s (see vercel.json's `maxDuration` for
// this route). Each decision is a real OpenAI round-trip (~1-3s) — 60
// decisions (the local-dev UI's cap) would blow well past that budget on a
// hard scene, so the live public deploy gets a tighter server-enforced
// ceiling regardless of what the client asks for.
const MAX_DECISIONS_SERVERLESS = 20;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  try {
    const body = req.body as Record<string, unknown>;
    const scene = SceneSchema.parse(body["scene"]);
    const scenePath = typeof body["scenePath"] === "string" ? body["scenePath"] : `scenes/${scene.id}.json`;
    const requested = typeof body["maxDecisions"] === "number" ? body["maxDecisions"] : MAX_DECISIONS_SERVERLESS;
    const maxDecisions = Math.min(requested, MAX_DECISIONS_SERVERLESS);

    res.status(200);
    res.setHeader("Content-Type", "application/x-ndjson");
    res.setHeader("Cache-Control", "no-cache");

    const trace = await traverseScene(scene, scenePath, {
      maxDecisions,
      onDecision: (decision, context) => {
        res.write(JSON.stringify({ type: "decision", decision, ...context }) + "\n");
      },
    });

    try {
      const tracesDir = join(WRITABLE_ROOT, "traces");
      mkdirSync(tracesDir, { recursive: true });
      writeFileSync(join(tracesDir, `${trace.sceneId}-${Date.now()}.json`), JSON.stringify(trace, null, 2) + "\n");
    } catch {
      // Best-effort only — nothing later reads this back in a stateless deploy.
    }

    res.write(JSON.stringify({ type: "done", trace }) + "\n");
    res.end();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (res.headersSent) {
      res.write(JSON.stringify({ type: "error", error: message }) + "\n");
      res.end();
    } else {
      res.status(500).json({ ok: false, error: message });
    }
  }
}
