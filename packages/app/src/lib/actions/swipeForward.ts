import { appDimensions } from '$lib/state/appDimensions.js';
import { SWIPE_THRESHOLD, DEADZONE_RATIO, EDGE_ZONE_RATIO } from '../constants.js';

interface SwipeForwardOptions {
    onOpen: () => void;
}

export function swipeForward(node: HTMLElement, options: SwipeForwardOptions) {
    let tracking = false;
    let startX = 0;
    let startY = 0;
    let locked = false;
    let rejected = false;
    let progress = 0;
    let opts = options;

    function onStart(e: TouchEvent) {
        const touch = e.touches[0];
        const edgeZone = appDimensions.width * EDGE_ZONE_RATIO;
        if (touch.clientX >= appDimensions.width - edgeZone) {
            tracking = true;
            locked = false;
            rejected = false;
            progress = 0;
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
        }

        e.preventDefault();
        progress = Math.max(0, Math.min(1, Math.abs(dx) / appWidth));
    }

    function onEnd() {
        const shouldOpen = tracking && locked && progress > SWIPE_THRESHOLD;
        tracking = false;
        locked = false;
        rejected = false;
        progress = 0;
        if (shouldOpen) opts.onOpen();
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
        }
    };
}
