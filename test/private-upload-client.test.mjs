import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateUploader } from "../public/private-upload.js";

test("watching pauses chunk transfer and closing resumes from the server offset", async t => {
  class Element extends EventTarget { disabled=false;hidden=false;textContent="";value="";files=[]; }
  const input=new Element(),status=new Element(),progress=new Element(),toggle=new Element(),cancel=new Element();
  const elements={'input[type="file"]':input,'[role="status"]':status,progress,'[data-upload-toggle]':toggle,'[data-upload-cancel]':cancel};
  const original={window:globalThis.window,fetch:globalThis.fetch,XMLHttpRequest:globalThis.XMLHttpRequest};
  t.after(()=>Object.assign(globalThis,original));
  globalThis.window=new EventTarget();let offset=0,completed=false,playing=false;const pending=[];
  const file=new File([new Uint8Array(5*1024*1024)],"clip.mp4");
  const state=()=>({id:"test-id",offset,size:file.size,chunkBytes:4*1024*1024});
  globalThis.fetch=async (url,options)=>{
    if(url.endsWith('/complete')){assert.equal(offset,file.size);return Response.json({saved:true});}
    return Response.json(state(),{status:options.method==='POST'?201:200});
  };
  class XHR {
    upload={};headers={};status=200;
    open(){} setRequestHeader(k,v){this.headers[k]=v;}
    send(blob){this.blob=blob;pending.push(this);}
    abort(){this.aborted=true;this.onabort();}
    finish(){assert.equal(Number(this.headers['X-Upload-Offset']),offset);offset+=this.blob.size;this.responseText=JSON.stringify(state());this.onload();}
  }
  globalThis.XMLHttpRequest=XHR;
  const uploader=createPrivateUploader({root:{querySelector:s=>elements[s]},playing:()=>playing,onComplete:async()=>{completed=true;}});
  const settle=async()=>{for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));};
  input.files=[file];input.dispatchEvent(new Event('change'));await settle();
  assert.equal(pending.length,1);assert.equal(input.disabled,true);
  playing=true;uploader.setPlaying(true);await settle();assert.equal(pending[0].aborted,true);assert.match(status.textContent,/播放期间已暂停/);assert.equal(offset,0);
  playing=false;uploader.setPlaying(false);await settle();assert.equal(pending.length,2);pending[1].finish();await settle();assert.equal(pending.length,3);pending[2].finish();await settle();
  assert.equal(completed,true);assert.equal(offset,file.size);assert.equal(input.disabled,false);assert.equal(progress.hidden,true);assert.match(status.textContent,/上传完成/);uploader.destroy();
});
