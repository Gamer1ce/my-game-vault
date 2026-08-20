import assert from "node:assert/strict";
import test from "node:test";
import { createHeroSequence, HERO_SEQUENCE_COMPLETE_MS, HERO_SEQUENCE_LOOP_MS } from "../public/hero-sequence.js";

test("接入序列按第 1、4、5 秒切换文案并在最终状态循环故障", () => {
  const scheduled = [];
  const repeated = [];
  const transitions = [];
  let glitches = 0;
  let completed = 0;
  const sequence = createHeroSequence({
    transition: (step) => transitions.push(step),
    glitch: () => { glitches += 1; },
    complete: () => { completed += 1; },
    schedule: (callback, delay) => scheduled.push({ callback, delay }),
    repeat: (callback, delay) => repeated.push({ callback, delay })
  });

  assert.equal(sequence.start(), true);
  assert.equal(sequence.start(), false);
  assert.equal(glitches, 1);
  assert.deepEqual(scheduled.map(({ delay }) => delay), [1000, 4000, 5000, HERO_SEQUENCE_COMPLETE_MS]);

  scheduled.slice(0, 3).forEach(({ callback }) => callback());
  assert.deepEqual(transitions.map(({ text }) => text), ["正在入侵…", "入侵成功", "欢迎接入万界圣所"]);
  assert.equal(glitches, 4);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].delay, HERO_SEQUENCE_LOOP_MS);
  scheduled[3].callback();
  assert.equal(completed, 1);

  repeated[0].callback();
  assert.equal(glitches, 5);
});
