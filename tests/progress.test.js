import { describe, it, expect, beforeEach } from 'vitest';
import progress from '../src/server/progress.js';

describe('src/server/progress.js', () => {
  beforeEach(() => {
    // Reset state between tests by finishing any pending run
    progress.finish(null);
  });

  describe('initial state', () => {
    it('starts in idle / not running', () => {
      // After finish(), stage is "finished" — but isRunning is false
      const state = progress.getState();
      expect(state.isRunning).toBe(false);
    });
  });

  describe('start()', () => {
    it('sets isRunning and resets items', () => {
      progress.start();
      const state = progress.getState();
      expect(state.isRunning).toBe(true);
      expect(state.stage).toBe('starting');
      expect(state.items.customers).toEqual({ done: 0, total: 0 });
      expect(state.lastError).toBeNull();
    });
  });

  describe('setStage()', () => {
    it('updates the stage', () => {
      progress.start();
      progress.setStage('fetch:lists');
      expect(progress.getState().stage).toBe('fetch:lists');
    });
  });

  describe('setItemTotal()', () => {
    it('sets the total for a known item', () => {
      progress.start();
      progress.setItemTotal('customers', 100);
      expect(progress.getState().items.customers.total).toBe(100);
    });

    it('creates a new item if not predefined', () => {
      progress.start();
      progress.setItemTotal('widgets', 50);
      expect(progress.getState().items.widgets.total).toBe(50);
      expect(progress.getState().items.widgets.done).toBe(0);
    });

    it('handles NaN gracefully', () => {
      progress.start();
      progress.setItemTotal('customers', 'not-a-number');
      expect(progress.getState().items.customers.total).toBe(0);
    });
  });

  describe('setItemDone()', () => {
    it('sets done count', () => {
      progress.start();
      progress.setItemTotal('customers', 100);
      progress.setItemDone('customers', 50);
      expect(progress.getState().items.customers.done).toBe(50);
    });

    it('clamps done to total', () => {
      progress.start();
      progress.setItemTotal('customers', 10);
      progress.setItemDone('customers', 999);
      expect(progress.getState().items.customers.done).toBe(10);
    });
  });

  describe('incItem()', () => {
    it('increments done by 1 by default', () => {
      progress.start();
      progress.setItemTotal('customers', 10);
      progress.incItem('customers');
      progress.incItem('customers');
      expect(progress.getState().items.customers.done).toBe(2);
    });

    it('increments by a custom delta', () => {
      progress.start();
      progress.incItem('customers', 5);
      expect(progress.getState().items.customers.done).toBe(5);
    });
  });

  describe('finish()', () => {
    it('marks the run as finished with counts', () => {
      progress.start();
      progress.finish({ customers: 10 });
      const state = progress.getState();
      expect(state.isRunning).toBe(false);
      expect(state.stage).toBe('finished');
      expect(state.counts).toEqual({ customers: 10 });
      expect(state.lastRun).toBeTypeOf('number');
    });
  });

  describe('fail()', () => {
    it('marks the run as failed with error message', () => {
      progress.start();
      progress.fail('Something went wrong');
      const state = progress.getState();
      expect(state.isRunning).toBe(false);
      expect(state.stage).toBe('failed');
      expect(state.lastError).toBe('Something went wrong');
    });

    it('uses default message when none provided', () => {
      progress.start();
      progress.fail();
      expect(progress.getState().lastError).toBe('Sync failed');
    });
  });
});
