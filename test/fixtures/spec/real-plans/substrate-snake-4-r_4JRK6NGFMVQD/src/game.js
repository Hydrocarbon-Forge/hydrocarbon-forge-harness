/**
 * Snake game rules: pure state transitions with no DOM access.
 * Loaded as a classic <script> in the browser (global `SnakeGame`) and via
 * require() in Node (CommonJS), so the wrapper below must stay as it is.
 *
 * Coordinates: x grows to the right, y grows downward, origin is the top-left
 * cell. All functions are pure: they never mutate their arguments.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SnakeGame = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * @typedef {{ x: number, y: number }} Point
   * @typedef {'up' | 'down' | 'left' | 'right'} Direction
   * @typedef {() => number} Rng  Returns a float in [0, 1), like Math.random.
   *
   * @typedef {Object} GameConfig
   * @property {number} [width]   Columns, integer >= 4. Default DEFAULT_WIDTH.
   * @property {number} [height]  Rows, integer >= 4. Default DEFAULT_HEIGHT.
   *
   * @typedef {Object} GameState
   * @property {number} width
   * @property {number} height
   * @property {Point[]} snake       Head first; consecutive cells are adjacent.
   * @property {Direction} direction Direction of the most recent step ('right' at start).
   * @property {Direction[]} queue   Accepted turns not yet applied, oldest first, length <= 2.
   * @property {Point | null} food   null only when status is 'won'.
   * @property {number} score        Number of foods eaten.
   * @property {'playing' | 'over' | 'won'} status
   */

  /** Default board size in cells. */
  const DEFAULT_WIDTH = 20;
  const DEFAULT_HEIGHT = 20;

  /**
   * New game: snake of length 3 heading right, head at (floor(width / 2), floor(height / 2)),
   * body extending to the left, food from randomFreeCell, score 0, status 'playing'.
   * Throws RangeError when width or height is not an integer >= 4.
   * @param {GameConfig} [config]
   * @param {Rng} [rng] Defaults to Math.random.
   * @returns {GameState}
   */
  function createGame(config, rng) {
    throw new Error('not implemented');
  }

  /**
   * Queue a turn. Returns the same state object when the turn is rejected:
   * status is not 'playing', direction is not one of the four names, direction equals or
   * is opposite to the reference direction (last queued turn, else state.direction),
   * or the queue already holds 2 turns. Otherwise returns a new state with the turn appended.
   * @param {GameState} state
   * @param {Direction} direction
   * @returns {GameState}
   */
  function turn(state, direction) {
    throw new Error('not implemented');
  }

  /**
   * Advance the game by one tick. Returns the same state object unless status is 'playing'.
   * The head moves one cell in the next direction (the oldest queued turn, else state.direction).
   * Hitting a wall or the snake's own body sets status 'over'. Eating food grows the snake,
   * adds 1 to score and places new food; filling the board sets status 'won'.
   * @param {GameState} state
   * @param {Rng} [rng] Defaults to Math.random. Only used to place new food.
   * @returns {GameState}
   */
  function step(state, rng) {
    throw new Error('not implemented');
  }

  /**
   * Pick a free cell uniformly. Free cells are all in-bounds cells not in `snake`, ordered
   * row by row (y ascending, then x ascending); the result is the cell at index
   * Math.floor(rng() * freeCells.length). Returns null when there are no free cells.
   * @param {Point[]} snake
   * @param {number} width
   * @param {number} height
   * @param {Rng} [rng] Defaults to Math.random.
   * @returns {Point | null}
   */
  function randomFreeCell(snake, width, height, rng) {
    throw new Error('not implemented');
  }

  /**
   * Milliseconds between ticks for a given score: 150 at score 0, 5 less per point,
   * never below 60.
   * @param {number} score Non-negative integer.
   * @returns {number}
   */
  function tickDelayMs(score) {
    throw new Error('not implemented');
  }

  return { DEFAULT_WIDTH, DEFAULT_HEIGHT, createGame, turn, step, randomFreeCell, tickDelayMs };
});
