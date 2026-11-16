// One AudioContext clock drives both preview and video frames. Only the selected
// track is connected, so the guide vocal cannot leak into a backing-only export.
export class AudioTransport {
  constructor(context){this.context=context;this.output=context.createGain();this.output.connect(context.destination);this.tracks={vocal:null,backing:null};this.mode='vocal';this.backingOffset=0;this.rate=1;this.position=0;this.startedAt=0;this.playing=false;this.source=null;this.onended=null;}
  get duration(){return Math.max(this.tracks.vocal?.duration??0,(this.tracks.backing?this.tracks.backing.duration+this.backingOffset:0),0);}
  get currentTime(){return this.playing?Math.min(this.duration,this.position+(this.context.currentTime-this.startedAt)*this.rate):this.position;}
  set currentTime(t){const was=this.playing;this.pause();this.position=Math.max(0,Math.min(this.duration,t));if(was)this.start();}
  get paused(){return !this.playing;}
  get playbackRate(){return this.rate;}
  set playbackRate(rate){const was=this.playing;this.pause();this.rate=rate;if(was)this.start();}
  setTrack(kind,buffer){const was=this.playing;this.pause();this.tracks[kind]=buffer;this.position=Math.min(this.position,this.duration);if(was)this.start();}
  select(mode){if(!this.tracks[mode])throw Error(mode==='backing'?'Сначала добавьте минус.':'Сначала добавьте оригинал с вокалом.');const was=this.playing;this.pause();this.mode=mode;if(was)this.start();}
  setOffset(value){const was=this.playing;this.pause();this.backingOffset=value;this.position=Math.min(this.position,this.duration);if(was)this.start();}
  async play(){await this.context.resume();if(!this.playing){if(this.position>=this.duration)this.position=0;this.start();}}
  start(){if(this.playing)return;const buffer=this.tracks[this.mode];if(!buffer)throw Error('Выбранная аудиодорожка не загружена.');const now=this.context.currentTime,offset=this.mode==='backing'?this.backingOffset:0,local=this.position-offset;this.startedAt=now;this.playing=true;
    if(local<buffer.duration){const source=this.context.createBufferSource();source.buffer=buffer;source.playbackRate.value=this.rate;source.connect(this.output);source.start(now+Math.max(0,-local)/this.rate,Math.max(0,local));this.source=source;}
  }
  pause(){if(!this.playing)return;this.position=this.currentTime;this.playing=false;if(this.source){try{this.source.stop();}catch{}this.source.disconnect();this.source=null;}}
  tick(){if(this.playing&&this.currentTime>=this.duration){this.pause();this.position=this.duration;this.onended?.();}}
}
