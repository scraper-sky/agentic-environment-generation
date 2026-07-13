import * as THREE from "three";
import katex from "katex";
import "katex/dist/katex.min.css";
import { SceneSchema, type Scene, type SceneObject } from "../schema/scene.js";
import type { TraceFile, DecisionLog } from "../harness/traverse.js";
import { getPixelTexture } from "./pixelSprites.js";
import { applyAction, createWorld, getSnapshot, step, type SimSnapshot, type SimWorld } from "../engine/simulation.js";
import { checkObjective, type ObjectiveResult } from "../engine/objectives.js";

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
const playBtn = document.querySelector<HTMLButtonElement>("#play-btn")!;
const stopPlayBtn = document.querySelector<HTMLButtonElement>("#stop-play-btn")!;
const replayBtn = document.querySelector<HTMLButtonElement>("#replay-btn")!;
const exportBtn = document.querySelector<HTMLButtonElement>("#export-btn")!;
const recordsList = document.querySelector<HTMLDivElement>("#records-list")!;
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
const chatLog = document.querySelector<HTMLDivElement>("#chat-log")!;
const chatInput = document.querySelector<HTMLInputElement>("#chat-input")!;
const chatSendBtn = document.querySelector<HTMLButtonElement>("#chat-send-btn")!;
const chatStatus = document.querySelector<HTMLDivElement>("#chat-status")!;

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

/**
 * `/api/*` only exists in `vite dev` (see vite.config.ts's `configureServer`
 * plugin) — a static build (e.g. GitHub Pages) has no server behind it, so
 * these routes 404. Detected once at startup so Generate/Agent/Edit/Rate can
 * be clearly disabled with an explanation instead of silently failing on
 * click, which would otherwise look like a bug rather than "this needs a
 * local server". Play mode and Replay need no backend and stay fully live.
 */
let apiAvailable = true;
async function checkApiAvailability(): Promise<boolean> {
  try {
    const res = await fetch("/api/policy-state");
    if (!res.ok) return false;
    // Some static-file servers (including `vite preview` itself) return 200
    // with index.html for any unmatched path (SPA fallback) rather than a
    // real 404 — checking status alone would misread that as "API present".
    // Parsing as JSON and checking the real shape catches that case too.
    const data: unknown = await res.json();
    return typeof data === "object" && data !== null && (data as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

let playHandle = 0;
let playSim: SimWorld | null = null;
let playSnapshots: Array<{ tick: number; objects: SimSnapshot }> = [];
let playDecisions: DecisionLog[] = [];
let playLastAction = "";
let playStartedAt = "";
const pressedKeys = new Set<string>();

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}
let chatHistory: ChatTurn[] = [];

function appendChatLine(text: string, className: string): void {
  const line = document.createElement("div");
  line.className = `chat-line ${className}`;
  line.textContent = text;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function resetChat(): void {
  chatHistory = [];
  chatLog.innerHTML =
    '<div class="chat-line chat-placeholder">Select or generate a scene, then describe a change — e.g. "move the flag closer" or "add a spike hazard near the gap."</div>';
}

async function sendEdit(): Promise<void> {
  const instruction = chatInput.value.trim();
  if (!instruction || !currentScene) return;
  if (!apiAvailable) {
    chatStatus.textContent = "This is a static preview — editing needs a local server. Run `npm run dev` (see README).";
    return;
  }
  chatInput.value = "";
  chatSendBtn.disabled = true;
  appendChatLine(instruction, "chat-user");
  chatStatus.textContent = "Editing…";

  try {
    const res = await fetch("/api/edit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scene: currentScene, instruction, history: chatHistory }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const scene = SceneSchema.parse(data.scene);
    const virtualPath = `live:${data.scenePath}`;
    dynamicScenes.set(virtualPath, scene);

    const option = document.createElement("option");
    option.value = virtualPath;
    option.textContent = `${String(data.scenePath).split("/").pop()} (edited)`;
    select.appendChild(option);
    select.value = virtualPath;
    render(virtualPath, { resetChatLog: false });

    const attempts = data.attempts as number;
    chatHistory.push({ role: "user", content: instruction });
    chatHistory.push({ role: "assistant", content: `Updated the scene (${attempts} attempt${attempts > 1 ? "s" : ""}).` });
    chatHistory = chatHistory.slice(-12); // bounded context, mirrors recentActions elsewhere in this project

    appendChatLine(`Updated — ${attempts} attempt${attempts > 1 ? "s" : ""}.`, "chat-assistant");
    chatStatus.textContent = "";
  } catch (err) {
    appendChatLine(err instanceof Error ? err.message : String(err), "chat-error");
    chatStatus.textContent = "";
  } finally {
    chatSendBtn.disabled = false;
  }
}

chatSendBtn.addEventListener("click", () => void sendEdit());
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void sendEdit();
});

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
  verdictEl.textContent = ok ? "✓ SUCCESS" : "✗ FAILED";
  verdictEl.style.color = ok ? "#2ecc71" : "#e74c3c";
}

/** Client-side download — no backend involved, so this works identically in local dev and on the static (no-API) Pages build, which is the one place a completed recording can't be persisted server-side via /api/save-trace. */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Every scene known this session — bundled at build time plus anything generated/edited live — so "past records" always reflects what's actually loadable right now. */
function allKnownScenePaths(): string[] {
  return [...sceneFiles, ...dynamicScenes.keys()];
}

function renderRecordsList(): void {
  recordsList.innerHTML = "";
  const paths = allKnownScenePaths();
  if (paths.length === 0) {
    recordsList.innerHTML = '<div class="record-empty">No scenes yet.</div>';
    return;
  }
  for (const path of paths) {
    let scene: Scene;
    try {
      scene = loadScene(path);
    } catch {
      continue;
    }
    const trace = findLatestTrace(scene.id);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "record-row" + (path === select.value ? " active" : "");
    const promptSpan = document.createElement("span");
    promptSpan.className = "record-prompt";
    promptSpan.textContent = scene.prompt || path.split("/").pop()!;
    row.appendChild(promptSpan);
    if (trace) {
      const verdictSpan = document.createElement("span");
      const ok = trace.verdict.status === "success";
      verdictSpan.className = `record-verdict ${ok ? "ok" : "fail"}`;
      verdictSpan.textContent = ok ? "✓" : "✗";
      row.appendChild(verdictSpan);
    }
    row.addEventListener("click", () => {
      select.value = path;
      render(path);
    });
    recordsList.appendChild(row);
  }
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
  if (!apiAvailable) {
    ratingStatus.textContent = "This is a static preview — rating needs a local server. Run `npm run dev` (see README).";
    return;
  }
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

/** Renders a scene statically, then wires up trace replay if a matching trace exists. `resetChatLog` is false when this render is itself the result of an edit, so the conversation keeps building on the same lineage instead of clearing. */
function render(path: string, options: { resetChatLog?: boolean } = {}): void {
  cancelAnimationFrame(animationHandle);
  cancelAnimationFrame(replayHandle);
  cancelAnimationFrame(playHandle);
  window.removeEventListener("keydown", onPlayKeyDown);
  window.removeEventListener("keyup", onPlayKeyUp);
  pressedKeys.clear();
  playBtn.style.display = "";
  stopPlayBtn.style.display = "none";
  container.innerHTML = "";
  const scene = loadScene(path);
  currentScene = scene;
  currentScenePath = toProjectRelativeScenePath(path);
  if (options.resetChatLog ?? true) resetChat();

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
  // Fit to whatever space #app actually has (not a flat guess) — with the
  // chat sidebar + log sidebar + toolbar accounted for, a fixed cap like the
  // old 900px could exceed real available width, silently pushing the far
  // edge of the scene (and anything sitting there, like a goal flag) out of
  // view behind #app's overflow:auto instead of ever being visibly wrong.
  const appEl = container.parentElement as HTMLElement;
  const availableWidth = Math.max(200, appEl.clientWidth - 56);
  const availableHeight = Math.max(200, appEl.clientHeight - 56);
  const maxDim = 620;
  const scale = Math.min(1, maxDim / Math.max(frustumWidth, frustumHeight), availableWidth / frustumWidth, availableHeight / frustumHeight);
  renderer.setSize(frustumWidth * scale, frustumHeight * scale);
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  status.textContent = `"${scene.prompt}" — objective: ${scene.objective.type} → ${scene.objective.target}`;

  currentMeshesById = meshesById;
  currentTrace = findLatestTrace(scene.id);
  showVerdict(currentTrace);
  renderRecordsList();

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

exportBtn.addEventListener("click", () => {
  if (!currentScene) return;
  downloadJson(`${currentScene.id}.json`, currentScene);
  if (currentTrace) {
    downloadJson(`${currentScene.id}-trace-${Date.parse(currentTrace.finishedAt) || Date.now()}.json`, currentTrace);
  }
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
  if (!apiAvailable) {
    terminalPlain("$ static preview — Agent needs a local server. Run `npm run dev` (see README). Try Play or Replay instead.", "t-placeholder");
    return;
  }
  traverseBtn.disabled = true;
  const originalLabel = traverseBtn.textContent;
  traverseBtn.textContent = "Traversing…";
  status.textContent = "Agent is playing; check agent traversal log below";

  terminal.innerHTML = "";
  terminalPlain(`$ traverse ${currentScenePath}`, "t-cmd");

  try {
    const res = await fetch("/api/traverse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Sent alongside scenePath (not instead of it) so this same request
      // works against both backends: local dev reads scenePath from a real
      // scenes/ folder on disk, while the Vercel deploy has no persistent
      // disk between requests and uses the scene object directly instead.
      body: JSON.stringify({ scenePath: currentScenePath, scene: currentScene }),
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
    renderRecordsList();
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

const PLAY_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "KeyA", "KeyD", "KeyW", "KeyS", "Space"]);

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function onPlayKeyDown(e: KeyboardEvent): void {
  if (isTypingTarget(e.target)) return;
  if (!PLAY_KEYS.has(e.code)) return;
  e.preventDefault();
  pressedKeys.add(e.code);
}

function onPlayKeyUp(e: KeyboardEvent): void {
  if (!PLAY_KEYS.has(e.code)) return;
  pressedKeys.delete(e.code);
}

function actionFromKeys(controls: Scene["player"]["controls"]): string {
  if (controls === "platformer") {
    if (pressedKeys.has("ArrowLeft") || pressedKeys.has("KeyA")) return "left";
    if (pressedKeys.has("ArrowRight") || pressedKeys.has("KeyD")) return "right";
    return "noop";
  }
  if (pressedKeys.has("ArrowUp") || pressedKeys.has("KeyW")) return "up";
  if (pressedKeys.has("ArrowDown") || pressedKeys.has("KeyS")) return "down";
  if (pressedKeys.has("ArrowLeft") || pressedKeys.has("KeyA")) return "left";
  if (pressedKeys.has("ArrowRight") || pressedKeys.has("KeyD")) return "right";
  return "noop";
}

/** One physics tick of manual play: reads currently-held keys, steps the sim, mirrors the resulting positions onto the live meshes (the render() animate loop is already running and just needs fresh mesh transforms to draw), and records the tick the same way a trace does so the session can be saved and replayed like any agent run. Returns true once the run has ended. */
function stepPlayTick(): boolean {
  if (!playSim || !currentScene) return true;
  const controls = currentScene.player.controls;
  const action = actionFromKeys(controls);
  applyAction(playSim, controls, action);
  if (controls === "platformer" && (pressedKeys.has("Space") || pressedKeys.has("ArrowUp") || pressedKeys.has("KeyW"))) {
    applyAction(playSim, controls, "jump");
  }
  if (action !== playLastAction) {
    playDecisions.push({ decisionIndex: playDecisions.length, tick: playSim.tick, action, reasoning: null });
    playLastAction = action;
  }
  step(playSim);
  const snapshot = getSnapshot(playSim);
  playSnapshots.push({ tick: playSim.tick, objects: snapshot });
  for (const [id, mesh] of currentMeshesById) {
    const obj = snapshot[id];
    if (!obj) continue;
    mesh.position.set(obj.position.x, obj.position.y, mesh.position.z);
    mesh.rotation.z = obj.angle;
  }
  const verdict = checkObjective(playSim, currentScene);
  if (verdict.status !== "running") {
    finishPlay(verdict);
    return true;
  }
  if (playSim.tick >= currentScene.maxSteps) {
    finishPlay({ status: "fail", reason: "timeout" });
    return true;
  }
  return false;
}

function startPlay(): void {
  if (!currentScene) return;
  cancelAnimationFrame(replayHandle);
  cancelAnimationFrame(playHandle);

  playSim = createWorld(currentScene);
  playSnapshots = [{ tick: 0, objects: getSnapshot(playSim) }];
  playDecisions = [];
  playLastAction = "";
  playStartedAt = new Date().toISOString();
  pressedKeys.clear();

  playBtn.style.display = "none";
  stopPlayBtn.style.display = "";
  traverseBtn.disabled = true;
  replayBtn.disabled = true;
  select.disabled = true;
  generateBtn.disabled = true;
  chatSendBtn.disabled = true;
  verdictEl.textContent = "";
  status.textContent =
    currentScene.player.controls === "platformer"
      ? "Play mode: ←/→ or A/D to move, Space/↑ to jump."
      : "Play mode: arrow keys or WASD to move.";

  window.addEventListener("keydown", onPlayKeyDown);
  window.addEventListener("keyup", onPlayKeyUp);

  const msPerTick = 1000 / 60;
  let lastTime: number | null = null;
  let accumulator = 0;
  const loop = (now: number) => {
    if (lastTime === null) lastTime = now;
    accumulator += now - lastTime;
    lastTime = now;
    while (accumulator >= msPerTick) {
      accumulator -= msPerTick;
      if (stepPlayTick()) return;
    }
    playHandle = requestAnimationFrame(loop);
  };
  playHandle = requestAnimationFrame(loop);
}

async function savePlayTrace(verdict: ObjectiveResult): Promise<void> {
  if (!currentScene) return;
  const trace: TraceFile = {
    sceneId: currentScene.id,
    scenePath: currentScenePath,
    prompt: currentScene.prompt,
    model: "human",
    startedAt: playStartedAt,
    finishedAt: new Date().toISOString(),
    verdict,
    decisions: playDecisions,
    snapshots: playSnapshots,
  };
  traces.push(trace);
  currentTrace = trace;
  showVerdict(trace);
  renderRecordsList();

  if (!apiAvailable) {
    // No backend to persist to (e.g. the static Pages build) — the recording
    // is still fully usable this session (shows up in "past records", can be
    // replayed, can be downloaded via Export), it just isn't written to a
    // local traces/ folder that doesn't exist here. Say that plainly instead
    // of attempting the fetch and surfacing a raw "Failed to fetch".
    status.textContent =
      (verdict.status === "success" ? "You reached the goal. " : "Run ended. ") + "Static preview — use Export to save this recording as a file.";
    return;
  }

  status.textContent = verdict.status === "success" ? "You reached the goal." : "Run ended — replay it or try again.";
  try {
    const res = await fetch("/api/save-trace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trace }),
    });
    if (!res.ok) throw new Error(`save failed (${res.status})`);
  } catch (err) {
    status.textContent = `Recording not saved to disk: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function finishPlay(verdict: ObjectiveResult): void {
  cancelAnimationFrame(playHandle);
  window.removeEventListener("keydown", onPlayKeyDown);
  window.removeEventListener("keyup", onPlayKeyUp);
  pressedKeys.clear();

  playBtn.style.display = "";
  stopPlayBtn.style.display = "none";
  traverseBtn.disabled = false;
  replayBtn.disabled = false;
  select.disabled = false;
  generateBtn.disabled = false;
  chatSendBtn.disabled = false;

  void savePlayTrace(verdict);
}

playBtn.addEventListener("click", startPlay);

stopPlayBtn.addEventListener("click", () => {
  if (!playSim || !currentScene) return;
  const verdict = checkObjective(playSim, currentScene);
  finishPlay(verdict.status === "running" ? { status: "fail", reason: "stopped-early" } : verdict);
});

window.addEventListener("blur", () => pressedKeys.clear());

select.addEventListener("change", () => render(select.value));

generateBtn.addEventListener("click", async () => {
  if (!apiAvailable) {
    generateStatus.textContent = "This is a static preview — Generate needs a local server. Run `npm run dev` (see README).";
    return;
  }
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
    const motif = data.motif as string | undefined;
    generateStatus.textContent = `Done — ${attempts} attempt${attempts > 1 ? "s" : ""}${motif ? ` · layout: ${motif}` : ""}.`;
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
  renderRecordsList();
}

let resizeHandle = 0;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeHandle);
  resizeHandle = window.setTimeout(() => {
    if (select.value) render(select.value, { resetChatLog: false });
  }, 150);
});

void (async () => {
  apiAvailable = await checkApiAvailability();
  if (apiAvailable) return;

  // No backend (e.g. a static GitHub Pages build) — gray out the
  // API-dependent controls up front and say why, rather than leaving them
  // clickable and failing confusingly on first use. Play and Replay need no
  // backend and are left fully working.
  generateBtn.disabled = true;
  generateBtn.title = "Static preview — run `npm run dev` locally for live generation.";
  generateStatus.textContent = "Static preview: Generate needs a local server (`npm run dev`) with an OpenAI key. Try Play or Replay on the scenes above instead.";

  traverseBtn.disabled = true;
  traverseBtn.title = "Static preview — run `npm run dev` locally for the live agent.";

  chatSendBtn.disabled = true;
  chatInput.disabled = true;
  chatInput.placeholder = "Static preview — run npm run dev locally to edit scenes";
  chatStatus.textContent = "Static preview: editing needs a local server (`npm run dev`) with an OpenAI key.";
})();
