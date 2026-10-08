/* Payment chat between a client and Mirae ESP finance, one thread per bill.
 * BillChat.mount(hostElement, { billId, threadUserId, isClient, onChange }) renders the thread and keeps it fresh by polling.
 * Mounting again (the bill page reloads after each action) replaces the previous instance. */
const BillChat = (() => {
  const POLL_MS = 6000;
  let timer = null;
  let current = null;

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (current && current.onVisible) document.removeEventListener('visibilitychange', current.onVisible);
    current = null;
  }

  // The server stores UTC ("YYYY-MM-DD HH:MM:SS"); show it in the viewer's own time zone.
  function when(ts) {
    const d = new Date(String(ts).replace(' ', 'T') + 'Z');
    if (isNaN(d)) return '';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString(LOCALE(), { hour: 'numeric', minute: '2-digit' });
    return sameDay ? time : d.toLocaleDateString(LOCALE(), { day: 'numeric', month: 'short' }) + ', ' + time;
  }

  function mount(host, { billId, threadUserId, isClient, onChange }) {
    stop();
    host.innerHTML = `
      <p class="chat-note" id="chat-note"></p>
      <div class="chat-log" id="chat-log" role="log" aria-live="polite" aria-label="Payment messages"></div>
      <form class="chat-form" id="chat-form" autocomplete="off">
        <label class="sr-only" for="chat-input">Message</label>
        <textarea id="chat-input" rows="2" maxlength="2000" placeholder="Write a message about this payment…"></textarea>
        <button type="submit" class="primary" id="chat-send">Send</button>
      </form>
      <p class="chat-closed" id="chat-closed" hidden>This bill is no longer open for messages.</p>`;

    host.querySelector('#chat-note').textContent = isClient
      ? 'Ask Mirae ESP finance about this statement, or send your payment reference after you have paid.'
      : 'Only this client login and Mirae ESP staff can see this conversation. Keep internal discussion elsewhere.';

    const log = host.querySelector('#chat-log');
    const form = host.querySelector('#chat-form');
    const input = host.querySelector('#chat-input');
    const send = host.querySelector('#chat-send');
    const closed = host.querySelector('#chat-closed');
    const seen = new Set();
    let lastId = 0;
    let busy = false;

    const render = (m) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      lastId = Math.max(lastId, m.id);
      const empty = log.querySelector('.chat-empty');
      if (empty) empty.remove();
      const el = document.createElement('div');
      el.className = 'chat-msg ' + (m.mine ? 'mine' : 'theirs') + ' ' + m.side;
      const who = document.createElement('div');
      who.className = 'chat-meta';
      who.textContent = (m.mine ? 'You' : m.sender_name) + (m.side === 'staff' ? ' · Mirae ESP' : '') + ' · ' + when(m.created_at);
      const text = document.createElement('div');
      text.className = 'chat-text';
      text.textContent = m.body;            // textContent, never innerHTML: messages are untrusted input
      el.append(who, text);
      log.appendChild(el);
    };

    const nearBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 80;

    async function pull(first) {
      if (busy) return;
      busy = true;
      try {
        const visible = document.visibilityState === 'visible';
        const stick = first || nearBottom();
        // Staff say which client login the conversation is with; a client login is always its own.
        const data = await api(`/api/messages/bills/${billId}?after=${lastId}${threadUserId ? '&user=' + threadUserId : ''}${visible ? '&mark=1' : ''}`);
        data.messages.forEach(render);
        if (data.messages.length && onChange) onChange();
        if (first && !data.messages.length) {
          log.innerHTML = '<p class="chat-empty">No messages yet.</p>';
        }
        form.hidden = !data.can_post;
        closed.hidden = data.can_post;
        if (stick) log.scrollTop = log.scrollHeight;
      } catch (e) {
        // Polling failures are silent; the next tick tries again. A first load failure is worth telling.
        if (first) log.innerHTML = '<p class="chat-empty">Messages could not be loaded.</p>';
      } finally { busy = false; }
    }

    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body || send.disabled) return;
      send.disabled = true;
      try {
        const m = await api(`/api/messages/bills/${billId}`, { method: 'POST', body: { body, user_id: threadUserId } });
        input.value = '';
        render(m);
        log.scrollTop = log.scrollHeight;
        if (onChange) onChange();
      } catch (ex) { toast(ex.message, true); }
      finally { send.disabled = false; input.focus(); }
    };
    // Enter sends, Shift+Enter makes a new line.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });

    const onVisible = () => { if (document.visibilityState === 'visible') pull(false); };
    document.addEventListener('visibilitychange', onVisible);
    current = { onVisible };
    timer = setInterval(() => { if (document.visibilityState === 'visible') pull(false); }, POLL_MS);
    pull(true);
  }

  return { mount, stop };
})();
