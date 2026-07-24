import test from "node:test";
import assert from "node:assert/strict";
import { createBirthdayHintCycle } from "../public/birthday-hint.js";

function fakeScheduler() {
  const pending = [];
  return {
    pending,
    setTimer(callback, delay) {
      const item = { callback, delay, cancelled: false };
      pending.push(item);
      return item;
    },
    clearTimer(item) {
      if (item) item.cancelled = true;
    },
    runNext() {
      const item = pending.shift();
      assert.ok(item, "应存在待执行的定时任务");
      if (!item.cancelled) item.callback();
      return item.delay;
    }
  };
}

test("生日线索经过故障切换、显示十五秒并循环恢复", () => {
  const scheduler = fakeScheduler();
  const states = [];
  const glitches = [];
  const cycle = createBirthdayHintCycle({
    renderHint: (visible) => states.push(visible),
    renderGlitch: (active) => glitches.push(active),
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer
  });

  cycle.setActive(true);
  assert.deepEqual(states, [false]);
  assert.equal(scheduler.runNext(), 5_000);
  assert.equal(glitches.at(-1), true);
  assert.equal(scheduler.runNext(), 650);
  assert.equal(states.at(-1), true);
  assert.equal(glitches.at(-1), false);
  assert.equal(scheduler.runNext(), 15_000);
  assert.equal(glitches.at(-1), true);
  assert.equal(scheduler.runNext(), 650);
  assert.equal(states.at(-1), false);
  assert.equal(scheduler.runNext(), 30_000);
  assert.equal(glitches.at(-1), true);
});

test("生日信号关闭时立即恢复普通留言框并取消循环", () => {
  const scheduler = fakeScheduler();
  const states = [];
  const cycle = createBirthdayHintCycle({
    renderHint: (visible) => states.push(visible),
    renderGlitch: () => {},
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer
  });

  cycle.setActive(true);
  cycle.setActive(false);
  assert.equal(states.at(-1), false);
  assert.equal(scheduler.pending.every((item) => item.cancelled), true);
});
