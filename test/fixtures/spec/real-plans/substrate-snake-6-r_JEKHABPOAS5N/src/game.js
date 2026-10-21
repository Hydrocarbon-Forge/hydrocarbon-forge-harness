// Contract stub for the pure Snake game logic. Replaced by the implementation in task T2.
// Coordinates: x is the column (0 = left), y is the row (0 = top). 'up' is y-1, 'down' is y+1,
// 'left' is x-1, 'right' is x+1. All functions are pure: they never mutate their arguments.

/** @typedef {'up' | 'down' | 'left' | 'right'} Direction */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {'running' | 'over' | 'won'} Status */

/**
 * @typedef {Object} GameState
 * @property {number} cols      board width in cells
 * @property {number} rows      board height in cells
 * @property {Point[]} snake    head first, tail last; never empty
 * @property {Direction} direction  direction used by the most recent step ('right' initially)
 * @property {Direction[]} queue    accepted turns not yet applied, oldest first, at most 2
 * @property {Point | null} food    null only when the board is completely full
 * @property {number} score         number of foods eaten
 * @property {Status} status
 */

export const DEFAULT_COLS = 20;
export const DEFAULT_ROWS = 20;
export const BASE_TICK_MS = 150;
export const MIN_TICK_MS = 70;
export const TICK_STEP_MS = 4;

/**
 * New game: 3-cell snake heading right, head at (floor(cols/2), floor(rows/2)), body to its left.
 * Throws RangeError unless cols and rows are integers >= 5.
 * @param {{ cols?: number, rows?: number }} [options]  defaults DEFAULT_COLS x DEFAULT_ROWS
 * @param {() => number} [rng]  returns a float in [0, 1); defaults to Math.random
 * @returns {GameState}
 */
export function createGame(options, rng) {
  throw new Error('not implemented');
}

/**
 * Queue a turn. Returns the same state object when the turn is ignored: game not running,
 * queue already holds 2 turns, or dir equals / is opposite to the last queued direction
 * (or state.direction when the queue is empty).
 * @param {GameState} state
 * @param {Direction} dir
 * @returns {GameState}
 */
export function turn(state, dir) {
  throw new Error('not implemented');
}

/**
 * Advance one tick. Returns the same state object unless status is 'running'.
 * @param {GameState} state
 * @param {() => number} [rng]  used for food placement; defaults to Math.random
 * @returns {GameState}
 */
export function step(state, rng) {
  throw new Error('not implemented');
}

/**
 * Pick a uniformly random free cell: free cells are listed row-major (y outer loop, x inner loop,
 * ascending) and the cell at index floor(rng() * freeCount) is returned. Null if no cell is free.
 * @param {Point[]} snake
 * @param {number} cols
 * @param {number} rows
 * @param {() => number} [rng]
 * @returns {Point | null}
 */
export function placeFood(snake, cols, rows, rng) {
  throw new Error('not implemented');
}

/**
 * Milliseconds between ticks: max(MIN_TICK_MS, BASE_TICK_MS - TICK_STEP_MS * score).
 * @param {number} score
 * @returns {number}
 */
export function tickMs(score) {
  throw new Error('not implemented');
}
