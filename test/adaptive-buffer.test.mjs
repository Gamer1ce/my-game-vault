import test from "node:test";
import assert from "node:assert/strict";
import {createAdaptiveBuffering} from "../public/adaptive-buffer.js";

function setup({managed=true}={}) {
  let time=0,tick,live=true;const events=new Map(),states=[];
  const video={currentTime:5,duration:100,end:5,paused:false,seeking:false,ended:false,error:null,networkState:2,
    dataset:{managedStream:managed?"true":undefined},playCalls:0,pauseCalls:0,
    buffered:{length:1,start:()=>0,end:()=>video.end},
    addEventListener(n,f){if(!events.has(n))events.set(n,new Set());events.get(n).add(f);},
    removeEventListener(n,f){events.get(n)?.delete(f);},
    emit(n){for(const f of events.get(n)||[])f();},
    pause(){this.paused=true;this.pauseCalls++;this.emit("pause");},
    async play(){this.paused=false;this.playCalls++;this.emit("play");this.emit("playing");}
  };
  const recovery=createAdaptiveBuffering(video,{active:()=>live,now:()=>time,schedule:fn=>{tick=fn;return 1;},unschedule:()=>{},onState:s=>states.push(s)});
  video.emit("playing");
  return {video,recovery,states,advance(ms){time+=ms;tick();},close(){live=false;recovery.destroy();},starve(){video.emit("waiting");video.emit("playing");video.emit("waiting");}};
}

test("brief starvation and duplicate waiting events never force a pause",()=>{
  const p=setup();p.video.emit("waiting");p.video.emit("waiting");p.advance(5000);
  assert.equal(p.video.pauseCalls,0);p.close();
});
test("repeated starvation accumulates a real 16-second buffer before resuming",async()=>{
  const p=setup();p.starve();assert.equal(p.recovery.recovering,true);assert.equal(p.video.pauseCalls,1);
  p.video.end=7;p.advance(6000);assert.equal(p.video.playCalls,0);
  p.video.end=21;p.advance(1000);await Promise.resolve();
  assert.equal(p.video.playCalls,1);assert.equal(p.recovery.recovering,false);p.close();
});
test("manual play, seek, source reset and closing cancel pending automatic resume",()=>{
  for(const action of ["play","seeking","emptied","close"]){
    const p=setup();p.starve();if(action==="close")p.close();else p.video.emit(action);
    p.video.end=30;p.advance(20000);assert.equal(p.video.playCalls,0,action);p.close();
  }
});
test("intentional pause and decoder stalls with ample data do not trigger refill",()=>{
  for(const mode of ["paused","buffered","seeking"]){const p=setup();
    if(mode==="paused")p.video.paused=true;if(mode==="buffered")p.video.end=30;if(mode==="seeking")p.video.seeking=true;
    p.starve();assert.equal(p.video.pauseCalls,0,mode);p.close();}
});
test("native paused-buffer caps and complete lack of data cannot deadlock",async()=>{
  const p=setup({managed:false});p.starve();p.video.end=8;p.video.networkState=1;p.advance(1000);p.advance(4000);
  await Promise.resolve();assert.equal(p.video.playCalls,1);p.close();
  const q=setup();q.starve();q.advance(60000);assert.equal(q.recovery.recovering,false);assert.equal(q.video.playCalls,0);assert.equal(q.states.at(-1).reason,"manual");q.close();
});
test("slow but progressing HLS segments are not mistaken for a capped native buffer",()=>{
  const p=setup();p.starve();p.video.end=7;p.video.networkState=1;p.advance(1000);p.advance(12000);
  assert.equal(p.video.playCalls,0);p.close();
});
