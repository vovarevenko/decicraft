/**
 * Stray dog behaviour as a pure state machine (no three.js, no world access — unit-tested).
 * Distances are world units (1 m = 10), times seconds. OWNER: agent "entities".
 *
 * Not friendly: 'roam' around its home while the player is far; 'wary' within 25 m (keeps 6–10 m
 * away and barks); 'beg' (comes close) while the player holds food it likes. Friendly: 'follow' at
 * 2–3 m, 'sit' while the player stands still > 2 s, now and then barks at deer within 15 m.
 * A hit makes it 'flee' for 4–6 s (the Dog drops the friendship).
 */
import { lerp } from '../../core/math';
import type { Inventory } from '../inventory';
import { ITEMS } from '../items';

export const DOG = {
  /** Wary band: backs off closer than waryMin, comes nearer beyond waryMax. */
  waryMin: 60,
  waryMax: 100,
  /** The player gets the dog's attention within `interest`; beyond `forget` it goes back to roaming. */
  interest: 250,
  forget: 300,
  /** A wary dog barks at the player within this distance. */
  barkRange: 150,
  /** It smells liked food from this far and comes up to begDist. */
  begRange: 200,
  begDist: 16,
  /** Friendly: starts following beyond followFar, stops within followNear, runs beyond runDist. */
  followNear: 20,
  followFar: 30,
  runDist: 80,
  /** Friendly: sits when the player has stood still this long within sitRange; gets up beyond standRange. */
  sitIdleS: 2,
  sitRange: 35,
  standRange: 45,
  /** Friendly: may bark at deer this close. */
  deerBarkRange: 150,
  fleeMinS: 4,
  fleeMaxS: 6,
  walk: 14,
  trot: 35,
  run: 80,
  fleeSpeed: 65,
} as const;

export type DogState = 'roam' | 'wary' | 'beg' | 'follow' | 'sit' | 'flee';
/** The selected item: none / food the dog likes / other food. */
export type DogFood = 'none' | 'liked' | 'other';
export type DogEvent = 'none' | 'bark' | 'barkAtDeer';

export interface DogSenses {
  /** Distance to the player. */
  dist: number;
  /** Seconds the player has been standing still. */
  playerIdle: number;
  food: DogFood;
  friendly: boolean;
  /** Hit by the player since the last step. */
  hit: boolean;
  /** Distance to the nearest living deer (Infinity if none is near or it was not looked up). */
  deerDist: number;
}

export interface DogBrain {
  state: DogState;
  /** Flee countdown. */
  timer: number;
  /** Countdown to the next bark opportunity. */
  barkTimer: number;
}

export const createDogBrain = (): DogBrain => ({ state: 'roam', timer: 0, barkTimer: 1 });

/** What the dog makes of the player's selected item. */
export function dogFoodOf(inv: Pick<Inventory, 'selectedStack'>): DogFood {
  const stack = inv.selectedStack();
  const food = stack ? ITEMS[stack.id]?.food : undefined;
  if (!food) return 'none';
  return food.dogLikes ? 'liked' : 'other';
}

/** Advances the brain by `dt`; `rand` returns uniform numbers in [0, 1). */
export function stepDogBrain(b: DogBrain, s: DogSenses, dt: number, rand: () => number): DogEvent {
  b.barkTimer -= dt;
  if (s.hit) {
    b.state = 'flee';
    b.timer = lerp(DOG.fleeMinS, DOG.fleeMaxS, rand());
    return 'none';
  }
  if (b.state === 'flee') {
    b.timer -= dt;
    if (b.timer > 0) return 'none';
    b.state = s.dist <= DOG.interest ? 'wary' : 'roam';
  }

  if (s.friendly) {
    if (b.state === 'sit') {
      if (s.playerIdle < DOG.sitIdleS || s.dist > DOG.standRange) b.state = 'follow';
    } else if (s.playerIdle >= DOG.sitIdleS && s.dist <= DOG.sitRange) {
      b.state = 'sit';
    } else {
      b.state = 'follow';
    }
    if (b.barkTimer > 0) return 'none';
    b.barkTimer = lerp(2, 4, rand());
    if (s.deerDist > DOG.deerBarkRange || rand() >= 0.35) return 'none';
    b.barkTimer = lerp(8, 12, rand());
    return 'barkAtDeer';
  }

  if (s.food === 'liked' && s.dist <= DOG.begRange) {
    b.state = 'beg';
    return 'none';
  }
  if (b.state === 'wary') {
    if (s.dist > DOG.forget) b.state = 'roam';
  } else {
    b.state = s.dist <= DOG.interest ? 'wary' : 'roam';
  }
  if (b.state !== 'wary' || s.dist > DOG.barkRange || b.barkTimer > 0) return 'none';
  b.barkTimer = lerp(2.5, 6, rand());
  return 'bark';
}
