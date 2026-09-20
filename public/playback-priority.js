// Suspend only this page's non-media reads. Never cancel/replay a mutation.
export function isBackgroundRead(url, options = {}) {
  return String(options.method || "GET").toUpperCase() === "GET"
    && !String(url).split("?")[0].endsWith("/api/highlights/playback");
}

export function createPlaybackPriority() {
  let active = false;
  const reads = new Set();
  const waiting = new Set();
  const deferred = new Map();
  const interrupted = new Error("Background read suspended for video playback");

  function wait(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!active) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => { waiting.delete(finish); signal?.removeEventListener("abort", abort); };
      waiting.add(finish);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  return {
    get active() { return active; },
    setActive(value) {
      if (active === Boolean(value)) return;
      active = Boolean(value);
      if (active) {
        for (const controller of reads) controller.abort(interrupted);
      } else {
        for (const resume of [...waiting]) resume();
        const tasks = [...deferred.entries()];
        deferred.clear();
        for (const [key, task] of tasks) {
          if (active) deferred.set(key, task);
          else task();
        }
      }
    },
    defer(key, task) {
      if (!active) return false;
      deferred.set(key, task);
      return true;
    },
    async read(operation, signal) {
      for (;;) {
        await wait(signal);
        // Opening another video may race with the resume microtask.
        if (active) continue;
        const controller = new AbortController();
        const cancel = () => controller.abort(signal.reason);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
        reads.add(controller);
        try {
          const result = await operation(controller.signal);
          // Hold completed results too, so their render cannot load new images.
          await wait(signal);
          return result;
        } catch (error) {
          if (signal?.aborted) throw signal.reason;
          if (controller.signal.reason !== interrupted) throw error;
        } finally {
          reads.delete(controller);
          signal?.removeEventListener("abort", cancel);
        }
      }
    }
  };
}

const EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

// Removing an incomplete image source asks the browser to cancel it. Completed
// images stay intact; cached bytes and the gallery's lazy-loading policy survive.
export function createBackgroundImagePause(roots, Observer = globalThis.MutationObserver) {
  let active = false;
  const saved = new Map();
  const scan = () => {
    if (!active) return;
    for (const root of roots) {
      for (const image of root.querySelectorAll("img")) {
        if (saved.has(image) || (image.complete && image.naturalWidth > 0)) continue;
        const src = image.getAttribute("src");
        const srcset = image.getAttribute("srcset");
        if (!src && !srcset) continue;
        saved.set(image, { src, srcset });
        image.setAttribute("data-playback-deferred", "");
        image.removeAttribute("srcset");
        image.setAttribute("src", EMPTY_IMAGE);
      }
    }
  };
  const observer = Observer ? new Observer(scan) : null;
  return {
    setActive(value) {
      if (active === Boolean(value)) return;
      active = Boolean(value);
      if (active) {
        scan();
        for (const root of roots) observer?.observe(root, {
          childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset"]
        });
      } else {
        observer?.disconnect();
        for (const [image, attributes] of saved) {
          if (!image.isConnected) continue;
          for (const [name, value] of Object.entries(attributes)) {
            if (value === null) image.removeAttribute(name);
            else image.setAttribute(name, value);
          }
          image.removeAttribute("data-playback-deferred");
        }
        saved.clear();
      }
    }
  };
}
