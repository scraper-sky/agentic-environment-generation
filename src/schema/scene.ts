import { z } from "zod";

/**
 * Coordinate convention for the entire project: y-up, origin wherever the
 * scene author wants. Only src/engine/simulation.ts knows that matter.js
 * internally uses y-down — everything else (schema, LLM, viewer) stays y-up.
 */
// Object form, not a tuple: OpenAI Structured Outputs' JSON-schema subset
// doesn't support tuple-style ("prefixItems") arrays, only plain objects/arrays.
export const Vec2Schema = z.object({ x: z.number(), y: z.number() });
export type Vec2 = z.infer<typeof Vec2Schema>;

export const ShapeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("box"),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  z.object({
    kind: z.literal("circle"),
    radius: z.number().positive(),
  }),
]);
export type ShapeDef = z.infer<typeof ShapeSchema>;

export const BodyTypeSchema = z.enum(["static", "dynamic"]);
export type BodyType = z.infer<typeof BodyTypeSchema>;

export const SceneObjectSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe("Unique within the scene. Referenced by objective.target, objective.near, hazards[], and player.objectId."),
  tags: z.array(z.string()).describe("Free-form semantic labels, e.g. ['platform'], ['can'], ['table'], ['hazard']."),
  shape: ShapeSchema,
  position: Vec2Schema.describe("Center position in world units, y-up."),
  velocity: Vec2Schema.describe("Initial velocity. Use [0, 0] unless the object should start moving."),
  bodyType: BodyTypeSchema,
  friction: z.number().min(0).max(2).describe("Surface friction, 0 = ice, ~0.1 = normal, 1+ = very grippy."),
  restitution: z.number().min(0).max(1).describe("Bounciness, 0 = no bounce, 1 = perfectly elastic."),
  color: z.string().describe("CSS hex color for rendering, e.g. '#4f9dde'. Has no effect on physics."),
  sensor: z
    .boolean()
    .describe("true = overlap-only, no collision response. Use for goals, collectibles, and hazards; false for solid platforms/walls/players."),
});
export type SceneObject = z.infer<typeof SceneObjectSchema>;

/**
 * Objectives are a closed, declarative vocabulary — never LLM-generated code.
 * The engine (src/engine/objectives.ts) interprets these with a plain switch.
 */
export const ObjectiveSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("reach"),
    target: z.string().describe("Object id the player must overlap."),
    radius: z.number().positive().describe("Distance threshold counted as 'reached'."),
  }),
  z.object({
    type: z.literal("collect"),
    target: z.string().describe("Object id the player must overlap to 'collect' it."),
    near: z
      .string()
      .nullable()
      .describe("Optional object id that target must remain within nearRadius of (e.g. a table). Null if not required."),
    radius: z.number().positive().describe("Distance threshold for player-target overlap."),
    nearRadius: z.number().positive().nullable().describe("Distance threshold for target-near proximity. Null if 'near' is null."),
  }),
]);
export type ObjectiveDef = z.infer<typeof ObjectiveSchema>;

export const ControlsSchema = z.enum(["platformer", "topdown"]);
export type Controls = z.infer<typeof ControlsSchema>;

/**
 * What the LLM is actually asked to produce. `id`, `prompt`, and `metadata`
 * are attached by our own code after generation, not by the model.
 */
export const GeneratedSceneSchema = z.object({
  bounds: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  gravity: Vec2Schema.describe("[0, 0] for topdown scenes; [0, -1] (approx) for platformer scenes with a floor."),
  player: z.object({
    objectId: z.string().describe("Must match the id of one dynamic object in objects[]."),
    controls: ControlsSchema,
  }),
  objects: z.array(SceneObjectSchema).min(2).describe("Must include the player object plus at least one other object."),
  objective: ObjectiveSchema,
  hazards: z.array(z.string()).describe("Object ids that end the episode in failure on touch. Empty array if none."),
  maxSteps: z.number().int().positive().describe("Physics-tick budget before the episode fails as a timeout."),
});
export type GeneratedScene = z.infer<typeof GeneratedSceneSchema>;

export const SceneSchema = GeneratedSceneSchema.extend({
  id: z.string(),
  prompt: z.string(),
  metadata: z
    .object({
      generatedAt: z.string(),
      model: z.string(),
    })
    .nullable(),
});
export type Scene = z.infer<typeof SceneSchema>;
