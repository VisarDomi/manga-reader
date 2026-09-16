var ReaderCore = (function(exports) {
  "use strict";
  function onSettledScroll(callback) {
    let scrolling = false;
    let touching = false;
    let active = true;
    const schedule = () => {
      if (scrolling || touching || !active || document.hidden) return;
      callback();
    };
    window.addEventListener("scroll", () => {
      scrolling = true;
    }, { passive: true });
    window.addEventListener("scrollend", () => {
      scrolling = false;
      schedule();
    });
    window.addEventListener("touchstart", () => {
      touching = true;
    }, { passive: true });
    const touchFinished = (event) => {
      touching = event.touches.length > 0;
      if (!touching) schedule();
    };
    window.addEventListener("touchend", touchFinished, { passive: true });
    window.addEventListener("touchcancel", touchFinished, { passive: true });
    window.addEventListener("pagehide", () => {
      active = false;
      touching = false;
    });
    window.addEventListener("pageshow", () => {
      active = true;
      scrolling = false;
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        scrolling = false;
        touching = false;
      }
    });
    return schedule;
  }
  const FIRST_IMAGE_RETRY_MS = 1e3;
  const MAX_IMAGE_RETRY_MS = 2147483647;
  class ImageRetryRegistry {
    trackedImages = /* @__PURE__ */ new Set();
    retryStates = /* @__PURE__ */ new WeakMap();
    retryTimer = null;
    register(image) {
      this.trackedImages.add(image);
      this.scheduleRetry();
    }
    scheduleRetry() {
      if (this.retryTimer !== null || this.trackedImages.size === 0) return;
      this.retryTimer = window.setTimeout(() => this.runRetry(), FIRST_IMAGE_RETRY_MS);
    }
    runRetry() {
      this.retryTimer = null;
      if (document.hidden) {
        this.scheduleRetry();
        return;
      }
      const now = Date.now();
      for (const image of [...this.trackedImages]) {
        if (!image.isConnected) {
          this.trackedImages.delete(image);
          continue;
        }
        const source = image.getAttribute("src");
        if (!source?.trim()) {
          this.trackedImages.delete(image);
          continue;
        }
        if (image.naturalWidth > 0) {
          this.trackedImages.delete(image);
          continue;
        }
        let state = this.retryStates.get(image);
        if (!state || state.source !== source) {
          state = { source, delay: FIRST_IMAGE_RETRY_MS, retryAt: now };
          this.retryStates.set(image, state);
        }
        if (!image.complete || now < state.retryAt) continue;
        const url = new URL(source);
        if (url.origin === location.origin) url.searchParams.set("retry", Date.now().toString());
        image.src = "";
        image.src = url.href;
        state.delay = Math.min(state.delay * 2, MAX_IMAGE_RETRY_MS);
        state.retryAt = now + state.delay;
        state.source = image.src;
      }
      this.scheduleRetry();
    }
  }
  function isChapterComplete(progress) {
    return progress.imageIndex >= progress.totalImages - 1;
  }
  function progressBySeries(entries) {
    const result = /* @__PURE__ */ new Map();
    for (const entry of entries) result.set(entry.seriesSlug, entry);
    return result;
  }
  function resolveHistory(input) {
    const localIndex = progressBySeries(input.progress);
    return input.cards.map((card) => {
      const local = localIndex.get(card.historyId);
      const localChapterIndex = local === void 0 ? -1 : card.chapterIds.indexOf(local.chapterId);
      const chapters = card.chapterIds.map((chapterId, chapterIndex) => {
        const state = { chapterId, read: false, partial: false };
        if (local !== void 0 && localChapterIndex !== -1) {
          if (chapterIndex > localChapterIndex) state.read = true;
          if (chapterIndex === localChapterIndex) {
            state.partial = !isChapterComplete(local);
            state.read = isChapterComplete(local);
            state.localImageIndex = local.imageIndex;
          }
        }
        return state;
      });
      let cover;
      if (local !== void 0 && !isChapterComplete(local)) {
        cover = {
          kind: 1,
          chapterId: local.chapterId,
          imageIndex: local.imageIndex
        };
      } else if (local !== void 0) {
        cover = {
          kind: 2,
          latestLocalComplete: {
            chapterId: local.chapterId,
            imageIndex: local.imageIndex
          }
        };
      } else {
        cover = {
          kind: 0
          /* None */
        };
      }
      return { seriesSlug: card.seriesSlug, cover, chapters };
    });
  }
  function formatUploadedAt(value) {
    if (value === null || value.trim() === "") return "";
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return value;
    const elapsed = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(elapsed / 6e4);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "last week" : `${weeks} weeks ago`;
  }
  function unlockCountdown(unlockAt) {
    const remaining = new Date(unlockAt).getTime() - Date.now();
    if (remaining <= 0) return "0m";
    const hours = Math.floor(remaining / 36e5);
    const minutes = Math.floor(remaining % 36e5 / 6e4);
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  }
  function statusText(loaded, total, loading) {
    const count = total === void 0 ? `${loaded}` : `${loaded} of ${total}`;
    return loading ? `Loaded ${count} series · loading more…` : `Loaded ${count} series`;
  }
  exports.ImageRetryRegistry = ImageRetryRegistry;
  exports.formatUploadedAt = formatUploadedAt;
  exports.onSettledScroll = onSettledScroll;
  exports.resolveHistory = resolveHistory;
  exports.statusText = statusText;
  exports.unlockCountdown = unlockCountdown;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
})({});
