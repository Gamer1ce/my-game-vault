import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { classifyHighlights, createHighlightCategoryStore } from '../src/highlight-categories.mjs';
import { filteredHighlightEntries, highlightCategories } from '../public/highlight-gallery.js';
const video = (filename, extra = {}) => ({filename, type:'video', ...extra});
test('时间戳录像使用游戏文件夹名，平台和通用文件夹不作为游戏', () => {
  const files = ['SWITCH/Splatoon 3（斯普拉遁 3）/2024090221114100_c.mp4', 'PS5/CREATE/Video Clips/DEATH STRANDING 2_ ON THE BEACH/202510.mp4', 'XBOX/Xbox Game DVR/2025011122515800_s.mp4', 'SWITCH/其他/2025011122515800_s.mp4'];
  assert.deepEqual(classifyHighlights(files.map(n=>video(n))).map(x=>x.gameCategory), ['Splatoon 3','DEATH STRANDING 2  ON THE BEACH','未分类','未分类']);
});
test('录屏命名和全角中英文分类统一', () => {
  const names = ['The Finals 2026.09.09.DVR.mp4','THE FINALS-2026_05_03.mp4','女神异闻录３ Reload-2025_08_07.mp4','Apex Legends_20251207181720.webm','[星露谷物语] 春日.mp4'];
  assert.deepEqual(classifyHighlights(names.map(n=>video(n))).map(x=>x.gameCategory), ['THE FINALS','THE FINALS','Persona 3 Reload','Apex Legends','星露谷物语']);
});
test('日期和通用进程名保留未分类', () => {
  assert.deepEqual(classifyHighlights(['2025080403122100_c.mp4','Wingdk 2025.09.26.mp4','Java-runtime-beta 2026.02.24.mp4'].map(n=>video(n))).map(x=>x.gameCategory), ['未分类','未分类','未分类']);
});
test('新游戏自动归类且按游戏库规范名称', () => {
  assert.equal(classifyHighlights([video('New Game-2026_09_11.mp4')])[0].gameCategory,'New Game');
  assert.equal(classifyHighlights([video('ELDEN_RING-2026_09_11.mp4')],{games:[{title:'ELDEN RING'}]})[0].gameCategory,'ELDEN RING');
});
test('前缀规则持久保存并适用于新录像，单文件纠正优先', () => {
  const db=new DatabaseSync(':memory:');const store=createHighlightCategoryStore(db);
  const a=video('Wingdk 2025.09.26.mp4'), b=video('Wingdk 2026.09.11.mp4');
  store.set(a,'我的游戏',true);
  assert.deepEqual(classifyHighlights([a,b],store.snapshot()).map(x=>x.gameCategory),['我的游戏','我的游戏']);
  store.set(b,'另一款');assert.equal(classifyHighlights([b],store.snapshot())[0].gameCategory,'另一款');
  store.set(a,'',true);assert.equal(classifyHighlights([a],store.snapshot())[0].gameCategory,'未分类');
  assert.throws(()=>store.set(a,'x'.repeat(101)));assert.throws(()=>store.set(a,'bad\nlabel'));db.close();
});
test('不同来源同名文件互不覆盖', () => {
  const db=new DatabaseSync(':memory:');const store=createHighlightCategoryStore(db);
  const a=video('clip.mp4'),b=video('clip.mp4',{storageSource:'baidu',playbackId:'123'});store.set(a,'游戏');
  assert.deepEqual(classifyHighlights([a,b],store.snapshot()).map(x=>x.gameCategory),['游戏','未分类']);db.close();
});
test('分类搜索排序仍保持正确的播放索引', () => {
  const items=[video('A 2026.mp4',{gameCategory:'A',size:20}),video('B.mp4',{gameCategory:'B',size:1}),video('A 2025.mp4',{gameCategory:'A',size:10})];
  assert.deepEqual(filteredHighlightEntries(items,'video',{category:'A',sort:'smallest'}).map(x=>x.sourceIndex),[2,0]);
  assert.deepEqual(filteredHighlightEntries(items,'video',{query:'２０２６'}).map(x=>x.sourceIndex),[0]);
  assert.deepEqual(highlightCategories(items),[['A',2],['B',1]]);assert.equal(items[0].size,20);
});
