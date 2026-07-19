import test from "node:test";
import assert from "node:assert/strict";
import { detectFastDownScroll } from "../public/fast-scroll.js";

test("快速向下滑动超过阈值时显示页面导航", () => {
  const result = detectFastDownScroll({ startY: 300, startAt: 1000 }, 760, 1180);
  assert.equal(result.triggered, true);
  assert.equal(result.startY, 760);
});

test("缓慢滚动只重置检测窗口", () => {
  const result = detectFastDownScroll({ startY: 300, startAt: 1000 }, 760, 1300);
  assert.deepEqual(result, { startY: 760, startAt: 1300, triggered: false });
});

test("向上滚动不会误触发一键到底部", () => {
  const result = detectFastDownScroll({ startY: 900, startAt: 1000 }, 500, 1100);
  assert.deepEqual(result, { startY: 500, startAt: 1100, triggered: false });
});
