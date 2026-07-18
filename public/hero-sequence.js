export const HERO_SEQUENCE_STEPS = Object.freeze([
  Object.freeze({ at: 1000, text: "正在入侵…", state: "breaching" }),
  Object.freeze({ at: 4000, text: "入侵成功", state: "success" }),
  Object.freeze({ at: 5000, text: "欢迎接入万界圣所", state: "connected" })
]);

export const HERO_SEQUENCE_LOOP_MS = 4600;

export function createHeroSequence({
  transition,
  glitch,
  schedule = globalThis.setTimeout,
  repeat = globalThis.setInterval
}) {
  let started = false;

  return {
    start() {
      if (started) return false;
      started = true;
      glitch();

      for (const step of HERO_SEQUENCE_STEPS) {
        schedule(() => {
          transition(step);
          glitch();
          if (step.state === "connected") repeat(glitch, HERO_SEQUENCE_LOOP_MS);
        }, step.at);
      }
      return true;
    }
  };
}
