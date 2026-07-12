import { z } from "zod";

/**
 * Closed action vocabulary per control scheme, mirroring the brief's
 * "controller-style discrete actions" framing. The traversal agent can never
 * emit anything outside these enums — no raw forces, no code.
 */
export const PlatformerActionSchema = z.object({
  action: z.enum(["left", "right", "jump", "noop"]),
  reasoning: z.string().nullable().describe("One short sentence on why this action was chosen. Null if none."),
});
export type PlatformerAction = z.infer<typeof PlatformerActionSchema>;

export const TopdownActionSchema = z.object({
  action: z.enum(["up", "down", "left", "right", "noop"]),
  reasoning: z.string().nullable().describe("One short sentence on why this action was chosen. Null if none."),
});
export type TopdownAction = z.infer<typeof TopdownActionSchema>;
