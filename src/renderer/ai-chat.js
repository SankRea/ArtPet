const bridge = window.arkpetChat;
const byId = id => document.getElementById(id);
let state = { ready: false, messages: [] }, busy = false;

function renderMessages(pending = false) {
  const elements = state.messages.map(message => {
    const item = document.createElement('article');
    item.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
    item.textContent = message.content;
    return item;
  });
  if (pending) {
    const item = document.createElement('article');
    item.className = 'message assistant pending'; item.textContent = '正在读取资料并思考…'; elements.push(item);
  }
  byId('messages').replaceChildren(...elements);
  byId('empty-message').hidden = Boolean(elements.length);
  byId('messages').scrollTop = byId('messages').scrollHeight;
}

function render(next) {
  if (!next) { byId('notice').textContent = '对话窗口已失效。'; return; }
  state = { ...state, ...next, messages: Array.isArray(next.messages) ? next.messages : state.messages };
  document.title = `${state.name} · 对话`;
  byId('operator-name').textContent = `与 ${state.name} 对话`;
  byId('status').textContent = state.status || '';
  byId('chat-input').disabled = busy || !state.ready;
  byId('send-message').disabled = busy || !state.ready;
  byId('clear-chat').disabled = busy || !state.messages.length;
  renderMessages(busy);
}

byId('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  const message = byId('chat-input').value.trim();
  if (!message || busy || !state.ready) return;
  const previous = state.messages;
  state.messages = [...previous, { role: 'user', content: message }];
  byId('chat-input').value = ''; byId('notice').textContent = '';
  busy = true; render(state);
  try {
    const result = await bridge.send(message);
    if (!result.ok) throw new Error(result.error);
    state.messages = result.messages;
    byId('notice').textContent = result.warning || '';
  } catch (error) {
    state.messages = previous; byId('chat-input').value = message;
    byId('notice').textContent = error.message;
  } finally { busy = false; render(state); byId('chat-input').focus(); }
});

byId('chat-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); byId('chat-form').requestSubmit(); }
});
byId('clear-chat').addEventListener('click', async () => {
  if (busy || !state.messages.length || !window.confirm('清空当前干员的本次对话记录？')) return;
  const result = await bridge.clear();
  if (result.ok) { state.messages = []; byId('notice').textContent = ''; render(state); }
  else byId('notice').textContent = result.error;
});
byId('open-source').addEventListener('click', () => bridge.openSource());
const unsubscribe = bridge.onState(render);
window.addEventListener('beforeunload', unsubscribe);
bridge.getState().then(data => { render(data); if (data?.ready) byId('chat-input').focus(); });
