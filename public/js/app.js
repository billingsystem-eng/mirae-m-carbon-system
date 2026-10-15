/* Shared front-end helpers. */

// Korean won, in every interface language (no decimals). The constant keeps its old name so existing pages still work.
const PESO = '\u20A9';

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (res.status === 401 && !location.pathname.endsWith('login.html')) {
    location.href = '/login.html';
    throw new Error('Not signed in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function toast(message, bad = false) {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const note = document.createElement('div');
  if (bad) note.className = 'bad';
  note.textContent = message;
  box.appendChild(note);
  setTimeout(() => note.remove(), 4200);
}

const money = (n) => {
  return PESO + Number(n || 0).toLocaleString(LOCALE(), { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};
/** Full address in Korean order when the UI is Korean (postal code, 시/도, 시/군/구, road, detail), otherwise the original order. */
const addrLine = (c) => (typeof LANG !== 'undefined' && LANG === 'ko'
  ? [c.addr_zip && `(${c.addr_zip})`, c.addr_region, c.addr_city, c.addr_street, c.addr_unit, c.addr_building && `(${[c.addr_barangay, c.addr_building].filter(Boolean).join(', ')})`]
  : [c.addr_unit, c.addr_building, c.addr_street, c.addr_barangay, c.addr_city, c.addr_region, c.addr_zip, c.addr_country]
).filter(Boolean).join(typeof LANG !== 'undefined' && LANG === 'ko' ? ' ' : ', ');
const kwh = (n, dp = 3) =>
  Number(n || 0).toLocaleString(LOCALE(), { minimumFractionDigits: 0, maximumFractionDigits: dp }) + ' kWh';
const dec = (n, dp = 2) =>
  Number(n || 0).toLocaleString(LOCALE(), { minimumFractionDigits: dp, maximumFractionDigits: dp });
const dateText = (d) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString(LOCALE(), { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Line icons for the left rail (inline SVG, drawn in the link's text colour). */
const NAV_ICONS = {
  overview: '<rect x="3" y="3" width="7.5" height="9" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="5.5" rx="1.5"/><rect x="13.5" y="12" width="7.5" height="9" rx="1.5"/><rect x="3" y="15.5" width="7.5" height="5.5" rx="1.5"/>',
  clients: '<path d="M4 21V5.5A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5V21"/><path d="M15 10h3.5A1.5 1.5 0 0 1 20 11.5V21"/><path d="M2.5 21h19M8 8h3M8 12h3M8 16h3"/>',
  billing: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9.5 8h5M9.5 12h5"/>',
  quotations: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h4"/>',
  monitor: '<path d="M2.5 12h4l2.5-7 5 14 2.5-7h5"/>',
  activity: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5M12 7.5V12l3 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.7-3.6 3.2-5.5 6.5-5.5s5.8 1.9 6.5 5.5"/><path d="M16 4.7a3.5 3.5 0 0 1 0 6.6M18 14.8c1.9.7 3.1 2.4 3.5 5.2"/>',
  payment: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><path d="M16 13h2"/>',
  messages: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 4v-4A1.5 1.5 0 0 1 4 14.5z"/><path d="M8 9h8M8 12h5"/>',
  products: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.2 1.1 2V16h5v-.2c0-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  signout: '<path d="M9 21H5.5A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3H9"/><path d="M16 17l5-5-5-5M21 12H9"/>'
};
const navIcon = (k) => `<svg class="nav-ico" viewBox="0 0 24 24" aria-hidden="true">${NAV_ICONS[k]}</svg>`;

/** Round user icon. side: 'staff' (Mirae ESP, green) or 'client' (grey). Returns an HTML string.
 *  Pass pic = { id, v } to show that user's profile picture (v = users.avatar_v; 0 / missing = no picture, so the icon stays). */
const userAvatar = (side = 'client', pic = null) => {
  const icon = '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5c.8-4 3.7-6 7.5-6s6.7 2 7.5 6"/></svg>';
  const img = pic && pic.id && pic.v > 0
    ? `<img src="/api/avatars/${Number(pic.id)}?v=${Number(pic.v)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<span class="avatar ${side === 'staff' ? 'staff' : 'client'}${img ? ' has-pic' : ''}" aria-hidden="true">${icon}${img}</span>`;
};

const NAV = [
  { href: '/dashboard.html', label: 'Overview', icon: 'overview' },
  { href: '/clients.html', label: 'Clients & projects', icon: 'clients' },
  { href: '/bills.html', label: 'Billing', icon: 'billing' },
  { href: '/messages.html', label: 'Messages', icon: 'messages' },
  { href: '/notifications.html', label: 'Notifications', icon: 'bell' },
  { href: '/products.html', label: 'Products', icon: 'products' },
  { href: '/quotations.html', label: 'Quotations', icon: 'quotations', also: ['/quotation.html', '/quotation-print.html'] },
  { href: '/monitor.html', label: 'Live monitor', icon: 'monitor' },
  { href: '/audit.html', label: 'Activity log', icon: 'activity' },
  { href: '/users.html', label: 'Users', icon: 'users', adminOnly: true },
  { href: '/bank.html', label: 'Bank reconciliation', icon: 'payment', roles: ['admin', 'finance_hr'] },
  { href: '/payment-methods.html', label: 'Payment method', icon: 'payment' }
];

/** Pages a viewer (client login) may open, all read-only: billing, quotations, live monitor, payment methods. */
const VIEWER_PAGES = ['/bills.html', '/bill.html', '/statement.html', '/invoice.html', '/payment-methods.html', '/messages.html', '/notifications.html',
  '/quotations.html', '/quotation-print.html', '/monitor.html', '/products.html'];

/** Renders the left rail and returns the signed-in user. */
async function shell() {
  const me = await api('/api/auth/me');
  if (me.role === 'viewer' && !VIEWER_PAGES.includes(location.pathname)) {
    location.href = '/bills.html';
    return me;
  }
  const rail = document.querySelector('.rail');
  if (!rail) return me;
  const here = location.pathname;
  const roleText = { admin: 'Administrator', billing_officer: 'Billing officer', finance_hr: 'Finance / HR', viewer: 'Viewer' }[me.role] || me.role;
  rail.innerHTML = `
    <div class="mark"><b>M-Carbon System</b><span>Mirae ESP Solutions</span></div>
    <nav>${NAV.filter((n) => (!n.adminOnly || me.role === 'admin') && (!n.roles || n.roles.includes(me.role)) && (me.role !== 'viewer' || VIEWER_PAGES.includes(n.href)))
      .map((n) => `<a href="${n.href}" class="${here === n.href || (n.also || []).includes(here) ? 'on' : ''}">${navIcon(n.icon)}<span>${n.label}</span></a>`)
      .join('')}</nav>
    <div class="who">
      <div class="who-id"><button id="chpic" type="button" class="who-pic" title="Change profile photo" aria-label="Change profile photo">${userAvatar(me.role === 'viewer' ? 'client' : 'staff', { id: me.id, v: me.avatar_v })}</button>
        <span><b>${esc(me.full_name)}</b>${roleText}</span></div>
      ${me.role !== 'admin' ? '<button id="chpw" type="button">Change password</button> ' : ''}<button id="signout">${navIcon('signout')}Sign out</button></div>`;
  const chpw = rail.querySelector('#chpw');   // every role except administrators
  if (chpw) chpw.onclick = openPasswordDialog;
  rail.querySelector('#chpic').onclick = () => openPhotoDialog(me, (v) => {
    me.avatar_v = v;
    rail.querySelector('#chpic').innerHTML = userAvatar(me.role === 'viewer' ? 'client' : 'staff', { id: me.id, v });
  });
  rail.querySelector('#signout').onclick = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/login.html';
  };
  document.body.dataset.role = me.role;
  addBackButton(me);
  // Unread payment-chat messages show as a badge on the Messages link.
  api('/api/messages/unread').then((u) => setMessageBadge(u.total)).catch(() => {});
  api('/api/notifications/unread').then((u) => setNotifBadge(u.total)).catch(() => {});
  return me;
}

/** Shows (or clears) the unread count on the Messages link in the left rail. */
function setMessageBadge(n) {
  const link = document.querySelector('.rail nav a[href="/messages.html"]');
  if (!link) return;
  const old = link.querySelector('.nav-badge');
  if (old) old.remove();
  if (n > 0) link.insertAdjacentHTML('beforeend', `<span class="nav-badge" title="Unread payment messages">${n > 99 ? '99+' : n}</span>`);
}

/** Shows (or clears) the unread count on the Notifications link in the left rail. */
function setNotifBadge(n) {
  const link = document.querySelector('.rail nav a[href="/notifications.html"]');
  if (!link) return;
  const old = link.querySelector('.nav-badge');
  if (old) old.remove();
  if (n > 0) link.insertAdjacentHTML('beforeend', `<span class="nav-badge" title="Unread payment reminders">${n > 99 ? '99+' : n}</span>`);
}

/** Lets any signed-in user change their own password (needs the current one). */
/**
 * Adds a "Back" button at the top of every page that uses the left rail.
 * Goes to the previous page in this site when there is one; otherwise falls back to the page's parent
 * (the last link in its breadcrumb) or the home page. Hidden on the home page when there is nowhere to go back to.
 */
function addBackButton(me) {
  const main = document.querySelector('main');
  if (!main || main.querySelector('.back-btn')) return;
  const home = me.role === 'viewer' ? '/bills.html' : '/dashboard.html';
  const cameFromSite = (() => {
    try { return !!document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1; }
    catch (_) { return false; }
  })();
  // Parent page from the breadcrumb, e.g. "Billing / Worksheet" -> the first real link that is not this page.
  const crumbLinks = [...main.querySelectorAll('.crumb a[href]')].filter((a) => a.getAttribute('href') && a.getAttribute('href') !== '#');
  const parent = crumbLinks.length ? crumbLinks[crumbLinks.length - 1].getAttribute('href') : null;
  const fallback = parent || home;
  if (!cameFromSite && location.pathname === fallback) return;   // home page, opened directly: nothing to go back to

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'back-btn no-print';
  btn.setAttribute('aria-label', 'Back');
  btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg><span>Back</span>';
  btn.onclick = () => {
    if (cameFromSite) history.back();
    else location.href = fallback;
  };
  main.insertBefore(btn, main.firstChild);
}

function openPasswordDialog() {
  if (document.getElementById('pw-dialog')) return;
  const dlg = document.createElement('dialog');
  dlg.id = 'pw-dialog';
  dlg.innerHTML = `
    <form method="dialog" id="pw-form" autocomplete="off">
      <h2>Change password</h2>
      <div class="field"><label for="pw-cur">Current password</label><input id="pw-cur" type="password" autocomplete="current-password" required></div>
      <div class="field"><label for="pw-new">New password (at least 8 characters)</label><input id="pw-new" type="password" autocomplete="new-password" minlength="8" required></div>
      <div class="field"><label for="pw-rep">Repeat new password</label><input id="pw-rep" type="password" autocomplete="new-password" minlength="8" required></div>
      <p id="pw-err" class="pw-err" role="alert" hidden></p>
      <div class="pw-actions"><button type="button" id="pw-cancel">Cancel</button><button type="submit" class="primary">Change password</button></div>
    </form>`;
  document.body.appendChild(dlg);
  const g = (id) => dlg.querySelector('#' + id);
  const close = () => { dlg.close(); dlg.remove(); };
  g('pw-cancel').onclick = close;
  dlg.addEventListener('cancel', () => dlg.remove());
  g('pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = g('pw-err');
    err.hidden = true;
    if (g('pw-new').value !== g('pw-rep').value) { err.textContent = 'The new passwords do not match.'; err.hidden = false; return; }
    try {
      await api('/api/auth/password', { method: 'POST', body: { current_password: g('pw-cur').value, new_password: g('pw-new').value } });
      close();
      toast('Password changed');
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  };
  dlg.showModal();
  g('pw-cur').focus();
}

/** Lets any signed-in user set, change or remove their own profile picture. The photo is centre-cropped to a square
 *  and shrunk in the browser (256 px JPEG), so uploads stay small whatever the camera produced. */
function openPhotoDialog(me, onSaved) {
  if (document.getElementById('pic-dialog')) return;
  const dlg = document.createElement('dialog');
  dlg.id = 'pic-dialog';
  dlg.innerHTML = `
    <form method="dialog" id="pic-form">
      <h2>Profile photo</h2>
      <div class="pic-preview" id="pic-prev"></div>
      <input id="pic-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
      <div class="pic-pick"><button type="button" id="pic-choose">Choose photo…</button> <button type="button" id="pic-remove" class="quiet danger">Remove photo</button></div>
      <p class="pic-note">JPG, PNG or WebP. It is cropped to a square. Other people see it in messages.</p>
      <p id="pic-err" class="pw-err" role="alert" hidden></p>
      <div class="pw-actions"><button type="button" id="pic-cancel">Cancel</button><button type="submit" class="primary" id="pic-save" disabled>Save photo</button></div>
    </form>`;
  document.body.appendChild(dlg);
  const g = (id) => dlg.querySelector('#' + id);
  const side = me.role === 'viewer' ? 'client' : 'staff';
  let blob = null, removing = false, saved = me.avatar_v || 0, previewUrl = null;
  const showErr = (m) => { g('pic-err').textContent = m || ''; g('pic-err').hidden = !m; };
  const paint = () => {
    if (previewUrl) g('pic-prev').innerHTML = `<span class="avatar ${side} has-pic"><img src="${previewUrl}" alt="Preview"></span>`;
    else g('pic-prev').innerHTML = userAvatar(side, removing ? null : { id: me.id, v: saved });
    g('pic-remove').hidden = !previewUrl && (removing || !saved);
    g('pic-save').disabled = !blob && !removing;
  };
  const close = () => { if (previewUrl) URL.revokeObjectURL(previewUrl); dlg.close(); dlg.remove(); };
  g('pic-cancel').onclick = close;
  dlg.addEventListener('cancel', () => { if (previewUrl) URL.revokeObjectURL(previewUrl); dlg.remove(); });
  g('pic-choose').onclick = () => g('pic-file').click();
  g('pic-remove').onclick = () => {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    blob = null; removing = !!saved; showErr(''); paint();
  };
  g('pic-file').onchange = async () => {
    showErr('');
    const f = g('pic-file').files[0];
    g('pic-file').value = '';
    if (!f) return;
    if (!/^image\//.test(f.type)) return showErr('Choose an image file (JPG, PNG or WebP).');
    try {
      const b = await squarePhoto(f, 256);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      blob = b; removing = false; previewUrl = URL.createObjectURL(b); paint();
    } catch (e) { showErr('That picture could not be read. Try another one.'); }
  };
  g('pic-form').onsubmit = async (e) => {
    e.preventDefault();
    showErr('');
    g('pic-save').disabled = true;
    try {
      let v = saved;
      if (blob) {
        const res = await fetch('/api/avatars/me', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'The upload failed. Try again.');
        v = data.avatar_v;
      } else if (removing) {
        v = (await api('/api/avatars/me', { method: 'DELETE' })).avatar_v;
      }
      onSaved(v);
      close();
      toast(blob ? 'Profile photo updated' : 'Profile photo removed');
    } catch (ex) { showErr(ex.message); g('pic-save').disabled = false; }
  };
  paint();
  dlg.showModal();
}

/** Centre-crops an image file to a size x size JPEG Blob. */
async function squarePhoto(file, size) {
  const bmp = await createImageBitmap(file);
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  if (bmp.close) bmp.close();
  return new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('encode'))), 'image/jpeg', 0.86));
}

/** Viewers can read everything but change nothing. */
const readOnly = (me) => me.role === 'viewer' || me.role === 'finance_hr'; // finance / HR can approve and view, not edit
/* Clients & projects can only be changed by administrators. */
const readOnlySetup = (me) => me.role !== 'admin';

function disableEditing() {
  document.querySelectorAll('[data-edit]').forEach((el) => {
    el.disabled = true;
    el.title = 'Your role is read-only.';
  });
}

/* Sales Invoice scans. Fills #invoice-body inside #invoice-panel for a bill or a quotation.
   Staff only (the panel stays hidden for client logins). Upload opens only once it has been paid. */
async function renderInvoicePanel(entity, id, me) {
  const panel = document.getElementById('invoice-panel'), body = document.getElementById('invoice-body');
  if (!panel || !body || me.role === 'viewer') return;
  let d;
  try { d = await api(`/api/invoices/${entity}/${id}`); } catch (e) { return; }
  panel.hidden = false;
  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const files = d.files.map((f) => `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid var(--rule)">
      <a href="/api/invoices/file/${f.id}" target="_blank" rel="noopener">${esc(f.original_name)}</a>
      <small style="color:var(--ink-soft)">${kb(f.size)} · ${esc(f.uploaded_by || '')} · ${esc(f.uploaded_at)}</small>
      ${me.role === 'admin' ? `<button type="button" class="quiet danger" data-rm="${f.id}">Remove</button>` : ''}</div>`).join('')
    || '<div class="empty" style="padding:12px 0;text-align:left">No Sales Invoice attached yet.</div>';
  const up = d.can_upload
    ? `<div class="no-print" style="margin-top:12px"><input id="inv-file" type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" hidden>
        <button type="button" id="inv-btn">Upload scanned Sales Invoice</button> <small style="color:var(--ink-soft)">PDF, JPG or PNG, up to 15 MB</small></div>`
    : (!d.eligible ? `<p style="margin:12px 0 0;color:var(--ink-soft);font-size:.88rem">${esc(d.reason)}</p>` : '');
  body.innerHTML = files + up;
  body.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this Sales Invoice scan?')) return;
    try { await api('/api/invoices/file/' + b.dataset.rm, { method: 'DELETE' }); toast('File removed'); renderInvoicePanel(entity, id, me); } catch (e) { toast(e.message, true); }
  }));
  const input = body.querySelector('#inv-file'), btn = body.querySelector('#inv-btn');
  if (btn) {
    btn.onclick = () => input.click();
    input.onchange = async () => {
      const f = input.files[0]; if (!f) return;
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const type = f.type || { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }[ext] || '';
      if (f.size > 15 * 1024 * 1024) return toast('That file is over 15 MB.', true);
      btn.disabled = true;
      try {
        const res = await fetch(`/api/invoices/${entity}/${id}`, { method: 'POST', headers: { 'Content-Type': type, 'X-Filename': encodeURIComponent(f.name) }, body: f });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'The upload failed. Try again.');
        toast('Sales Invoice uploaded');
        renderInvoicePanel(entity, id, me);
      } catch (e) { toast(e.message, true); btn.disabled = false; }
    };
  }
}
