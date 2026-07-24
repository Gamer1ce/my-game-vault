import test from "node:test";
import assert from "node:assert/strict";
import { birthdayTicketFor, containsBirthdayWish } from "../src/birthday-easter-egg.mjs";

test("生日彩蛋识别包含生日快乐的完整句子", () => {
  assert.equal(containsBirthdayWish("Gamer1ce，生日快乐！愿新世界常有惊喜。"), true);
  assert.equal(containsBirthdayWish("生 日 快 乐"), true);
  assert.equal(containsBirthdayWish("祝你今天开心"), false);
});

test("生日彩蛋只在上海时区每年八月十六日签发回执", () => {
  assert.equal(birthdayTicketFor("生日快乐", 42, new Date("2026-08-15T15:59:59Z")), null);
  assert.deepEqual(birthdayTicketFor("祝你生日快乐！", 42, new Date("2026-08-15T16:00:00Z")), {
    code: "20260816-000042",
    date: "2026-08-16"
  });
  assert.deepEqual(birthdayTicketFor("生 日 快 乐", 7, new Date("2026-08-16T15:59:59Z")), {
    code: "20260816-000007",
    date: "2026-08-16"
  });
  assert.equal(birthdayTicketFor("生日快乐", 42, new Date("2026-08-16T16:00:00Z")), null);
  assert.equal(birthdayTicketFor("普通留言", 42, new Date("2026-08-16T04:00:00Z")), null);
});
