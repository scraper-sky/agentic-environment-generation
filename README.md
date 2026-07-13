# Agentic Environment Generation

An agent harness that turns a text command into a playable 2D physics scene, and a second agent that autonomously plays it — with success/failure decided by code, not by a human or a vision model looking at pixels.

Built for the General Intuition "Infinite Environment Generation via an Agent Harness" tech challenge (see `CLAUDE.md`).

## Start here if you're short on time

The core deliverable is the two-CLI loop: **`generate`** (text → scene) and **`traverse`** (scene → autonomous agent → pass/fail, verified in code, never pixels). That's the direct answer to the brief. Everything from "Feedback-driven generation" onward in this README — retrieval-policy tuning, the live terminal, the reward-signal demo — was built on top of that core loop during follow-up iteration; it's real and working, but it's exploratory, not required to evaluate the harness itself.

Fastest path to see it work: `npm install && npm run dev`, open the printed URL, pick `example-platformer.json` from the dropdown, click **Replay trace**.

## What this is

Two small CLIs sharing one engine:

- **`generate`** — text prompt → OpenAI (Structured Outputs) → a validated scene (JSON) → written to `scenes/`.
- **`traverse`** — scene → a second OpenAI-powered agent that reads the scene's *game state* (never pixels) and issues one discrete action per decision, physics-simulated headlessly, until it succeeds, fails, or times out. Writes a full per-tick trace to `traces/` and exits with code `0` (success) or `1` (failure) — scriptable, no eyeballing required.

A small Three.js viewer (`npm run dev`) renders any scene as pixel-art sprites (not flat shapes), replays a recorded trace, and lets you generate *and* traverse scenes right from the page — no CLI needed. It also has a rating widget and a live view into a reward-weighted retrieval loop, with its two parameters tunable by slider, so your ratings visibly and adjustably influence future generations (see below).

The repo ships with two hand-authored example scenes and their (real, generated) passing traces committed, so `npm run dev` shows working output immediately, with no API key needed. Generating and traversing your own scenes does need an OpenAI key.

## Why it's built this way

- **Objectives are data, never code.** A scene's goal is one of two declarative types (`reach`, `collect`) plus a `hazards` list — never LLM-generated executable logic. This is the direct answer to the brief's ask for code-level, verifiable objectives instead of a VLM judging pixels: `checkObjective()` (`src/engine/objectives.ts`) is a small deterministic function with no `eval` and no injection surface.
- **The simulation is render-agnostic.** `src/engine/simulation.ts` wraps `matter-js` with zero DOM/Three.js imports, so the exact same physics runs identically in the headless `traverse` CLI and in the browser viewer. Three.js only ever reads simulation snapshots and draws them — it never touches physics.
- **One schema drives everything.** `src/schema/scene.ts` is a Zod schema used for (a) TypeScript types, (b) runtime validation, and (c) constraining the LLM's output directly via OpenAI's `zodResponseFormat()` — there's no separate "prompt describing the JSON shape" that can drift from what's actually validated.
- **2D via Three.js now, 3D-portable by design — untested claim, not a demonstrated result.** Rendering uses an `OrthographicCamera` + planes/circles; going 3D would mean swapping the camera and geometry (and, separately, the physics engine to something like Rapier3D) without touching the scene schema, objective logic, or harness CLIs. That's the design intent behind keeping `simulation.ts` free of any Three.js import — this repo does not actually exercise a 3D port, and the brief frames 3D as optional ("if your approach works, you *may* transfer it"), so this is deliberately left as a documented boundary rather than implemented.

## Setup

```bash
npm install
cp .env.example .env
# edit .env and set OPENAI_API_KEY=sk-...
```

## Run it

```bash
# View the two committed example scenes (no API key required)
npm run dev
# -> open the printed local URL, pick a scene from the dropdown,
#    click "Replay trace" to watch the recorded agent run, or "Traverse" to
#    run the agent live and get a fresh trace (requires OPENAI_API_KEY).
#    Type a prompt in the sidebar and click "Generate" to create a new scene
#    right from the page (requires OPENAI_API_KEY) — no CLI needed.

# Generate a new scene from a text prompt via the CLI instead (requires OPENAI_API_KEY)
npm run generate -- "A platformer with three gaps and a spike hazard on the last platform"

# Have an agent autonomously attempt a scene (requires OPENAI_API_KEY)
npm run traverse -- scenes/<the-file-you-just-generated>.json

# Or run both example prompts through the full generate -> traverse pipeline in one command
npm run demo

npm run typecheck
```

`traverse` exits `0` on success and `1` on failure/timeout, and prints a one-line verdict — e.g.:

```
$ npm run traverse -- scenes/example-platformer.json
Traversing scenes/example-platformer.json (model: gpt-4o)
Wrote trace to traces/example-platformer-1730000000000.json
Decisions: 38, ticks: 303
VERDICT: SUCCESS
```

## Scene schema, in brief

```ts
interface Scene {
  bounds: { width: number; height: number };
  gravity: { x: number; y: number };           // [0,0] topdown, e.g. [0,-1] platformer
  player: { objectId: string; controls: "platformer" | "topdown" };
  objects: SceneObject[];                        // boxes/circles, static/dynamic, optional sensor
  objective: { type: "reach"; target: string; radius: number }
           | { type: "collect"; target: string; near: string | null; radius: number; nearRadius: number | null };
  hazards: string[];                             // object ids — touch = instant fail
  maxSteps: number;                               // physics-tick budget before a timeout fail
}
```

Full definition with field-level docs: `src/schema/scene.ts`. The LLM-facing contract (what `generate` actually asks the model for) is `GeneratedSceneSchema` in the same file; the system prompt explaining units/coordinates/vocabulary to the model is `src/harness/prompts/generate.system.md`.

## How the traversal agent decides what to do

Each decision, the agent receives a compact JSON state (not pixels): its position/velocity, the objective's position and distance, hazard positions/distances, remaining step budget, and its own last few actions (so it can notice if it's stuck oscillating). The signals that matter most are computed by short physics raycasts, not by asking the LLM to reason about raw geometry — two *different* obstacle types get two different signals per control scheme, found the hard way by watching real runs fail:

- **Platformer**: `groundAheadRight`/`groundAheadLeft` (is the floor about to disappear — a gap?) and, separately, `wallAheadRight`/`wallAheadLeft` (is something solid — a tree, a pillar — standing directly in the path on otherwise-continuous ground?). The first covers falling, the second covers walking into an obstacle; conflating them was a real bug (an agent could see continuous ground and never realize a tree was blocking it).
- **Topdown**: `blockedUp`/`blockedDown`/`blockedLeft`/`blockedRight` — is a wall immediately in that direction? Without this the agent has no way to detect it needs to detour around an obstacle.

The in-page **Traverse** button streams every decision live to a terminal-style panel as it happens (each decision is a real network round-trip, so this is actual progress, not a fake progress bar) — see `vite.config.ts`'s `/api/traverse` (newline-delimited JSON stream) and `traverse()`'s `onDecision` callback in `src/harness/traverse.ts`. That button caps at 60 decisions (~1–3 min worst case) so it doesn't leave you waiting indefinitely on a hard scene; `npm run traverse` via the CLI uses the scene's full `maxSteps` budget for a thorough, uncapped run.

The agent replies with exactly one action from a closed enum (`left`/`right`/`jump`/`noop` or `up`/`down`/`left`/`right`/`noop`), enforced the same way the scene schema is — via `zodResponseFormat` — so it can never emit anything outside the declared action space. See `src/harness/traverse.ts` and `src/harness/prompts/traverse.system.md`.

## Feedback-driven generation

Rate a scene (1–5 stars, in the viewer sidebar) and it measurably changes future generations — not via fine-tuning, but reward-weighted retrieval: a growing library of `(prompt, scene, reward)` triples, re-ranked per new prompt and injected as few-shot context. `src/policy/feedback.ts` is the whole mechanism; nothing here is a mockup of the equation, it's the equation.

**Reward** combines two signals — what you rated (dominant) and a free automatic-quality proxy (did the scene validate cleanly, i.e. how many repair-loop attempts it took):

```
reward = 0.7 · r_human + 0.3 · r_auto
```

**Retrieval**, for a new prompt `p`, scores every rated library entry by a mix of topical relevance and past reward, then turns that into a soft (not hard-cutoff) weighting:

```
score_i  = λ · sim(p, prompt_i) + (1 − λ) · reward_i        (λ = 0.6, favors relevance)
weight_i = softmax(score_i / τ)                              (τ = 0.2)
```

The top-scored exemplars (their actual past prompt + the scene JSON that was generated for it) get spliced into the system prompt as few-shot examples for the next generation. The viewer's "Retrieval policy" panel shows this happening for real, as rendered LaTeX (via KaTeX) — which exemplars were pulled for your last generation, and their similarity/reward/score/weight — not just the equation described in prose. Both `λ` and `τ` are sliders in that same panel, sent with every generate request — drag `λ` toward 0 to chase reward over relevance, or `τ` up to flatten the weighting toward uniform, and watch the exemplar list/weights actually change.

**What `weight_i` actually is, precisely**: `w_i` is exemplar `i`'s share of total influence across the *whole* rated library (all `w_i` sum to 1) — a diagnostic of how dominant the top pick is versus the runner-ups, not a random-sampling probability. Which exemplars get used is deterministic: top-k by `score_i` (the same order `w_i` ranks them in, since softmax preserves rank), matching the rest of the project's bias toward reproducibility over stochasticity (traversal also runs at `temperature=0`).

This is intentionally *not* fine-tuning: no training job, no GPU, improves as soon as one rating exists, degrades gracefully to zero-shot generation when the library is empty. `feedback.json` (gitignored — it's local usage state, not project content) is the whole store; delete it to reset the policy to a blank slate.

## Reward signal from trace data

`checkObjective()` is binary — running/success/fail — which is the right shape for a hard verdict but not for training anything. `src/engine/reward.ts` turns a recorded trace into a continuous, per-tick reward signal, entirely from code-level ground truth (object positions each tick — no pixels):

```
r_t = Phi(s_t) - Phi(s_{t+1}),   Phi(s) = -distance_to_goal(s)
```

Potential-based reward shaping (Ng, Harada & Russell, 1999) — rewards any tick that reduces distance to the objective, plus a terminal bonus/penalty on success/hazard/timeout. It's provably policy-invariant (shaping this way doesn't change what the optimal policy *is*, only how fast it's findable), which is why this specific form and not an arbitrary heuristic.

```bash
npm run reward-demo              # every trace in traces/
npm run reward-demo -- traces/example-platformer-<timestamp>.json   # a specific one
```

prints a sparkline of distance-to-goal and shaped reward per trace, plus total/discounted return. Run it against whatever's in your `traces/` folder — successful runs show a clean monotonic distance decline and a clearly higher return than failed/timed-out ones, which is the actual point: it's a signal that visibly discriminates good runs from bad ones, the kind of thing a reward model would be trained on.

**What this deliberately does not do**: train a model. That needs real episode volume and a training loop, out of scope for this repo's timeframe — this computes the reward *function* a training pipeline would consume, and demonstrates it's a real, discriminating signal by running it against genuine traces rather than asserting it would work.

## Project layout

```
src/
  schema/            Zod scene + action schemas (shared contract: types, validation, LLM output format)
  engine/            matter-js wrapper, objective checking, semantic scene validation, reward shaping — no rendering, no OpenAI
  harness/           generate.ts / traverse.ts CLIs + their system prompts + the OpenAI client
  policy/            feedback.ts — the reward-weighted retrieval library + scoring equation
  viewer/            Vite + Three.js browser app: renders a scene, replays a trace, in-page generate + rate UI
vite.config.ts       Dev-only API (/api/generate, /api/rate, /api/traverse, /api/policy-state) backing the in-page UI
scenes/              Scene JSON files (two curated examples, plus real scenes generated along the way)
traces/              Recorded traversal runs matching whatever's in scenes/
feedback.json        Local ratings library (gitignored, created on first rating)
scripts/demo.ts      Runs both example prompts through generate -> traverse end to end
scripts/reward-demo.ts   Computes and prints the shaped-reward curve for recorded traces
```

## Relationship to the broader research goal

The brief names three things code-level procedural generation unlocks. Where this repo actually stands on each, plainly rather than by implication:

- **Code-level objectives, verified without a VLM** — built and working. `checkObjective()` (`src/engine/objectives.ts`) is exactly this: deterministic, decoupled from rendering entirely, no `eval`, no pixel judging.
- **Reward model training** — the *signal* is built (`src/engine/reward.ts`, `npm run reward-demo`, above), the *model* is not. Training one needs real episode volume and a training loop; this computes the reward function such a pipeline would consume, and shows it's a genuine discriminating signal against real traces rather than just asserting the idea.
- **Post-training environments at scale** — the pipeline produces genuinely diverse, validated, reachability-checked scenes from arbitrary prompts, not just the two committed examples. "Massive supply" implies a volume this repo hasn't actually been run at; nothing in the architecture blocks it, but that's a claim about design, not a demonstrated result.

3D was explicitly framed as optional in the brief ("if your approach works, you *may* transfer it") — this repo doesn't attempt it. `simulation.ts` having zero Three.js imports is meant to make that swap contained later, but that's design intent, not something exercised here.
