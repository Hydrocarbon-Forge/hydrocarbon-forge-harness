// Contract stub: pure Snake game logic. Replaced by the implementing task.

/** @typedef {{x: number, y: number}} Point */
/** @typedef {'up'|'down'|'left'|'right'} Direction */
/**
 * @typedef {Object} State
 * @property {number} width
 * @property {number} height
 * @property {Point[]} snake head first
 * @property {Direction} direction direction of the last move
 * @property {Direction} nextDirection direction to use on the next tick
 * @property {Point|null} food
 * @property {number} score
 * @property {'running'|'over'|'won'} status
 */

/** @param {number} width @param {number} height @param {() => number} [rng] @returns {State} */
export function createState(width, height, rng) {
  throw new Error('not implemented');
}

/** @param {State} state @param {Direction} dir @returns {State} */
export function turn(state, dir) {
  throw new Error('not implemented');
}

/** @param {State} state @param {() => number} [rng] @returns {State} */
export function tick(state, rng) {
  throw new Error('not implemented');
}

/** @param {Point[]} snake @param {number} width @param {number} height @param {() => number} [rng] @returns {Point|null} */
export function placeFood(snake, width, height, rng) {
  throw new Error('not implemented');
}
