import type { VercelRequest, VercelResponse } from "@vercel/node";
import { editScene, type EditTurn } from "../src/harness/edit.js";
import { SceneSchema } from "../src/schema/scene.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });
  try {
    const body = req.body as Record<string, unknown>;
    const instruction = typeof body["instruction"] === "string" ? body["instruction"].trim() : "";
    if (!instruction) throw new Error("Missing 'instruction'");
    const baseScene = SceneSchema.parse(body["scene"]);
    const history: EditTurn[] = Array.isArray(body["history"])
      ? body["history"].filter(
          (t): t is EditTurn => typeof t === "object" && t !== null && (t.role === "user" || t.role === "assistant") && typeof t.content === "string",
        )
      : [];

    const result = await editScene(baseScene, instruction, history);
    res.status(200).json({ ok: true, scene: result.scene, scenePath: result.scenePath, attempts: result.attempts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
