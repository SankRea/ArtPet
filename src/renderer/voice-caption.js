const transcript = document.getElementById('transcript');
let scrollTimer;
window.voiceCaption.onShow(data => {
  clearInterval(scrollTimer);
  document.getElementById('speaker').textContent = data.name;
  document.getElementById('clip-label').textContent = data.label;
  document.getElementById('source').textContent = data.hasText ? '中文文本 · PRTS Wiki' : '语音播放中';
  transcript.textContent = data.text;
  transcript.scrollTop = 0;
  // Measure full text before the native window is resized to fit the card.
  const height = Math.min(340, Math.min(230, transcript.scrollHeight) + 106);
  window.voiceCaption.resize({ token: data.token, height });
  scrollTimer = setInterval(() => {
    const elapsed = Date.now() - data.startedAt;
    const progress = Math.max(0, Math.min(1, (elapsed - 1500) / Math.max(1, data.duration * 1000 - 2500)));
    transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight) * progress;
  }, 100);
});
window.addEventListener('beforeunload', () => clearInterval(scrollTimer));
