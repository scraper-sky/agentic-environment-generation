import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { generateScene } from "./src/harness/generate.js";
import { editScene, type EditTurn } from "./src/harness/edit.js";
import { traverse } from "./src/harness/traverse.js";
import { SceneSchema } from "./src/schema/scene.js";
import { DEFAULT_LAMBDA, DEFAULT_TAU, loadLibrary, PROJECT_ROOT, recordRating } from "./src/policy/feedback.js";

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

/**
 * Dev-only API so the browser (which can't hold the OpenAI key or write
 * files) can drive generation and feedback. Runs inside the same `npm run
 * dev` process — no separate server to manage.
 */
function harnessApiPlugin(): Plugin {
  return {
    name: "agentic-environment-generation-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/generate", async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        try {
          const body = await readJsonBody(req);
          const prompt = typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
          if (!prompt) throw new Error("Missing 'prompt'");
          const lambda = typeof body["lambda"] === "number" ? body["lambda"] : DEFAULT_LAMBDA;
          const tau = typeof body["tau"] === "number" && body["tau"] > 0 ? body["tau"] : DEFAULT_TAU;

          const result = await generateScene(prompt, { policyParams: { lambda, tau } });
          sendJson(res, 200, {
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
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/edit", async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        try {
          const body = await readJsonBody(req);
          const instruction = typeof body["instruction"] === "string" ? body["instruction"].trim() : "";
          if (!instruction) throw new Error("Missing 'instruction'");
          const baseScene = SceneSchema.parse(body["scene"]);
          const history: EditTurn[] = Array.isArray(body["history"])
            ? body["history"].filter(
                (t): t is EditTurn => typeof t === "object" && t !== null && (t.role === "user" || t.role === "assistant") && typeof t.content === "string",
              )
            : [];

          const result = await editScene(baseScene, instruction, history);
          sendJson(res, 200, { ok: true, scene: result.scene, scenePath: result.scenePath, attempts: result.attempts });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/rate", async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        try {
          const body = await readJsonBody(req);
          const sceneId = body["sceneId"];
          const prompt = body["prompt"];
          const scenePath = body["scenePath"];
          const rating = Number(body["rating"]);
          if (typeof sceneId !== "string" || typeof prompt !== "string" || typeof scenePath !== "string" || !Number.isFinite(rating)) {
            throw new Error("Missing/invalid sceneId, prompt, scenePath, or rating");
          }
          const entry = await recordRating({ sceneId, prompt, scenePath, rating });
          sendJson(res, 200, { ok: true, entry: { ...entry, embedding: undefined } });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/traverse", async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        try {
          const body = await readJsonBody(req);
          const scenePath = body["scenePath"];
          if (typeof scenePath !== "string") throw new Error("Missing 'scenePath'");
          // Each decision is a live OpenAI round-trip (~1-3s), sequential by
          // necessity — an uncapped run can take minutes on a hard scene.
          // The interactive button bounds worst-case wait; `npm run traverse`
          // (CLI) still uses the scene's full maxSteps budget for thorough runs.
          const maxDecisions = typeof body["maxDecisions"] === "number" ? body["maxDecisions"] : 60;

          // Streamed as newline-delimited JSON, one event per line, so the
          // browser can show a live decision-by-decision log instead of one
          // silent multi-minute wait — each decision is a real network
          // round-trip, so this is the actual progress, not a fake spinner.
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/x-ndjson");
          res.setHeader("Cache-Control", "no-cache");

          const trace = await traverse(join(PROJECT_ROOT, scenePath), {
            maxDecisions,
            onDecision: (decision, context) => {
              res.write(JSON.stringify({ type: "decision", decision, ...context }) + "\n");
            },
          });

          const tracesDir = join(PROJECT_ROOT, "traces");
          mkdirSync(tracesDir, { recursive: true });
          const tracePath = join(tracesDir, `${trace.sceneId}-${Date.now()}.json`);
          writeFileSync(tracePath, JSON.stringify(trace, null, 2) + "\n");

          res.write(JSON.stringify({ type: "done", trace }) + "\n");
          res.end();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (res.headersSent) {
            res.write(JSON.stringify({ type: "error", error: message }) + "\n");
            res.end();
          } else {
            sendJson(res, 500, { ok: false, error: message });
          }
        }
      });

      server.middlewares.use("/api/save-trace", async (req, res) => {
        if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "POST only" });
        try {
          const body = await readJsonBody(req);
          const trace = body["trace"] as { sceneId?: unknown } | undefined;
          if (!trace || typeof trace.sceneId !== "string") throw new Error("Missing or invalid 'trace'");

          const tracesDir = join(PROJECT_ROOT, "traces");
          mkdirSync(tracesDir, { recursive: true });
          const tracePath = join(tracesDir, `${trace.sceneId}-${Date.now()}.json`);
          writeFileSync(tracePath, JSON.stringify(trace, null, 2) + "\n");
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use("/api/policy-state", (req, res) => {
        if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "GET only" });
        try {
          const entries = loadLibrary().map((e) => ({
            sceneId: e.sceneId,
            prompt: e.prompt,
            attempts: e.attempts,
            rAuto: e.rAuto,
            rHuman: e.rHuman,
            createdAt: e.createdAt,
          }));
          sendJson(res, 200, { ok: true, entries });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      });
    },
  };
}

export default defineConfig({
  root: "src/viewer",
  plugins: [harnessApiPlugin()],
});
