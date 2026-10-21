// CONTRACT_STUB (replaced by task T2). Declarations only; bodies throw.
// Pure game rules: no DOM, no timers, no module-level mutable state.

/** @typedef {'up' | 'down' | 'left' | 'right'} Direction */

/** @typedef {{ x: number, y: number }} Point  x grows rightwards, y grows downwards, origin top-left */

/**
 * Plain, JSON-serialisable game state. Every function below treats it as immutable
 * and returns a new object instead of mutating its input.
 *
 * @typedef {Object} GameState
 * @property {number} width              grid columns
 * @property {number} height             grid rows
 * @property {Point[]} snake             head first, tail last, length >= 1
 * @property {Direction} direction       direction of the most recent applied move
 * @property {Direction} nextDirection   direction the next step() will move in
 * @property {Point | null} food         null only when status is 'won'
 * @property {number} score              foods eaten
 * @property {'running' | 'over' | 'won'} status
 */

/**
 * @typedef {Object} GameOptions
 * @property {number} [width]            integer >= 5, default 20
 * @property {number} [height]           integer >= 5, default 20
 * @property {() => number} [rng]        returns a float in [0, 1), default Math.random
 */

/**
 * @param {GameOptions} [options]
 * @returns {GameState}
 */
export function createGame(options) {
  throw new Error('not implemented');
}

/**
 * @param {GameState} state
 * @param {Direction} direction
 * @returns {GameState}
 */
export function setDirection(state, direction) {
  throw new Error('not implemented');
}

/**
 * @param {GameState} state
 * @param {() => number} [rng]           default Math.random; used only to place food
 * @returns {GameState}
 */
export function step(state, rng) {
  throw new Error('not implemented');
}

/**
 * Milliseconds between ticks for a given score.
 * @param {number} score
 * @returns {number}
 */
export function tickDelay(score) {
  throw new Error('not implemented');
}
