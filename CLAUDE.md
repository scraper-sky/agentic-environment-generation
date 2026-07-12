# General Intuition — Tech Challenge: Infinite Environment Generation via an Agent Harness

## Goal
Build an agent harness that reliably constructs environments from text commands — scenes inside a game or physics engine — and can maneuver through the environments it generates.

Start in 2D to prove the agent can generate and progress through environments before considering a 3D port.

## Deliverable
- A working agent harness, runnable in an execution context of choice (Claude Code, Codex, or other).
- Accepts text-based commands as input.
- Produces playable environments in a game or physics engine.
- May be solved entirely at the prompt level, or via a custom-built physics engine — creative freedom is explicit in the brief.

## Context: the vision-based policy (not available to us)
General Intuition's internal vision-based policy is mounted on a game object inside the engine. It observes rendered frames and outputs controller-style actions: move forward, move backward, move left, move right, mouse delta X, mouse delta Y. We do not have access to it, which is why 2D is the recommended starting point — 3D navigation depends on that policy, whereas Claude-style agents can progress through 2D environments on their own.

## Why this matters (their framing)
- **Post-training environments**: a large supply of diverse environments for training/evaluating their vision-based policy against specific goals and rewards.
- **Code-level objectives**: because environments are code-defined, objectives can be verified programmatically (e.g. "picked up the can from the table") instead of relying on a VLM judging pixels.
- **Reward model training**: generate many environments in code space, train a reward model on programmatic signals, then transfer that reward model to pixel-based observation.

## Evaluation criteria
1. **Creativity** — how the problem space is opened and which approach is chosen.
2. **Clarity** — self-explanatory; reviewers won't spend hours on it, so it must be immediately clear and digestible.
3. **Working output** — an actually runnable harness with clear instructions.

Promising submissions get a follow-up call with the research team.

## Submission
Email paula@generalintuition.com — subject line `Tech Challenge – [Your Name]`. Response expected within ~1 week.

---
*This file is project-direction context for anyone (human or agent) working in this directory. Treat it as the spec of record; do not treat it as already-decided implementation — approach/architecture is still open.*
