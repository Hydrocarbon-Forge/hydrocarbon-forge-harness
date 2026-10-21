// Contract stub for the pure Snake game rules. Replaced by the real implementation in task T2.
// Works both as a browser classic <script> (exposes the global `SnakeGame`) and as a
// CommonJS module (`require('./src/game.js')`). No DOM access, no ES module syntax.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SnakeGame = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * A grid cell. x grows to the right (0 = left column), y grows downwards (0 = top row).
   * @typedef {{ x: number, y: number }} Point
   */

  /** @typedef {'up' | 'down' | 'left' | 'right'} Direction */

  /** @typedef {'playing' | 'over' | 'won'} Status */

  /**
   * Plain, JSON-serialisable game state. All functions below treat it as immutable:
   * they return a new state object and never modify their input.
   * @typedef {Object} GameState
   * @property {number} cols       Board width in cells (integer >= 5).
   * @property {number} rows       Board height in cells (integer >= 5).
   * @property {Point[]} snake     Occupied cells, head first, length >= 1, no duplicates.
   * @property {Direction} direction  Heading used by the most recent move (initially 'right').
   * @property {Direction[]} queue    Buffered turns, oldest first, never longer than 2.
   * @property {Point | null} food    Food cell, never on the snake; null only when status is 'won'.
   * @property {number} score         Number of food items eaten so far (starts at 0).
   * @property {Status} status        'playing' until the game ends; 'over' after a crash; 'won' when the snake fills the board.
   */

  /**
   * A random number source returning a float in [0, 1), like Math.random.
   * @typedef {() => number} Rng
   */

  /**
   * Create a fresh game: a 3-cell snake heading right whose head is at
   * (Math.floor(cols / 2), Math.floor(rows / 2)) with its body to the left, an empty queue,
   * score 0, status 'playing' and one food item placed with placeFood.
   * @param {number} [cols=20]
   * @param {number} [rows=20]
   * @param {Rng} [rng=Math.random]
   * @returns {GameState}
   * @throws {RangeError} when cols or rows is not an integer >= 5.
   */
  function createGame(cols, rows, rng) {
    throw new Error('not implemented');
  }

  /**
   * Buffer a turn request. The request is compared with the last queued direction (or with
   * state.direction when the queue is empty) and ignored when it equals that direction, is
   * its exact opposite, or the queue already holds 2 entries. Also ignored unless
   * state.status is 'playing'. Returns the same or an updated copy of the state.
   * @param {GameState} state
   * @param {Direction} direction
   * @returns {GameState}
   */
  function setDirection(state, direction) {
    throw new Error('not implemented');
  }

  /**
   * Advance the game by one tick. Returns state unchanged when status is not 'playing'.
   * @param {GameState} state
   * @param {Rng} [rng=Math.random]
   * @returns {GameState}
   */
  function step(state, rng) {
    throw new Error('not implemented');
  }

  /**
   * Choose a food cell uniformly among the cells not on the snake. Free cells are listed in
   * row-major order (y ascending, then x ascending) and the result is
   * freeCells[Math.floor(rng() * freeCells.length)]. Returns null when no cell is free.
   * @param {number} cols
   * @param {number} rows
   * @param {Point[]} snake
   * @param {Rng} [rng=Math.random]
   * @returns {Point | null}
   */
  function placeFood(cols, rows, snake, rng) {
    throw new Error('not implemented');
  }

  /**
   * Milliseconds between ticks for a given score: 140 - 4 * score, never below 60.
   * @param {number} score
   * @returns {number}
   */
  function tickInterval(score) {
    throw new Error('not implemented');
  }

  return { createGame, setDirection, step, placeFood, tickInterval };
}));
