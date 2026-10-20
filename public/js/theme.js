/* Light / dark theme. Load in <head> (before the page paints) so there is no flash.
   Choice is remembered in localStorage; with no saved choice it follows the OS setting. */
(function () {
  const KEY = 'theme';
  const root = document.documentElement;
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  const saved = () => { try { const v = localStorage.getItem(KEY); return v === 'dark' || v === 'light' ? v : null; } catch (e) { return null; } };
  const current = () => root.getAttribute('data-theme') || 'light';

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    const meta = document.querySelector('meta[name="theme-color"]') || Object.assign(document.head.appendChild(document.createElement('meta')), { name: 'theme-color' });
    meta.content = theme === 'dark' ? '#0a1512' : '#eef1ed';
  }

  function set(theme, persist) {
    root.classList.add('theme-anim');
    apply(theme);
    if (persist) { try { localStorage.setItem(KEY, theme); } catch (e) { /* private mode: still works for this page view */ } }
    setTimeout(() => root.classList.remove('theme-anim'), 300);
    document.querySelectorAll('.theme-toggle').forEach(label);
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
    // Charts bake their colours in when drawn, so redraw them for the new theme.
    if (window.Chart && Object.keys(Chart.instances || {}).length) location.reload();
  }

  const ICON = '<svg class="nav-ico t-moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>'
    + '<svg class="nav-ico t-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/></svg>';

  function label(btn) {
    const dark = current() === 'dark';
    const text = dark ? 'Light mode' : 'Dark mode';
    btn.setAttribute('aria-pressed', String(dark));
    btn.setAttribute('aria-label', 'Switch to ' + text.toLowerCase());
    const span = btn.querySelector('.t-label');
    if (span) span.textContent = text;
  }

  /** Returns a ready-to-insert toggle button. */
  function button(floating) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-toggle' + (floating ? ' floating' : '');
    b.innerHTML = ICON + '<span class="t-label"></span>';
    b.onclick = () => set(current() === 'dark' ? 'light' : 'dark', true);
    label(b);
    return b;
  }

  apply(saved() || (mq && mq.matches ? 'dark' : 'light'));
  // Follow the OS only while the person hasn't picked a theme themselves.
  if (mq && mq.addEventListener) mq.addEventListener('change', (e) => { if (!saved()) set(e.matches ? 'dark' : 'light', false); });
  // Keep other open tabs in step.
  window.addEventListener('storage', (e) => { if (e.key === KEY && (e.newValue === 'dark' || e.newValue === 'light')) set(e.newValue, false); });

  // Colours for Chart.js text and grid lines.
  const chart = () => current() === 'dark'
    ? { ink: '#9db4ac', grid: '#223832', surface: '#10201c' }
    : { ink: '#52635e', grid: '#e3e9e4', surface: '#ffffff' };

  window.Theme = { get: current, set: (t) => set(t, true), toggle: () => set(current() === 'dark' ? 'light' : 'dark', true), button, chart };

  // Pages without the left rail (sign-in) get a floating toggle.
  document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('.login') && !document.querySelector('.theme-toggle')) document.body.appendChild(button(true));
  });
})();
