export function detectFastDownScroll(state, position, time, options = {}) {
  const windowMs = Number(options.windowMs || 220);
  const distance = Number(options.distance || 420);
  const minimumPosition = Number(options.minimumPosition || 700);
  const startY = Number(state?.startY || 0);
  const startAt = Number(state?.startAt || 0);

  if (position < startY || time - startAt > windowMs) {
    return { startY: position, startAt: time, triggered: false };
  }
  if (position > minimumPosition && position - startY > distance) {
    return { startY: position, startAt: time, triggered: true };
  }
  return { startY, startAt, triggered: false };
}
