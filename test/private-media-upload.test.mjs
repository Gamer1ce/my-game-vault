import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrivateMedia } from "../src/private-media.mjs";
import { createPrivateMediaUpload, uploadFilename, UPLOAD_CHUNK_BYTES, UPLOAD_MAX_BYTES } from "../src/private-media-upload.mjs";

test("Dai-only chunk upload preserves bytes, resumes by offset and publishes only completed video", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "private-upload-"));
  const mediaUser = req => req.get("x-user") === "dai" ? {id:"dai-id",username:"戴卓然",displayName:"戴卓然",library:"dai"} : req.get("x-user") === "other" ? {id:"other-id",username:"other",library:"dai"} : null;
  const media = createPrivateMedia({ dataDirectory: dir, directory: dir, mediaUser });
  const app = express(); app.use(express.json()); app.use("/api/my-media", media.router);
  const server = app.listen(0,"127.0.0.1"); await new Promise(resolve=>server.once("listening",resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>{media.close();server.closeAllConnections();server.close();rmSync(dir,{recursive:true,force:true});});
  async function call(route, {method="GET",body,user="dai",headers={}}={}) {
    const binary=Buffer.isBuffer(body);
    const r=await fetch(origin+"/api/my-media"+route,{method,headers:{Origin:origin,"x-user":user,...(body?{"Content-Type":binary?"application/octet-stream":"application/json"}:{}),...headers},body:body?(binary?body:JSON.stringify(body)):undefined});
    const text=await r.text();let result;try{result=JSON.parse(text);}catch{result=text;}return {status:r.status,result};
  }
  const video=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from("ftypisom"),Buffer.alloc(200,0x61)]);
  const create=filename=>call("/uploads",{method:"POST",body:{filename,size:video.length}});
  assert.equal((await call("/uploads",{method:"POST",body:{filename:"test.mp4",size:video.length},user:""})).status,401);
  assert.equal((await call("/uploads",{method:"POST",body:{filename:"test.mp4",size:video.length},user:"other"})).status,403);
  assert.equal((await call("/uploads",{method:"POST",body:{filename:"test.mp4",size:video.length},headers:{Origin:"https://evil.test"}})).status,403);
  assert.equal((await create("../outside.mp4")).status,400);
  assert.equal((await call("/uploads",{method:"POST",body:{filename:"huge.mp4",size:UPLOAD_MAX_BYTES+1}})).status,400);
  const made=await create("test.mp4");assert.equal(made.status,201);const endpoint=`/uploads/${made.result.id}`;
  assert.equal((await call("")).result.canUpload,true);assert.equal((await call("",{user:"other"})).result.canUpload,false);
  assert.equal((await call("")).result.videos.length,0);
  let part=await call(endpoint,{method:"PUT",body:video.subarray(0,90),headers:{"X-Upload-Offset":"0"}});assert.equal(part.status,200);assert.equal(part.result.offset,90);
  assert.equal((await call(endpoint)).result.offset,90);
  assert.equal((await call(endpoint,{method:"PUT",body:video.subarray(90),headers:{"X-Upload-Offset":"0"}})).status,409);
  assert.equal((await call(endpoint+"/complete",{method:"POST"})).status,409);
  assert.equal((await call(endpoint,{method:"PUT",body:video.subarray(90),user:"",headers:{"X-Upload-Offset":"90"}})).status,401);
  part=await call(endpoint,{method:"PUT",body:video.subarray(90),headers:{"X-Upload-Offset":"90"}});assert.equal(part.result.offset,video.length);
  const complete=await call(endpoint+"/complete",{method:"POST"});assert.equal(complete.status,200);assert.equal(complete.result.saved,true);
  assert.deepEqual(readFileSync(path.join(dir,complete.result.filename)),video);
  assert.equal((await call("")).result.videos.length,1);
  assert.equal((await call(endpoint+"/complete",{method:"POST"})).status,404);
  const invalid=await create("bad.mp4"), invalidEndpoint=`/uploads/${invalid.result.id}`;
  await call(invalidEndpoint,{method:"PUT",body:Buffer.alloc(video.length,65),headers:{"X-Upload-Offset":"0"}});
  assert.equal((await call(invalidEndpoint+"/complete",{method:"POST"})).status,400);
  const oversized=await create("large.mp4"), oversizedEndpoint=`/uploads/${oversized.result.id}`;
  assert.equal((await call(oversizedEndpoint,{method:"PUT",body:Buffer.alloc(UPLOAD_CHUNK_BYTES+1),headers:{"X-Upload-Offset":"0"}})).status,413);
  assert.equal((await call(oversizedEndpoint)).result.offset,0);
  assert.equal((await call(oversizedEndpoint,{method:"DELETE"})).status,204);
  assert.equal(readdirSync(path.join(dir,".website-uploads")).length,0);
  assert.equal(readdirSync(path.join(dir,"网站上传")).length,1);
});

test("upload filename excludes executable extensions and path tricks",()=>{
  for(const name of ["../x.mp4","x\\x.mp4",".hidden.mp4","x.html","x.mp4\0","a/../x.mp4"] ) assert.throws(()=>uploadFilename(name));
  assert.equal(uploadFilename("我的精彩时刻.webm"),"我的精彩时刻.webm");
});

test("upload destination cannot be replaced by a symlink to another disk",async t=>{
  const dir=mkdtempSync(path.join(tmpdir(),"upload-symlink-")),outside=mkdtempSync(path.join(tmpdir(),"upload-outside-"));
  symlinkSync(outside,path.join(dir,"网站上传"));
  const upload=createPrivateMediaUpload({directory:dir,mediaUser:()=>({id:"dai",username:"戴卓然",library:"dai"})});
  const app=express();app.use(express.json());app.use(upload.router);const server=app.listen(0,"127.0.0.1");await new Promise(r=>server.once("listening",r));
  t.after(()=>{upload.close();server.closeAllConnections();server.close();rmSync(dir,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(origin,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({filename:"clip.mp4",size:100})});
  assert.equal(response.status,503);assert.deepEqual(readdirSync(outside),[]);
});
