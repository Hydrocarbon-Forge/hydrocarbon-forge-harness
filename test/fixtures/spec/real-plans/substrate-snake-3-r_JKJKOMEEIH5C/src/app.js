// CONTRACT_STUB (replaced by task T2). Declarations only; bodies throw.
// The controller that ties game rules, rendering, pause/restart and the best score together.
// No DOM access and no timers: src/main.js owns the real canvas, keyboard events and setTimeout loop.

/**
 * @typedef {Object} StorageLike
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 */

/**
 * What the HUD shows. 'paused' appears only while the game is running and the user has paused it.
 * @typedef {Object} AppView
 * @property {number} score
 * @property {number} best
 * @property {'running' | 'paused' | 'over' | 'won'} status
 */

/**
 * @typedef {Object} AppOptions
 * @property {import('./ui.js').DrawContext} ctx
 * @property {number} [cellSize]         default 20
 * @property {number} [gridWidth]        default 20
 * @property {number} [gridHeight]       default 20
 * @property {() => number} [rng]        default Math.random
 * @property {StorageLike | null} [storage]   best score is persisted under key 'snake.best'; null or absent means in-memory only
 * @property {(view: AppView) => void} [onChange]  called after every visible change, including once at creation
 */

/**
 * @typedef {Object} App
 * @property {(key: string) => boolean} handleKey   KeyboardEvent.key in; true when the key was recognised (caller should preventDefault)
 * @property {() => void} tick                      advance the game one step; no-op while paused or finished
 * @property {() => number} nextDelay               milliseconds to wait before the next tick()
 * @property {() => void} restart                   start a fresh game, keeping the best score
 * @property {() => void} togglePause               no-op unless the game is running
 * @property {() => AppView} getView
 * @property {() => import('./game.js').GameState} getState
 */

/**
 * @param {AppOptions} options
 * @returns {App}
 */
export function createApp(options) {
  throw new Error('not implemented');
}
