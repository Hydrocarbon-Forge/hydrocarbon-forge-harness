// Contract stub. Replaced by the implementation in task T2; exports and shapes must stay identical.

/** @typedef {'up' | 'down' | 'left' | 'right'} Direction */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {'running' | 'over' | 'won'} Status */
/**
 * snake[0] is the head. direction is the direction of the last applied move;
 * nextDirection is the queued direction the next step will apply.
 * @typedef {{
 *   width: number,
 *   height: number,
 *   snake: Point[],
 *   direction: Direction,
 *   nextDirection: Direction,
 *   food: Point | null,
 *   score: number,
 *   status: Status
 * }} GameState
 */

export const DEFAULT_WIDTH = 20;
export const DEFAULT_HEIGHT = 20;
export const INITIAL_LENGTH = 3;

/** @type {Record<Direction, Point>} */
export const DIRECTIONS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/**
 * @param {{ width?: number, height?: number, rng?: () => number }} [options]
 * @returns {GameState}
 */
export function createGame(options) {
  throw new Error('not implemented');
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Point[]} snake
 * @param {() => number} rng
 * @returns {Point | null}
 */
export function placeFood(width, height, snake, rng) {
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
 * @param {() => number} [rng]
 * @returns {GameState}
 */
export function step(state, rng) {
  throw new Error('not implemented');
}

/**
 * @param {number} score
 * @returns {number} milliseconds between steps
 */
export function tickInterval(score) {
  throw new Error('not implemented');
}
