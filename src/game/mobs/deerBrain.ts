/**
 * Roe deer behaviour as a pure state machine (no three.js, no world access — unit-tested).
 * Distances are world units (1 m = 10), times seconds; the numbers are pinned in the deer.ts JSDoc.
 * OWNER: agent "entities".
 *
 *   idle ──notice──▶ alert ──player unnoticeable 3 s──▶ idle
 *     │                │
 *     └──flee distance, loud noise, herd flight (from idle/alert/recover)──▶ flee ──run 25–35 m──▶ recover
 *   any ──hit──▶ stagger (0.4 s) ──▶ flee                       recover ──8–12 s──▶ idle (or alert)
 */
import { lerp } from '../../core/math';

export const DEER = {
  /** Notice distance: walking (or standing) player, sprinting player, crouch-walking player. */
  noticeWalk: 150,
  noticeSprint: 250,
  noticeCrouch: 50,
  /** Flee distance: upright player, crouching player. */
  flee: 80,
  fleeCrouch: 25,
  /** An alert deer relaxes after the player has been unnoticeable (e.g. crouching still) this long. */
  relaxS: 3,
  /** A flight covers this distance (random in range)… */
  fleeRunMin: 250,
  fleeRunMax: 350,
  /** …but never lasts longer than this (blocked or cornered). */
  fleeMaxS: 8,
  /** While the player stays inside the flee distance the deer keeps at least this much run ahead. */
  fleeChase: 120,
  fleeSpeed: 90,
  /** Calm-down after a flight. */
  recoverMinS: 8,
  recoverMaxS: 12,
  staggerS: 0.4,
  health: 9,
  /** Player horizontal speed (units/s) above which the player counts as moving. */
  playerMoving: 3,
} as const;

export type DeerState = 'idle' | 'alert' | 'stagger' | 'flee' | 'recover';
/** Strongest signal from herd mates this step. */
export type DeerAlarm = 'none' | 'alert' | 'flee';
/** What the step asks the Deer to do: call out and warn the herd ('alert'), bolt ('flee'), resume grazing ('relax'). */
export type DeerEvent = 'none' | 'alert' | 'flee' | 'relax';

export interface DeerSenses {
  /** Distance to the player. */
  dist: number;
  crouching: boolean;
  sprinting: boolean;
  /** The player moves (horizontal speed > DEER.playerMoving). */
  moving: boolean;
  /** Hit by the player since the last step. */
  hit: boolean;
  /** Heard a loud noise since the last step. */
  noise: boolean;
  herd: DeerAlarm;
  /** Horizontal distance the deer covered in the last step. */
  moved: number;
}

export interface DeerBrain {
  state: DeerState;
  /** Countdown of the timed states (stagger, recover). */
  timer: number;
  /** Alert: seconds the player has been unnoticeable. */
  unseen: number;
  /** Flee: distance still to run, and seconds spent running. */
  fleeLeft: number;
  fleeTime: number;
}

export const createDeerBrain = (): DeerBrain => ({ state: 'idle', timer: 0, unseen: 0, fleeLeft: 0, fleeTime: 0 });

/** How far the player is noticed: 25 m sprinting, 15 m walking or standing, 5 m crouch-walking, not at all crouching still. */
export function deerNoticeDistance(s: Pick<DeerSenses, 'crouching' | 'sprinting' | 'moving'>): number {
  if (s.crouching) return s.moving ? DEER.noticeCrouch : 0;
  return s.sprinting && s.moving ? DEER.noticeSprint : DEER.noticeWalk;
}

/** How close the player may come before the deer bolts: 8 m, or 2.5 m crouching. */
export function deerFleeDistance(s: Pick<DeerSenses, 'crouching'>): number {
  return s.crouching ? DEER.fleeCrouch : DEER.flee;
}

function startFlight(b: DeerBrain, rand: () => number): DeerEvent {
  b.state = 'flee';
  b.fleeLeft = lerp(DEER.fleeRunMin, DEER.fleeRunMax, rand());
  b.fleeTime = 0;
  return 'flee';
}

function becomeAlert(b: DeerBrain): void {
  b.state = 'alert';
  b.unseen = 0;
}

/** Advances the brain by `dt`; `rand` returns uniform numbers in [0, 1). */
export function stepDeerBrain(b: DeerBrain, s: DeerSenses, dt: number, rand: () => number): DeerEvent {
  if (s.hit) {
    b.state = 'stagger';
    b.timer = DEER.staggerS;
    return 'none';
  }
  if (b.state === 'stagger') {
    b.timer -= dt;
    return b.timer <= 0 ? startFlight(b, rand) : 'none';
  }
  if (b.state === 'flee') {
    b.fleeLeft -= s.moved;
    b.fleeTime += dt;
    if (s.noise || s.dist <= deerFleeDistance(s)) b.fleeLeft = Math.max(b.fleeLeft, DEER.fleeChase);
    if (b.fleeLeft <= 0 || b.fleeTime >= DEER.fleeMaxS) {
      b.state = 'recover';
      b.timer = lerp(DEER.recoverMinS, DEER.recoverMaxS, rand());
    }
    return 'none';
  }

  if (s.noise || s.herd === 'flee' || s.dist <= deerFleeDistance(s)) return startFlight(b, rand);
  const noticed = s.dist <= deerNoticeDistance(s);
  switch (b.state) {
    case 'idle':
      if (noticed) {
        becomeAlert(b);
        return 'alert';
      }
      if (s.herd === 'alert') becomeAlert(b);
      return 'none';
    case 'alert':
      b.unseen = noticed ? 0 : b.unseen + dt;
      if (b.unseen < DEER.relaxS) return 'none';
      b.state = 'idle';
      return 'relax';
    case 'recover':
      b.timer -= dt;
      if (b.timer > 0) return 'none';
      if (noticed) {
        becomeAlert(b);
        return 'alert';
      }
      b.state = 'idle';
      return 'relax';
  }
}
