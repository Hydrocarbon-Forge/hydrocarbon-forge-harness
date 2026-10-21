// Contract stub: replaced by the implementation in task T2. Types and signatures only.

/**
 * @typedef {{ type: 'direction', direction: import('./game.js').Direction }
 *   | { type: 'pause' }
 *   | { type: 'restart' }} Action
 */

/**
 * Maps a KeyboardEvent.key value to a game action, or null when the key is not bound.
 * Arrow keys and WASD (either case) give directions, ' ' and 'p'/'P' give pause,
 * 'r'/'R' and 'Enter' give restart.
 * @param {string} key
 * @returns {Action | null}
 */
export function keyToAction(key) {
  throw new Error('not implemented');
}
