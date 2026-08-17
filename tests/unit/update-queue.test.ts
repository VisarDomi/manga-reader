import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    enqueue,
    isPending,
    pendingKinds,
    resetQueue,
    setIdleDeadlineSource,
    setIdleScheduler,
} from '../../src/core/update-queue';

describe('update queue', () => {
    let callbacks: Array<() => void>;
    // A real IdleDeadline.timeRemaining() decreases as the callback consumes it,
    // and each new idle callback receives a fresh deadline.
    let perDrainBudget = Infinity;
    let remaining = Infinity;

    beforeEach(() => {
        callbacks = [];
        perDrainBudget = Infinity;
        setIdleScheduler(callback => callbacks.push(callback));
        setIdleDeadlineSource(() => {
            remaining = perDrainBudget;
            return { timeRemaining: () => Math.max(0, remaining--) };
        });
    });

    afterEach(() => {
        resetQueue();
        setIdleScheduler(callback => {
            throw new Error('scheduler was not injected in this test');
        });
        setIdleDeadlineSource(() => null);
    });

    const flush = () => {
        while (callbacks.length > 0) {
            const callback = callbacks.shift()!;
            callback();
        }
    };

    it('applies every step exactly once in order', () => {
        const applied: string[] = [];
        enqueue('history', [() => applied.push('a'), () => applied.push('b'), () => applied.push('c')]);
        flush();
        expect(applied).toEqual(['a', 'b', 'c']);
        expect(pendingKinds()).toEqual([]);
    });

    it('stops at the idle budget and reschedules', () => {
        const applied: string[] = [];
        perDrainBudget = 1;
        enqueue('history', [() => applied.push('a'), () => applied.push('b'), () => applied.push('c')]);
        flush();
        expect(applied).toEqual(['a', 'b', 'c']);
        expect(pendingKinds()).toEqual([]);
    });

    it('drops a superseded batch when a newer one arrives (latest-wins)', () => {
        const applied: string[] = [];
        perDrainBudget = 2;
        enqueue('history', ['a1', 'a2', 'a3', 'a4'].map(step => () => applied.push(step)));
        // first idle callback applies only a1, a2
        callbacks.shift()!();
        expect(applied).toEqual(['a1', 'a2']);
        expect(isPending('history')).toBe(true);

        perDrainBudget = Infinity;
        enqueue('history', ['b1', 'b2'].map(step => () => applied.push(step)));
        flush();
        expect(applied).toEqual(['a1', 'a2', 'b1', 'b2']);
        expect(isPending('history')).toBe(false);
    });

    it('keeps distinct kinds independent', () => {
        const applied: string[] = [];
        enqueue('history', [() => applied.push('h')]);
        enqueue('catalog', [() => applied.push('c')]);
        expect(pendingKinds().sort()).toEqual(['catalog', 'history']);
        flush();
        expect(applied.sort()).toEqual(['c', 'h']);
    });

    it('never runs without budget and stays scheduled', () => {
        const applied: string[] = [];
        perDrainBudget = 0;
        enqueue('history', [() => applied.push('x')]);
        expect(callbacks).toHaveLength(1);
        callbacks.shift()!();
        expect(applied).toEqual([]);
        expect(isPending('history')).toBe(true);
        expect(callbacks).toHaveLength(1);
    });
});
