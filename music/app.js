'use strict';
const audio=document.getElementById('audio');
if(audio) {
  const $=id=>document.getElementById(id);
  const status=$('status'),error=$('error'),seek=$('seek'),button=$('play');
  let requestId=0,pending=false,buffering=false;
  const atEnd=()=>audio.ended||(Number.isFinite(audio.duration)&&audio.duration>0&&audio.currentTime>=audio.duration-.05);
  const time=value=>`${Math.floor(value/60)}:${String(Math.floor(value%60)).padStart(2,'0')}`;
  function progress() {
    const duration=audio.duration,ready=Number.isFinite(duration)&&duration>0;
    const current=Number.isFinite(audio.currentTime)?audio.currentTime:0;
    seek.disabled=!ready;
    seek.value=ready?Math.min(1000,Math.round(current/duration*1000)):0;
    seek.style.setProperty('--progress',`${Number(seek.value)/10}%`);
    $('elapsed').textContent=time(current);
    $('duration').textContent=ready?time(duration):'--:--';
    seek.setAttribute('aria-valuetext',ready?`已播放 ${time(current)}，共 ${time(duration)}`:'尚未开始播放');
  }
  function state() {
    const active=pending||(!audio.paused&&!audio.ended);
    button.classList.toggle('active',active);
    button.setAttribute('aria-label',active?'暂停音乐':atEnd()?'重新播放音乐':'播放音乐');
    $('play-label').textContent=active?'暂停播放':atEnd()?'再听一次':audio.currentTime>0?'继续聆听':'开始聆听';
    document.body.classList.toggle('playing',active&&!buffering&&!document.hidden);
    document.body.classList.toggle('loading',buffering);
  }
  function failed(){pending=false;buffering=false;audio.pause();state();error.hidden=false;status.textContent='暂时播放不了，请重试。';}
  async function start({restart=false,reload=false}={}) {
    const id=++requestId;
    error.hidden=true;
    if(reload) audio.load();
    if((restart||atEnd())&&audio.readyState>0) audio.currentTime=0;
    pending=true;buffering=audio.readyState<3;state();status.textContent='正在准备音乐…';
    try { await audio.play(); if(id===requestId){pending=false;state();} }
    catch(e) { if(id!==requestId)return;pending=false;if(e.name==='AbortError')state();else failed(); }
  }
  button.onclick=()=>{
    if(pending||!audio.paused){requestId++;pending=false;buffering=false;audio.pause();state();status.textContent='已暂停，继续听听吧。';}
    else start();
  };
  $('replay').onclick=()=>start({restart:true});
  $('retry').onclick=()=>start({reload:true});
  seek.addEventListener('input',()=>{
    if(!Number.isFinite(audio.duration)||audio.duration<=0)return;
    try {audio.currentTime=Number(seek.value)/1000*audio.duration;progress();state();}
    catch(_){status.textContent='进度暂未加载好，请稍后再试。';}
  });
  audio.addEventListener('playing',()=>{pending=false;buffering=false;error.hidden=true;state();status.textContent='正在播放，歌名有线索了吗？';});
  audio.addEventListener('pause',()=>{buffering=false;state();if(!audio.ended&&!error.hidden)return;if(!audio.ended)status.textContent='已暂停，继续听听吧。';});
  audio.addEventListener('waiting',()=>{buffering=true;state();status.textContent='音乐加载中…';});
  audio.addEventListener('ended',()=>{pending=false;buffering=false;state();progress();status.textContent='听完了，猜到是哪首歌了吗？';});
  audio.addEventListener('error',failed);
  for(const event of ['loadedmetadata','durationchange','timeupdate','seeked','emptied']) audio.addEventListener(event,progress);
  document.addEventListener('visibilitychange',state);
  window.addEventListener('pagehide',()=>{requestId++;pending=false;buffering=false;audio.pause();state();});
  // Only replace native controls once all custom handlers have been installed.
  progress();state();$('controls').hidden=false;
  audio.controls=false;audio.hidden=true;
}
