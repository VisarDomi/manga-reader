// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    enqueue,
    isPending,
    pendingKinds,
    resetQueue,
    runPendingDrain,
} from '../../src/core/update-queue';

describe('update queue (scrollend + 100ms)', () => {
    beforeEach(() => {
        resetQueue();
    });

    afterEach(() => {
        vi.useRealTimers();
        resetQueue();
    });

    it('an idle page drains 100ms after enqueue — no scroll needed', async () => {
        vi.useFakeTimers();
        const applied: string[] = [];
        enqueue('history', [() => applied.push('a'), () => applied.push('b'), () => applied.push('c')]);
        expect(applied).toEqual([]);

        await vi.advanceTimersByTimeAsync(99);
        expect(applied).toEqual([]);

        await vi.advanceTimersByTimeAsync(1);
        expect(applied).toEqual(['a', 'b', 'c']);
        expect(pendingKinds()).toEqual([]);
    });

    it('a scroll before the timer fires postpones the burst until quiet', async () => {
        vi.useFakeTimers();
        const applied: string[] = [];
        enqueue('history', [() => applied.push('x')]);
        await vi.advanceTimersByTimeAsync(50);
        window.dispatchEvent(new Event('scroll'));
        // The timer fires at 100ms, sees the recent scroll, and re-arms...
        await vi.advanceTimersByTimeAsync(100);
        expect(applied).toEqual([]);
        // ...then drains once 100ms of quiet follows.
        await vi.advanceTimersByTimeAsync(100);
        expect(applied).toEqual(['x']);
    });

    it('a newer batch supersedes a pending one (latest-wins)', async () => {
        vi.useFakeTimers();
        const applied: string[] = [];
        enqueue('history', ['a1', 'a2'].map(step => () => applied.push(step)));
        enqueue('history', ['b1', 'b2'].map(step => () => applied.push(step)));
        window.dispatchEvent(new Event('scrollend'));
        await vi.advanceTimersByTimeAsync(100);
        expect(applied).toEqual(['b1', 'b2']);
        expect(isPending('history')).toBe(false);
    });

    it('a later scrollend re-arms the delay', async () => {
        vi.useFakeTimers();
        const applied: string[] = [];
        enqueue('history', [() => applied.push('x')]);
        window.dispatchEvent(new Event('scrollend'));
        await vi.advanceTimersByTimeAsync(50);
        window.dispatchEvent(new Event('scrollend'));
        await vi.advanceTimersByTimeAsync(50);
        expect(applied).toEqual([]);
        await vi.advanceTimersByTimeAsync(50);
        expect(applied).toEqual(['x']);
    });

    it('pageshow arms the burst (bfcache restore applies without a scroll)', async () => {
        vi.useFakeTimers();
        const applied: string[] = [];
        enqueue('history', [() => applied.push('x')]);
        window.dispatchEvent(new Event('pageshow'));
        await vi.advanceTimersByTimeAsync(99);
        expect(applied).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(applied).toEqual(['x']);
    });

    it('an endless stream of scroll events only delays the burst — it converges', async () => {
        vi.useFakeTimers();
        const applied: string[] = [];
        enqueue('history', [() => applied.push('x')]);
        // Scroll every 50ms for 600ms: each fire re-arms instead of draining.
        for (let i = 0; i < 12; i++) {
            window.dispatchEvent(new Event('scroll'));
            await vi.advanceTimersByTimeAsync(50);
        }
        expect(applied).toEqual([]);
        // The stream stops; 100ms of quiet later the burst applies.
        await vi.advanceTimersByTimeAsync(100);
        expect(applied).toEqual(['x']);
    });

    it('keeps distinct kinds independent and drains them together', async () => {
        vi.useFakeTimers();
        const applied: string[] = [];
        enqueue('history', [() => applied.push('h')]);
        enqueue('catalog', [() => applied.push('c')]);
        expect(pendingKinds().sort()).toEqual(['catalog', 'history']);
        runPendingDrain();
        expect(applied.sort()).toEqual(['c', 'h']);
        expect(pendingKinds()).toEqual([]);
    });
});
