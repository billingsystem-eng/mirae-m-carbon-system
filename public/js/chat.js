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
<<<<<<< HEAD
        <textarea id="chat-input" rows="1" maxlength="2000" placeholder="Write a message about this payment…"></textarea>
        <button type="submit" class="primary chat-send" id="chat-send" aria-label="Send"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg></button>
=======
        <textarea id="chat-input" rows="2" maxlength="2000" placeholder="Write a message about this payment…"></textarea>
        <button type="submit" class="primary" id="chat-send">Send</button>
>>>>>>> 53eba40c7138305e3aac0e937c2d94124e32b921
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

<<<<<<< HEAD
    let prev = null;   // previous rendered message, used for grouping and time dividers
=======
>>>>>>> 53eba40c7138305e3aac0e937c2d94124e32b921
    const render = (m) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      lastId = Math.max(lastId, m.id);
      const empty = log.querySelector('.chat-empty');
      if (empty) empty.remove();
<<<<<<< HEAD
      const d = new Date(String(m.created_at).replace(' ', 'T') + 'Z');
      const gap = !prev || isNaN(d) || d - prev.d > 30 * 60e3 || d.toDateString() !== prev.d.toDateString();
      if (gap) {
        const sep = document.createElement('div');
        sep.className = 'chat-sep';
        sep.textContent = when(m.created_at);
        log.appendChild(sep);
      }
      const cont = !gap && prev.mine === m.mine && prev.side === m.side && prev.name === m.sender_name && d - prev.d < 5 * 60e3;
      prev = { d, mine: m.mine, side: m.side, name: m.sender_name };
      const row = document.createElement('div');
      row.className = 'chat-row ' + (m.mine ? 'mine' : 'theirs') + (cont ? ' cont' : '');
      row.insertAdjacentHTML('beforeend', userAvatar(m.side, { id: m.user_id, v: m.avatar_v }));
      const col = document.createElement('div');
      col.className = 'chat-col';
      if (!m.mine && !cont) {
        const who = document.createElement('div');
        who.className = 'chat-name';
        who.textContent = m.sender_name + (m.side === 'staff' ? ' · Mirae ESP' : '');
        col.appendChild(who);
      }
      const el = document.createElement('div');
      el.className = 'chat-msg ' + (m.mine ? 'mine' : 'theirs') + ' ' + m.side;
      el.title = when(m.created_at);
      const text = document.createElement('div');
      text.className = 'chat-text';
      text.textContent = m.body;            // textContent, never innerHTML: messages are untrusted input
      el.appendChild(text);
      col.appendChild(el);
      row.appendChild(col);
      log.appendChild(row);
=======
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
>>>>>>> 53eba40c7138305e3aac0e937c2d94124e32b921
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
<<<<<<< HEAD
        input.value = ''; grow();
=======
        input.value = '';
>>>>>>> 53eba40c7138305e3aac0e937c2d94124e32b921
        render(m);
        log.scrollTop = log.scrollHeight;
        if (onChange) onChange();
      } catch (ex) { toast(ex.message, true); }
      finally { send.disabled = false; input.focus(); }
    };
<<<<<<< HEAD
    const grow = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px'; };
    input.addEventListener('input', grow);
=======
>>>>>>> 53eba40c7138305e3aac0e937c2d94124e32b921
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
