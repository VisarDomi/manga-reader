import { appDimensions } from '$lib/state/appDimensions.js';
import { SWIPE_THRESHOLD, DEADZONE_RATIO, EDGE_ZONE_RATIO } from '../constants.js';

interface SwipeForwardOptions {
    onPrepare: () => boolean;
    onCommit: () => void;
    onCancel?: () => void;
    ui: { forwardSwipeProgress: number; isForwardSwiping: boolean; forwardSwipeAnimating: boolean };
}

export function swipeForward(node: HTMLElement, options: SwipeForwardOptions) {
    let tracking = false;
    let startX = 0;
    let startY = 0;
    let locked = false;
    let rejected = false;
    let progress = 0;
    let opened = false;
    let opts = options;

    function setProgress(next: number) {
        progress = Math.max(0, Math.min(1, next));
        document.documentElement.style.setProperty('--forward-swipe-progress', `${(1 - progress) * 100}%`);
    }

    function clearProgress() {
        progress = 0;
        opts.ui.forwardSwipeProgress = 0;
        document.documentElement.style.removeProperty('--forward-swipe-progress');
    }

    function onStart(e: TouchEvent) {
        const touch = e.touches[0];
        const edgeZone = appDimensions.width * EDGE_ZONE_RATIO;
        if (touch.clientX >= appDimensions.width - edgeZone) {
            tracking = true;
            locked = false;
            rejected = false;
            progress = 0;
            opened = false;
            document.documentElement.style.removeProperty('--forward-swipe-progress');
            startX = touch.clientX;
            startY = touch.clientY;
        }
    }

    function onMove(e: TouchEvent) {
        if (!tracking || rejected) return;

        const touch = e.touches[0];
        const dx = touch.clientX - startX;
        const dy = touch.clientY - startY;
        const appWidth = appDimensions.width;

        if (!locked) {
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);
            const deadzone = appWidth * DEADZONE_RATIO;
            if (absDx < deadzone && absDy < deadzone) return;
            if (absDy > absDx || dx > 0) {
                rejected = true;
                tracking = false;
                return;
            }
            locked = true;
            opened = opts.onPrepare();
            if (!opened) {
                rejected = true;
                tracking = false;
                clearProgress();
                return;
            }
            setProgress(0);
            opts.ui.isForwardSwiping = true;
        }

        e.preventDefault();
        setProgress(Math.abs(dx) / appWidth);
    }

    function onEnd() {
        if (!tracking || !locked) {
            tracking = false;
            return;
        }

        const shouldKeepOpen = opened && progress > SWIPE_THRESHOLD;
        tracking = false;
        locked = false;
        rejected = false;
        progress = 0;
        opened = false;

        opts.ui.forwardSwipeAnimating = true;

        if (shouldKeepOpen) {
            setProgress(1);
            setTimeout(() => {
                opts.onCommit();
                opts.ui.isForwardSwiping = false;
                opts.ui.forwardSwipeAnimating = false;
                clearProgress();
            }, 250);
        } else {
            setProgress(0);
            setTimeout(() => {
                opts.onCancel?.();
                opts.ui.isForwardSwiping = false;
                opts.ui.forwardSwipeAnimating = false;
                clearProgress();
            }, 250);
        }
    }

    node.addEventListener('touchstart', onStart, { passive: true });
    node.addEventListener('touchmove', onMove, { passive: false });
    node.addEventListener('touchend', onEnd, { passive: true });

    return {
        update(newOptions: SwipeForwardOptions) {
            opts = newOptions;
        },
        destroy() {
            node.removeEventListener('touchstart', onStart);
            node.removeEventListener('touchmove', onMove);
            node.removeEventListener('touchend', onEnd);
            clearProgress();
        }
    };
}
