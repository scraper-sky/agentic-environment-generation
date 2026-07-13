import * as THREE from "three";
import katex from "katex";
import "katex/dist/katex.min.css";
import { SceneSchema, type Scene, type SceneObject } from "../schema/scene.js";
import type { TraceFile } from "../harness/traverse.js";
import { getPixelTexture } from "./pixelSprites.js";

/** Renders LaTeX into `el`, falling back to the raw source as plain text if KaTeX can't parse it — never a blank panel. */
function renderMath(el: Element, tex: string, displayMode: boolean): void {
  try {
    katex.render(tex, el as HTMLElement, { throwOnError: false, displayMode });
  } catch {
    el.textContent = tex;
  }
}

const ACCENT = "#e8a33d";

function renderRetrievalEquations(): void {
  renderMath(
    document.querySelector("#eq-score")!,
    String.raw`\text{score}_i = \textcolor{${ACCENT}}{\lambda} \cdot \text{sim}(p, p_i) + (1-\textcolor{${ACCENT}}{\lambda}) \cdot \text{reward}_i`,
    true,
  );
  renderMath(
    document.querySelector("#eq-weight")!,
    String.raw`w_i = \dfrac{\exp(\text{score}_i \,/\, \textcolor{${ACCENT}}{\tau})}{\sum_j \exp(\text{score}_j \,/\, \textcolor{${ACCENT}}{\tau})}`,
    true,
  );
  renderMath(document.querySelector("#eq-reward")!, String.raw`\text{reward}_i = 0.7\, r_i^{\text{human}} + 0.3\, r_i^{\text{auto}}`, true);
  renderMath(document.querySelector("#lambda-symbol")!, String.raw`\lambda`, false);
  renderMath(document.querySelector("#tau-symbol")!, String.raw`\tau`, false);
}

const sceneModules = import.meta.glob("../../scenes/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const traceModules = import.meta.glob("../../traces/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const traces = Object.values(traceModules) as TraceFile[];

const select = document.querySelector<HTMLSelectElement>("#scene-select")!;
const status = document.querySelector<HTMLSpanElement>("#status")!;
const container = document.querySelector<HTMLDivElement>("#canvas-frame")!;
const traverseBtn = document.querySelector<HTMLButtonElement>("#traverse-btn")!;
const replayBtn = document.querySelector<HTMLButtonElement>("#replay-btn")!;
const verdictEl = document.querySelector<HTMLSpanElement>("#verdict")!;
const promptInput = document.querySelector<HTMLTextAreaElement>("#prompt-input")!;
const generateBtn = document.querySelector<HTMLButtonElement>("#generate-btn")!;
const generateStatus = document.querySelector<HTMLDivElement>("#generate-status")!;
const ratingStars = document.querySelector<HTMLDivElement>("#rating-stars")!;
const ratingStatus = document.querySelector<HTMLDivElement>("#rating-status")!;
const policySummary = document.querySelector<HTMLDivElement>("#policy-summary")!;
const policyExemplars = document.querySelector<HTMLDivElement>("#policy-exemplars")!;
const lambdaSlider = document.querySelector<HTMLInputElement>("#lambda-slider")!;
const lambdaValue = document.querySelector<HTMLSpanElement>("#lambda-value")!;
const tauSlider = document.querySelector<HTMLInputElement>("#tau-slider")!;
const tauValue = document.querySelector<HTMLSpanElement>("#tau-value")!;
const terminal = document.querySelector<HTMLDivElement>("#terminal")!;

lambdaSlider.addEventListener("input", () => (lambdaValue.textContent = Number(lambdaSlider.value).toFixed(2)));
tauSlider.addEventListener("input", () => (tauValue.textContent = Number(tauSlider.value).toFixed(2)));

/** Appends one line built from text spans (never raw HTML — decision reasoning is LLM-generated free text). */
function appendTerminalLine(spans: Array<{ text: string; className?: string }>, lineClassName = ""): void {
  const line = document.createElement("div");
  line.className = `terminal-line ${lineClassName}`.trim();
  for (const s of spans) {
    const span = document.createElement("span");
    if (s.className) span.className = s.className;
    span.textContent = s.text;
    line.appendChild(span);
  }
  terminal.appendChild(line);
  terminal.scrollTop = terminal.scrollHeight;
}

function terminalPlain(text: string, className = ""): void {
  appendTerminalLine([{ text }], className);
}

/** Scenes generated live through the UI, keyed by a "live:<rootRelativePath>" virtual path — not part of the build-time glob, so they need their own lookup. */
const dynamicScenes = new Map<string, Scene>();

const sceneFiles = Object.keys(sceneModules).sort();
for (const path of sceneFiles) {
  const option = document.createElement("option");
  option.value = path;
  option.textContent = path.split("/").pop()!;
  select.appendChild(option);
}

let renderer: THREE.WebGLRenderer | null = null;
let animationHandle = 0;
let replayHandle = 0;
let currentMeshesById = new Map<string, THREE.Mesh>();
let currentTrace: TraceFile | null = null;
let currentScene: Scene | null = null;
let currentScenePath = "";

function loadScene(path: string): Scene {
  if (dynamicScenes.has(path)) return dynamicScenes.get(path)!;
  return SceneSchema.parse(sceneModules[path]);
}

/** Project-root-relative path (e.g. "scenes/example-platformer.json") regardless of whether the scene came from the static glob or a live /api/generate call. */
function toProjectRelativeScenePath(path: string): string {
  if (path.startsWith("live:")) return path.slice("live:".length);
  return path.replace(/^(\.\.\/)+/, "");
}

/** Most recently finished trace for a given scene id, if any (a scene can have several traces across runs). */
function findLatestTrace(sceneId: string): TraceFile | null {
  const matches = traces.filter((t) => t.sceneId === sceneId);
  if (matches.length === 0) return null;
  return matches.reduce((latest, t) => (t.finishedAt > latest.finishedAt ? t : latest));
}

function showVerdict(trace: TraceFile | null): void {
  if (!trace) {
    replayBtn.style.display = "none";
    verdictEl.textContent = "";
    return;
  }
  replayBtn.style.display = "";
  const ok = trace.verdict.status === "success";
  verdictEl.textContent = ok ? "✓ SUCCESS" : `✗ FAIL (${trace.verdict.status === "fail" ? trace.verdict.reason : trace.verdict.status})`;
  verdictEl.style.color = ok ? "#2ecc71" : "#e74c3c";
}

function buildMesh(obj: SceneObject): THREE.Mesh {
  const width = obj.shape.kind === "box" ? obj.shape.width : obj.shape.radius * 2;
  const height = obj.shape.kind === "box" ? obj.shape.height : obj.shape.radius * 2;
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.MeshBasicMaterial({
    map: getPixelTexture(obj, width, height),
    transparent: true,
    alphaTest: 0.5,
    opacity: obj.sensor ? 0.85 : 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(obj.position.x, obj.position.y, obj.sensor ? 1 : 0);
  mesh.userData["id"] = obj.id;
  return mesh;
}

function renderStars(filled: number): void {
  ratingStars.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const star = document.createElement("span");
    const isFilled = i <= filled;
    star.textContent = isFilled ? "★" : "☆";
    star.className = isFilled ? "filled" : "";
    star.addEventListener("click", () => void submitRating(i));
    ratingStars.appendChild(star);
  }
}

async function submitRating(rating: number): Promise<void> {
  if (!currentScene) return;
  ratingStatus.textContent = "Saving…";
  try {
    const res = await fetch("/api/rate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sceneId: currentScene.id, prompt: currentScene.prompt, scenePath: currentScenePath, rating }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    renderStars(rating);
    ratingStatus.textContent = `Rated ${rating}/5 — added to the retrieval library.`;
    await refreshPolicyState();
  } catch (err) {
    ratingStatus.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

interface PolicyEntry {
  sceneId: string;
  prompt: string;
  attempts: number;
  rAuto: number;
  rHuman: number | null;
  createdAt: string;
}

async function refreshPolicyState(): Promise<void> {
  try {
    const res = await fetch("/api/policy-state");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);
    const entries = data.entries as PolicyEntry[];
    const rated = entries.filter((e) => e.rHuman !== null);
    policySummary.textContent = `${entries.length} generation(s) recorded, ${rated.length} rated so far.`;

    const mine = currentScene ? entries.find((e) => e.sceneId === currentScene!.id) : undefined;
    if (mine && mine.rHuman !== null) renderStars(Math.round(mine.rHuman * 4) + 1);
  } catch {
    policySummary.textContent = "Policy state unavailable.";
  }
}

interface Exemplar {
  prompt: string;
  similarity: number;
  reward: number;
  score: number;
  weight: number;
}

function renderExemplars(exemplars: Exemplar[]): void {
  policyExemplars.innerHTML = "";
  if (exemplars.length === 0) {
    const note = document.createElement("div");
    note.className = "small-status";
    note.textContent = "No rated examples were similar enough (or none rated yet) — generated from the base prompt alone.";
    policyExemplars.appendChild(note);
    return;
  }
  const title = document.createElement("div");
  title.className = "small-status";
  title.textContent = `Used as context for the last generation:`;
  policyExemplars.appendChild(title);
  for (const ex of exemplars) {
    const row = document.createElement("div");
    row.className = "exemplar-row";
    const promptEl = document.createElement("div");
    promptEl.className = "exemplar-prompt";
    promptEl.textContent = `"${ex.prompt}"`;
    const scoresEl = document.createElement("div");
    scoresEl.className = "exemplar-scores";
    scoresEl.textContent = `sim=${ex.similarity.toFixed(2)} reward=${ex.reward.toFixed(2)} score=${ex.score.toFixed(2)} weight=${(ex.weight * 100).toFixed(0)}%`;
    row.appendChild(promptEl);
    row.appendChild(scoresEl);
    policyExemplars.appendChild(row);
  }
}

/** Renders a scene statically, then wires up trace replay if a matching trace exists. */
function render(path: string): void {
  cancelAnimationFrame(animationHandle);
  cancelAnimationFrame(replayHandle);
  container.innerHTML = "";
  const scene = loadScene(path);
  currentScene = scene;
  currentScenePath = toProjectRelativeScenePath(path);

  const threeScene = new THREE.Scene();
  threeScene.background = new THREE.Color("#141414");

  const meshesById = new Map<string, THREE.Mesh>();
  for (const obj of scene.objects) {
    const mesh = buildMesh(obj);
    threeScene.add(mesh);
    meshesById.set(obj.id, mesh);
  }

  const margin = 80;
  const frustumWidth = scene.bounds.width + margin * 2;
  const frustumHeight = scene.bounds.height + margin * 2;
  const camera = new THREE.OrthographicCamera(-margin, scene.bounds.width + margin, scene.bounds.height + margin, -margin, -1000, 1000);
  camera.position.z = 10;

  renderer?.dispose();
  renderer = new THREE.WebGLRenderer({ antialias: true });
  const maxDim = 900;
  const scale = Math.min(1, maxDim / Math.max(frustumWidth, frustumHeight));
  renderer.setSize(frustumWidth * scale, frustumHeight * scale);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  status.textContent = `"${scene.prompt}" — objective: ${scene.objective.type} → ${scene.objective.target}`;

  currentMeshesById = meshesById;
  currentTrace = findLatestTrace(scene.id);
  showVerdict(currentTrace);

  renderStars(0);
  ratingStatus.textContent = "How well does it match what you asked for?";
  void refreshPolicyState();

  const animate = () => {
    animationHandle = requestAnimationFrame(animate);
    renderer!.render(threeScene, camera);
  };
  animate();
}

/** Replays a trace's recorded per-tick snapshots onto the currently-built meshes, at ~sim speed. */
function playTrace(trace: TraceFile): void {
  cancelAnimationFrame(replayHandle);
  const snapshots = trace.snapshots;
  const msPerTick = 1000 / 60;
  let index = 0;
  let lastTime: number | null = null;
  let accumulator = 0;

  const tick = (now: number) => {
    if (lastTime === null) lastTime = now;
    accumulator += now - lastTime;
    lastTime = now;
    while (accumulator >= msPerTick && index < snapshots.length) {
      const snapshot = snapshots[index]!;
      for (const [id, mesh] of currentMeshesById) {
        const obj = snapshot.objects[id];
        if (!obj) continue;
        mesh.position.set(obj.position.x, obj.position.y, mesh.position.z);
        mesh.rotation.z = obj.angle;
      }
      index++;
      accumulator -= msPerTick;
    }
    if (index < snapshots.length) replayHandle = requestAnimationFrame(tick);
  };
  replayHandle = requestAnimationFrame(tick);
}

replayBtn.addEventListener("click", () => {
  if (currentTrace) playTrace(currentTrace);
});

interface StreamDecisionEvent {
  type: "decision";
  decision: { decisionIndex: number; tick: number; action: string; reasoning: string | null };
  stepsRemaining: number;
  decisionBudget: number;
}
type StreamEvent = StreamDecisionEvent | { type: "done"; trace: TraceFile } | { type: "error"; error: string };

traverseBtn.addEventListener("click", async () => {
  if (!currentScene) return;
  traverseBtn.disabled = true;
  const originalLabel = traverseBtn.textContent;
  traverseBtn.textContent = "Traversing…";
  status.textContent = "Agent is attempting the scene — one live API call per decision, capped at 60 for this button.";

  terminal.innerHTML = "";
  terminalPlain(`$ traverse ${currentScenePath}`, "t-cmd");

  try {
    const res = await fetch("/api/traverse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenePath: currentScenePath }),
    });
    if (!res.ok || !res.body) throw new Error(`Traverse request failed (${res.status})`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalTrace: TraceFile | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as StreamEvent;
        if (msg.type === "decision") {
          const d = msg.decision;
          appendTerminalLine([
            { text: `[${d.decisionIndex + 1}/${msg.decisionBudget}] `, className: "t-index" },
            { text: `tick=${d.tick} ` },
            { text: d.action, className: "t-action" },
            { text: d.reasoning ? ` — ${d.reasoning}` : "", className: "t-reason" },
          ]);
        } else if (msg.type === "done") {
          finalTrace = msg.trace;
        } else if (msg.type === "error") {
          throw new Error(msg.error);
        }
      }
    }

    if (!finalTrace) throw new Error("Stream ended without a result");
    traces.push(finalTrace);
    currentTrace = finalTrace;
    showVerdict(finalTrace);
    const ok = finalTrace.verdict.status === "success";
    terminalPlain(ok ? "$ SUCCESS" : `$ FAIL (${finalTrace.verdict.status === "fail" ? finalTrace.verdict.reason : finalTrace.verdict.status})`, ok ? "t-success" : "t-fail");
    status.textContent = `"${currentScene.prompt}" — objective: ${currentScene.objective.type} → ${currentScene.objective.target}`;
    playTrace(finalTrace);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    status.textContent = `Traverse error: ${message}`;
    terminalPlain(`$ error: ${message}`, "t-fail");
  } finally {
    traverseBtn.disabled = false;
    traverseBtn.textContent = originalLabel;
  }
});

select.addEventListener("change", () => render(select.value));

generateBtn.addEventListener("click", async () => {
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  generateBtn.disabled = true;
  generateStatus.textContent = "Generating scene…";
  policyExemplars.innerHTML = "";

  try {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, lambda: Number(lambdaSlider.value), tau: Number(tauSlider.value) }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const scene = SceneSchema.parse(data.scene);
    const virtualPath = `live:${data.scenePath}`;
    dynamicScenes.set(virtualPath, scene);

    const option = document.createElement("option");
    option.value = virtualPath;
    option.textContent = `${String(data.scenePath).split("/").pop()} (generated)`;
    select.appendChild(option);
    select.value = virtualPath;
    render(virtualPath);

    const attempts = data.attempts as number;
    generateStatus.textContent = `Done — ${attempts} attempt${attempts > 1 ? "s" : ""}.`;
    renderExemplars(data.retrievedExemplars as Exemplar[]);
  } catch (err) {
    generateStatus.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    generateBtn.disabled = false;
  }
});

renderRetrievalEquations();

if (sceneFiles.length > 0) {
  select.value = sceneFiles[0]!;
  render(sceneFiles[0]!);
} else {
  status.textContent = "No scenes found in scenes/. Run `npm run generate` first.";
}
