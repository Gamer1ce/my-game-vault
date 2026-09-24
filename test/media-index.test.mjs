import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readMediaIndex } from "../src/media-index.mjs";

test("media scans run outside HTTP loop and concurrent reads share one worker", async t => {
  const dir=mkdtempSync(path.join(tmpdir(),"media-index-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  writeFileSync(path.join(dir,"clip.mp4"),"fixture");writeFileSync(path.join(dir,".secret.mp4"),"hidden");
  const first=readMediaIndex(dir),second=readMediaIndex(dir);assert.equal(first,second);
  let yielded=false;await new Promise(resolve=>setImmediate(()=>{yielded=true;resolve();}));assert.equal(yielded,true);
  const files=await first;assert.equal(files.length,1);assert.equal(files[0].filename,"clip.mp4");assert.equal(files[0].streamUrl,null);
  writeFileSync(path.join(dir,"next.mp4"),"next");assert.equal((await readMediaIndex(dir)).length,2);
});
