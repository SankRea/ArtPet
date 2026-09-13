class ArkPetVoice {
  constructor(caption, error) {
    this.caption = caption; this.error = error; this.generation = 0; this.nextAutomatic = 0;
  }
  configure(state) {
    const previous = this.state;
    this.state = state;
    if (previous?.model.id !== state.model.id || previous?.voice?.id !== state.voice?.id || !this.allowed()) this.stop(true);
    if (this.gain && this.context) this.gain.gain.setValueAtTime(state.voiceVolume ?? 0.6, this.context.currentTime);
    if (state.voiceTextEnabled === false) this.caption(null);
    else if (previous?.voiceTextEnabled === false) this.refreshCaption?.();
  }
  allowed() {
    const state = this.state;
    return state?.voiceEnabled && state.voice?.cached && state.ready && state.visible && !state.paused && !state.fullscreenSuspended && !state.error && !document.hidden;
  }
  stop(release = false) {
    this.generation++;
    this.refreshCaption = null;
    this.caption(null);
    this.pending = false;
    this.abort?.abort(); this.abort = null;
    clearTimeout(this.releaseTimer);
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* The previous clip may have just ended. */ }
      this.source.disconnect(); this.source = null;
    }
    if (release) {
      this.buffer = null; this.bufferKey = null; this.gain = null;
      const context = this.context; this.context = null;
      if (context && context.state !== 'closed') context.close().catch(() => {});
    } else if (this.context) {
      this.context.suspend().catch(() => {});
      this.releaseTimer = setTimeout(() => this.stop(true), 20000);
    }
  }
  async play(clipId, manual = true) {
    if (!this.allowed()) return;
    const clip = this.state.voice.clips.find(item => item.id === clipId);
    if (!clip || (!manual && (this.source || this.pending || Date.now() < this.nextAutomatic))) return;
    this.stop(false);
    clearTimeout(this.releaseTimer);
    const generation = this.generation, modelId = this.state.model.id;
    this.pending = true;
    const abort = new AbortController(); this.abort = abort;
    const bufferKey = `${this.state.voice.id}:${clip.id}`;
    try {
      const context = this.context || new AudioContext({ latencyHint: 'playback' });
      this.context = context;
      if (!this.buffer || this.bufferKey !== bufferKey) {
        const response = await fetch(clip.url, { signal: abort.signal });
        if (!response.ok) throw new Error('本地语音文件缺失，请重新下载当前干员的语音。');
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        if (generation !== this.generation) return;
        this.buffer = buffer; this.bufferKey = bufferKey;
      }
      await context.resume();
      if (generation !== this.generation || !this.allowed()) return;
      if (!this.buffer.duration || this.buffer.duration > 180) throw new Error('语音片段时长无效。');
      if (!this.gain) { this.gain = context.createGain(); this.gain.connect(context.destination); }
      this.gain.gain.setValueAtTime(this.state.voiceVolume ?? 0.6, context.currentTime);
      const source = context.createBufferSource(); source.buffer = this.buffer; source.connect(this.gain);
      source.onended = () => {
        if (this.source !== source) return;
        source.disconnect(); this.source = null;
        this.refreshCaption = null;
        this.caption(null);
        context.suspend().catch(() => {});
        this.releaseTimer = setTimeout(() => this.stop(true), 20000);
      };
      this.source = source; this.pending = false; this.abort = null;
      const startedAt = context.currentTime;
      source.start();
      this.nextAutomatic = Date.now() + 60000;
      this.error(modelId, '');
      this.refreshCaption = () => {
        if (generation !== this.generation || this.source !== source || this.state.voiceTextEnabled === false) return;
        const duration = this.buffer.duration - (context.currentTime - startedAt);
        if (duration > 0) this.caption({ modelId, clipId: clip.id, playbackId: generation, duration });
      };
      this.refreshCaption();
    } catch (error) {
      if (generation !== this.generation) return;
      this.stop(true);
      this.error(modelId, `语音播放失败：${error.message}`);
    } finally {
      if (generation === this.generation) { this.pending = false; this.abort = null; }
    }
  }
}
window.ArkPetVoice = ArkPetVoice;
