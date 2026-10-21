// CONTRACT_STUB (replaced by task T2). Declarations only; bodies throw.
// Rendering and key mapping. No DOM access: callers pass in a canvas-2D-like context.

/**
 * The only members of a canvas 2D context that draw() may use.
 * A recording fake with exactly these members must be enough to call draw().
 *
 * @typedef {Object} DrawContext
 * @property {string} fillStyle
 * @property {string} font
 * @property {string} textAlign
 * @property {string} textBaseline
 * @property {(x: number, y: number, w: number, h: number) => void} fillRect
 * @property {(text: string, x: number, y: number) => void} fillText
 */

/**
 * @typedef {Object} DrawOptions
 * @property {boolean} [paused]          show the "Paused" overlay (only while status is 'running')
 */

/**
 * Maps a KeyboardEvent.key value to a direction, or null when the key is not a movement key.
 * @param {string} key
 * @returns {import('./game.js').Direction | null}
 */
export function keyToDirection(key) {
  throw new Error('not implemented');
}

/**
 * Paints the whole board: background, food, snake, then an optional overlay message.
 * @param {DrawContext} ctx
 * @param {import('./game.js').GameState} state
 * @param {number} cellSize              pixels per grid cell
 * @param {DrawOptions} [options]
 * @returns {void}
 */
export function draw(ctx, state, cellSize, options) {
  throw new Error('not implemented');
}
