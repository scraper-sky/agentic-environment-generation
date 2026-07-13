/**
 * Structural scaffolds injected into generation on top of the prompt and any
 * retrieved exemplars. Two prompt-conditioned levers (retrieval + few-shot)
 * still collapse toward whatever shape the model defaults to for a given
 * theme — ask for "a forest platformer" ten times and you tend to get the
 * same two gaps and a tree. A motif is a short, control-agnostic spatial
 * pattern (borrowed from classic procedural-generation practice: Wave
 * Function Collapse composes levels from small local rules rather than one
 * global description; roguelike generators like Spelunky's pick from a
 * library of room templates per level) picked fresh each call so the same
 * prompt can still land on a different layout. It's a hint, not a spec — the
 * system prompt explicitly tells the model to adapt or drop it if it
 * conflicts with what was actually asked for.
 */
export interface Motif {
  name: string;
  description: string;
}

export const MOTIFS: Motif[] = [
  {
    name: "staircase-ascent",
    description:
      "Progress is mostly vertical: a sequence of platforms stepping upward, each gap within comfortable jump range of the last, goal near the top.",
  },
  {
    name: "gauntlet",
    description:
      "A single mostly-flat path interrupted by two or three evenly-spaced obstacles or hazards to get past one at a time, rather than one big combined challenge.",
  },
  {
    name: "branching-paths",
    description:
      "Two visibly different routes toward the same goal (e.g. a higher platform route and a lower ground route, or two corridors in a maze) — the player has a real choice, not one linear line.",
  },
  {
    name: "open-expanse",
    description:
      "Wide open traversal with the goal far off and only a few landmark objects placed off the direct line (not blocking it) — most of the challenge is distance and pacing, not obstacles.",
  },
  {
    name: "enclosed-maze",
    description:
      "Walled corridors forming a maze-like layout (natural fit for topdown controls) with the goal tucked at the far end or center, requiring real navigation rather than a straight line.",
  },
  {
    name: "orbit-a-hazard",
    description:
      "One central hazard or solid obstacle cluster sits between spawn and goal; the player must go around it rather than through or over it.",
  },
  {
    name: "collect-and-return",
    description:
      "The objective item sits in a small alcove or past a minor obstacle just off the main path, so reaching it takes a short deliberate detour rather than being directly on the route.",
  },
];

/** Fresh pick each call — the point is variety across repeated calls for the same prompt, not a deterministic function of it. */
export function pickMotif(): Motif {
  return MOTIFS[Math.floor(Math.random() * MOTIFS.length)]!;
}
