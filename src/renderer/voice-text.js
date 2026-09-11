// Parse detached markup only. Remote HTML is never inserted into the application.
window.ArkPetVoiceTexts = (() => {
  const cache = new Map();
  const normalisePath = value => value.replace(/#/g, '__').replace(/\.ogg$/i, '');
  function parse(record, voiceId) {
    const result = { clips: {}, source: record.source, error: record.error || '' };
    if (!record.html || record.voiceId !== voiceId) return result;
    const document = new DOMParser().parseFromString(record.html, 'text/html');
    const expected = normalisePath(`${record.directory}/${voiceId}`);
    for (const root of document.querySelectorAll('[data-voice-key]')) {
      const bases = (root.dataset.voiceBase || '').split(',').map(entry => {
        const separator = entry.indexOf(':');
        return { language: entry.slice(0, separator), path: entry.slice(separator + 1) };
      });
      const base = bases.find(entry => normalisePath(entry.path) === expected);
      if (!base) continue;
      // PRTS places outfit lines in language variants, e.g. 中文(残余).
      const suffix = base.language.match(/[（(][^()（）]*[)）]$/)?.[0] || '';
      if (!suffix && normalisePath(root.dataset.voiceKey) !== normalisePath(voiceId)) continue;
      for (const item of root.querySelectorAll('.voice-data-item')) {
        const id = item.dataset.voiceFilename?.match(/^(?:CN_)?(\d{3})\.(?:wav|mp3|ogg)$/i)?.[1];
        const detail = [...item.querySelectorAll('.voice-item-detail')].find(node => node.dataset.kindName === `中文${suffix}`);
        if (!id || !detail) continue;
        const copy = detail.cloneNode(true);
        copy.querySelectorAll('script, style, sup.reference').forEach(node => node.remove());
        copy.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
        const text = copy.textContent.trim();
        if (text && text.length <= 10000) result.clips[id] = text;
      }
    }
    if (!Object.keys(result.clips).length) result.error = 'PRTS 暂无与当前语音版本匹配的中文文本。';
    return result;
  }
  function get(voice, petId) {
    if (!voice?.available) return Promise.resolve({ clips: {}, error: '当前干员暂无语音资源。' });
    const previous = cache.get(voice.id);
    if (previous && previous.expires > Date.now()) return previous.promise;
    const record = { expires: Infinity };
    record.promise = window.arkpet.voiceText(petId).then(data => parse(data, voice.id))
      .catch(() => ({ clips: {}, error: '语音文本加载失败，请稍后重试。' }))
      .then(result => { record.result = result; record.expires = Date.now() + (result.error ? 60000 : 30 * 60 * 1000); return result; });
    cache.set(voice.id, record);
    return record.promise;
  }
  return { get, peek: voice => cache.get(voice?.id)?.result };
})();
