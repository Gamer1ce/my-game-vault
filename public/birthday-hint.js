export function createBirthdayHintCycle({
  renderHint,
  renderGlitch,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  initialDelay = 5_000,
  glitchDuration = 650,
  visibleDuration = 15_000
}) {
  let active = false;
  let timer = null;

  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const schedule = (callback, delay) => {
    cancelTimer();
    timer = setTimer(callback, delay);
  };

  const showHint = () => {
    if (!active) return;
    renderGlitch(true);
    schedule(() => {
      if (!active) return;
      renderHint(true);
      renderGlitch(false);
      schedule(hideHint, visibleDuration);
    }, glitchDuration);
  };

  const hideHint = () => {
    if (!active) return;
    renderGlitch(true);
    schedule(() => {
      if (!active) return;
      renderHint(false);
      renderGlitch(false);
      cancelTimer();
    }, glitchDuration);
  };

  return {
    setActive(nextActive) {
      const next = Boolean(nextActive);
      if (next === active) return;
      active = next;
      cancelTimer();
      renderGlitch(false);
      renderHint(false);
      if (active) schedule(showHint, initialDelay);
    },
    stop() {
      active = false;
      cancelTimer();
      renderGlitch(false);
      renderHint(false);
    }
  };
}
