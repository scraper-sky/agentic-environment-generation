import Matter from "matter-js";
import type { Controls, Scene, SceneObject, Vec2 } from "../schema/scene.js";
import type { PlatformerAction, TopdownAction } from "../schema/actions.js";

export interface SimSnapshotObject {
  id: string;
  position: Vec2;
  velocity: Vec2;
  angle: number;
}
export type SimSnapshot = Record<string, SimSnapshotObject>;

export interface SimWorld {
  engine: Matter.Engine;
  scene: Scene;
  bodiesById: Map<string, Matter.Body>;
  playerBody: Matter.Body;
  /** matter.js body ids currently touching the player (non-sensor only) — used for jump gating. */
  groundContacts: Set<number>;
  /** matter.js body ids currently touching the player, including sensors — used for hazard detection. */
  activeContacts: Set<number>;
  tick: number;
  lastGroundedTick: number;
  /**
   * True only from the moment real ground contact is (re)made until a jump
   * is actually executed. Deliberately separate from the coyote-time
   * `isGrounded()` signal: coyote time is meant to forgive a late jump
   * *initiation*, but `applyAction` runs once per physics substep, so a
   * single held "jump" decision spans several substeps — without this latch,
   * every one of those substeps would still read as "grounded" (via coyote
   * grace) and re-fire the jump impulse, stacking launch velocity and
   * producing wildly inflated arcs instead of one clean jump.
   */
  canJump: boolean;
}

const MOVE_SPEED = 4;
const JUMP_SPEED = 9;
/**
 * "Coyote time": grounded stays true for a few ticks after the last solid
 * contact. Discrete physics stepping combined with directly overriding
 * velocity each frame (rather than letting matter.js integrate forces
 * naturally) can momentarily drop a resting contact for a single tick even
 * while the player is visually stationary on a platform — without this grace
 * window, that flicker reads as "airborne" and silently swallows jumps.
 */
const COYOTE_TICKS = 4;

/**
 * The only function in the project aware that matter.js is y-down while the
 * schema/viewer/harnesses are y-up. A pure sign flip, since both systems
 * share the same origin — no translation needed.
 */
function flipY(y: number): number {
  return -y;
}

function buildBody(obj: SceneObject): Matter.Body {
  const options: Matter.IBodyDefinition = {
    isStatic: obj.bodyType === "static",
    isSensor: obj.sensor,
    friction: obj.friction,
    restitution: obj.restitution,
    label: obj.id,
  };
  const x = obj.position.x;
  const y = flipY(obj.position.y);
  const body =
    obj.shape.kind === "box"
      ? Matter.Bodies.rectangle(x, y, obj.shape.width, obj.shape.height, options)
      : Matter.Bodies.circle(x, y, obj.shape.radius, options);
  Matter.Body.setVelocity(body, { x: obj.velocity.x, y: flipY(obj.velocity.y) });
  return body;
}

export function createWorld(scene: Scene): SimWorld {
  const engine = Matter.Engine.create();
  engine.gravity.x = scene.gravity.x;
  engine.gravity.y = flipY(scene.gravity.y);

  const bodiesById = new Map<string, Matter.Body>();
  for (const obj of scene.objects) {
    const body = buildBody(obj);
    bodiesById.set(obj.id, body);
    Matter.Composite.add(engine.world, body);
  }

  const playerBody = bodiesById.get(scene.player.objectId);
  if (!playerBody) {
    throw new Error(`Player object id '${scene.player.objectId}' not found among scene objects.`);
  }

  const groundContacts = new Set<number>();
  const activeContacts = new Set<number>();
  // matter.js still fires collision events for sensor bodies (isSensor only
  // disables collision *response*), so this same listener can drive both
  // jump-gating (solid contacts only) and hazard/goal touch detection (all contacts).
  const trackContact = (event: Matter.IEventCollision<Matter.Engine>, add: boolean) => {
    const set = (s: Set<number>, id: number) => (add ? s.add(id) : s.delete(id));
    for (const { bodyA, bodyB } of event.pairs) {
      if (bodyA === playerBody) {
        set(activeContacts, bodyB.id);
        if (!bodyB.isSensor) set(groundContacts, bodyB.id);
      }
      if (bodyB === playerBody) {
        set(activeContacts, bodyA.id);
        if (!bodyA.isSensor) set(groundContacts, bodyA.id);
      }
    }
  };
  Matter.Events.on(engine, "collisionStart", (event) => trackContact(event, true));
  Matter.Events.on(engine, "collisionEnd", (event) => trackContact(event, false));

  return { engine, scene, bodiesById, playerBody, groundContacts, activeContacts, tick: 0, lastGroundedTick: 0, canJump: true };
}

export function step(sim: SimWorld, deltaMs = 1000 / 60): void {
  Matter.Engine.update(sim.engine, deltaMs);
  sim.tick++;
  if (sim.groundContacts.size > 0) {
    sim.lastGroundedTick = sim.tick;
    sim.canJump = true;
  }
}

export function getSnapshot(sim: SimWorld): SimSnapshot {
  const snapshot: SimSnapshot = {};
  for (const [id, body] of sim.bodiesById) {
    snapshot[id] = {
      id,
      position: { x: body.position.x, y: flipY(body.position.y) },
      velocity: { x: body.velocity.x, y: flipY(body.velocity.y) },
      angle: body.angle,
    };
  }
  return snapshot;
}

export function isGrounded(sim: SimWorld): boolean {
  return sim.tick - sim.lastGroundedTick <= COYOTE_TICKS;
}

export function isTouchingPlayer(sim: SimWorld, objectId: string): boolean {
  const body = sim.bodiesById.get(objectId);
  if (!body) return false;
  return sim.activeContacts.has(body.id);
}

const GROUND_AHEAD_LOOKAHEAD = 60;
const GROUND_AHEAD_DROP_DEPTH = 50;

/**
 * Ledge detection: is there solid ground within `dropDepth` below a point
 * `lookahead` px in front of the player? This is the signal a platformer
 * agent actually needs to decide "jump now or walk off a gap" — a hazard's
 * raw position (e.g. a pit spanning the whole level) is a poor proxy for
 * this, since it doesn't tell you where the *current platform* ends.
 */
export function isGroundAhead(sim: SimWorld, direction: 1 | -1, lookahead = GROUND_AHEAD_LOOKAHEAD, dropDepth = GROUND_AHEAD_DROP_DEPTH): boolean {
  const player = sim.playerBody;
  const x = player.position.x + direction * lookahead;
  const start = { x, y: player.position.y };
  const end = { x, y: player.position.y + dropDepth }; // matter.js is y-down, so +y is downward here
  const solidBodies = [...sim.bodiesById.values()].filter((b) => b !== player && !b.isSensor);
  return Matter.Query.ray(solidBodies, start, end).length > 0;
}

const WALL_AHEAD_LOOKAHEAD = 35;

/**
 * Is there a solid obstacle (tree, pillar, wall segment) directly in the
 * player's path at their own height, right now? `isGroundAhead` only detects
 * a *missing* floor (a gap) — it stays true the whole time a standing
 * obstacle sits on otherwise-continuous ground, so without this a platformer
 * agent has no signal that something needs to be jumped *over* rather than
 * jumped *across a gap for*.
 */
export function isWallAhead(sim: SimWorld, direction: 1 | -1, lookahead = WALL_AHEAD_LOOKAHEAD): boolean {
  const player = sim.playerBody;
  const start = { x: player.position.x, y: player.position.y };
  const end = { x: player.position.x + direction * lookahead, y: player.position.y };
  const solidBodies = [...sim.bodiesById.values()].filter((b) => b !== player && !b.isSensor);
  return Matter.Query.ray(solidBodies, start, end).length > 0;
}

const BLOCKED_AHEAD_DISTANCE = 40;

/**
 * Topdown equivalent of isGroundAhead: is there a solid wall within
 * `distance` in the given direction, right now? Without this, a topdown
 * agent has no obstacle signal at all and will greedily walk straight into
 * a wall on the direct line toward its objective, with no way to reason
 * about detouring around it.
 */
export function isBlockedAhead(sim: SimWorld, action: TopdownAction["action"], distance = BLOCKED_AHEAD_DISTANCE): boolean {
  if (action === "noop") return false;
  const player = sim.playerBody;
  // matter.js is y-down: schema "up" (+y) is matter -y.
  const delta: Record<Exclude<TopdownAction["action"], "noop">, { x: number; y: number }> = {
    up: { x: 0, y: -distance },
    down: { x: 0, y: distance },
    left: { x: -distance, y: 0 },
    right: { x: distance, y: 0 },
  };
  const { x: dx, y: dy } = delta[action];
  const start = { x: player.position.x, y: player.position.y };
  const end = { x: player.position.x + dx, y: player.position.y + dy };
  const solidBodies = [...sim.bodiesById.values()].filter((b) => b !== player && !b.isSensor);
  return Matter.Query.ray(solidBodies, start, end).length > 0;
}

export function applyPlatformerAction(sim: SimWorld, action: PlatformerAction["action"]): void {
  const body = sim.playerBody;
  // "jump" and "noop" both intentionally leave horizontal velocity
  // untouched — "noop" is a literal no-op, not an active deceleration to
  // zero. This matters most while airborne: an agent that (reasonably)
  // reads "noop" as "do nothing" and holds it mid-jump must not have its
  // momentum silently killed, or it will fall short of every gap.
  if (action === "left") Matter.Body.setVelocity(body, { x: -MOVE_SPEED, y: body.velocity.y });
  else if (action === "right") Matter.Body.setVelocity(body, { x: MOVE_SPEED, y: body.velocity.y });

  if (action === "jump" && isGrounded(sim) && sim.canJump) {
    Matter.Body.setVelocity(body, { x: body.velocity.x, y: -JUMP_SPEED });
    sim.canJump = false;
  }
}

export function applyTopdownAction(sim: SimWorld, action: TopdownAction["action"]): void {
  const body = sim.playerBody;
  const vx = action === "left" ? -MOVE_SPEED : action === "right" ? MOVE_SPEED : 0;
  const vy = action === "up" ? -MOVE_SPEED : action === "down" ? MOVE_SPEED : 0;
  Matter.Body.setVelocity(body, { x: vx, y: vy });
}

export function applyAction(sim: SimWorld, controls: Controls, action: string): void {
  if (controls === "platformer") applyPlatformerAction(sim, action as PlatformerAction["action"]);
  else applyTopdownAction(sim, action as TopdownAction["action"]);
}
