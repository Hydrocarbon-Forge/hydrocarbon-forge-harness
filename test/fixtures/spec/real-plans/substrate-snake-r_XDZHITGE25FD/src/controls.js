// Contract stub. Replaced by the implementation in task T3; exports must stay identical.

/** @typedef {import('./game.js').Direction} Direction */
/** @typedef {'pause' | 'restart'} Command */

/**
 * @param {string} key a KeyboardEvent.key value
 * @returns {Direction | null}
 */
export function keyToDirection(key) {
  throw new Error('not implemented');
}

/**
 * @param {string} key a KeyboardEvent.key value
 * @returns {Command | null}
 */
export function keyToCommand(key) {
  throw new Error('not implemented');
}
