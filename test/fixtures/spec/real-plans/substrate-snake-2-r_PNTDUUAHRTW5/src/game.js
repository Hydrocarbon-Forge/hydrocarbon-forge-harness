// Contract stub: replaced by the implementation in task T2. Types and signatures only.
//
// Coordinates: x grows to the right, y grows downward, origin (0, 0) is the top-left cell.
// Every function is pure: it never mutates its arguments and never reads global state.
// A function that does nothing returns the very same state object it was given.

/** @typedef {{ x: number, y: number }} Point */

/** @typedef {'up' | 'down' | 'left' | 'right'} Direction */

/** @typedef {'ready' | 'playing' | 'paused' | 'over' | 'won'} Status */

/**
 * @typedef {Object} GameState
 * @property {number} cols Board width in cells.
 * @property {number} rows Board height in cells.
 * @property {Point[]} snake Occupied cells, head first. Never empty.
 * @property {Direction} direction Heading used by the most recent step (initially 'right').
 * @property {Direction[]} queue Buffered turns not yet applied, oldest first. At most 2 entries.
 * @property {Point | null} food Food cell, or null when the board has no free cell left.
 * @property {number} score Number of food items eaten.
 * @property {Status} status Current phase of the game.
 */

/** Default board width in cells. */
export const DEFAULT_COLS = 20;

/** Default board height in cells. */
export const DEFAULT_ROWS = 20;

/**
 * Creates a new game in status 'ready'. The snake has 3 cells, heads right, and the head sits at
 * (floor(cols / 2), floor(rows / 2)) with the body extending to the left.
 * @param {{ cols?: number, rows?: number, rng?: () => number }} [options]
 *   rng returns a number in [0, 1) and defaults to Math.random.
 * @returns {GameState}
 * @throws {RangeError} When cols or rows is not an integer of at least 5.
 */
export function createGame(options) {
  throw new Error('not implemented');
}

/**
 * Picks the food cell uniformly from the free cells (cells not in `snake`), listed in row-major
 * order (index = y * cols + x ascending): the result is free[Math.floor(rng() * free.length)].
 * @param {Point[]} snake
 * @param {number} cols
 * @param {number} rows
 * @param {() => number} rng
 * @returns {Point | null} null when no free cell exists.
 */
export function placeFood(snake, cols, rows, rng) {
  throw new Error('not implemented');
}

/**
 * Queues a turn requested by the player.
 * @param {GameState} state
 * @param {Direction} direction
 * @returns {GameState}
 */
export function setDirection(state, direction) {
  throw new Error('not implemented');
}

/**
 * Moves from 'ready' to 'playing', 'playing' to 'paused', and 'paused' to 'playing'.
 * Returns the same state for 'over' and 'won'.
 * @param {GameState} state
 * @returns {GameState}
 */
export function togglePause(state) {
  throw new Error('not implemented');
}

/**
 * Advances the game by one tick. Returns the same state unless status is 'playing'.
 * @param {GameState} state
 * @param {() => number} [rng] Used to place the next food item; defaults to Math.random.
 * @returns {GameState}
 */
export function step(state, rng) {
  throw new Error('not implemented');
}

/**
 * Milliseconds to wait between ticks at a given score: max(60, 140 - 4 * score).
 * @param {number} score
 * @returns {number}
 */
export function tickDelayMs(score) {
  throw new Error('not implemented');
}
