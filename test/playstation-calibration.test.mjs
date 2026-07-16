import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  calibratedFinalMinutes,
  matchPlaystationCalibrationRecord,
  parsePlaystationGameplayWorkbook,
  playstationCalibrationFingerprint
} from "../src/playstation-calibration.mjs";

test("从 Sony Gameplay Online 第四行表头聚合秒数与逐日历史", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('"Gameplay Online"');
  sheet.addRow(["说明"]);
  sheet.addRow([]);
  sheet.addRow(["Gameplay Online"]);
  sheet.addRow(["Name", "Date Of Play", "Session Duration", "Total Session"]);
  sheet.addRow(["Game", "2026-07-01", 60, 1]);
  sheet.addRow(["Game", "2026-07-01", 30, 1]);
  sheet.addRow(["Game", "2026-07-02", 60, 1]);

  const parsed = parsePlaystationGameplayWorkbook(workbook);
  assert.equal(parsed.records.length, 1);
  assert.deepEqual(parsed.records[0], {
    title: "Game",
    minutes: 3,
    lastPlayed: "2026-07-02",
    history: [
      { date: "2026-07-01", minutes: 2 },
      { date: "2026-07-02", minutes: 1 }
    ]
  });
});

test("PlayStation 校准使用本地化标题提示并按日期选择正确世代", () => {
  const match = matchPlaystationCalibrationRecord({ title: "戰地風雲™ 2042", lastPlayed: "2023-07-31" }, [
    { title: "Battlefield™ 2042", platformId: "CUSA23249_00", lastPlayed: "2022-01-25" },
    { title: "Battlefield™ 2042", platformId: "PPSA01464_00", lastPlayed: "2023-07-31" }
  ]);
  assert.equal(match.game.platformId, "PPSA01464_00");
  assert.equal(match.method, "title-alias");
});

test("校准最终时长只叠加校准后的平台正向增量", () => {
  assert.equal(calibratedFinalMinutes(1000, 1200, 1000), 1200);
  assert.equal(calibratedFinalMinutes(1060, 1200, 1000), 1260);
  assert.equal(calibratedFinalMinutes(900, 1200, 1000), 1200);
  assert.equal(calibratedFinalMinutes(900, null, null), 900);
});

test("校准内容指纹不受记录顺序影响", () => {
  const left = [
    { title: "B", minutes: 2, lastPlayed: "2026-01-02", history: [] },
    { title: "A", minutes: 1, lastPlayed: "2026-01-01", history: [] }
  ];
  assert.equal(playstationCalibrationFingerprint(left), playstationCalibrationFingerprint([...left].reverse()));
});
