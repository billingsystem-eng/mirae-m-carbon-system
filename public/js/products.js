/* Products page.
   To add or change a product, edit the PRODUCTS list below. Images live in /img/products/.
   An image's optional "fit" sets how it sits on the stage: bleed-top / bleed-bottom / both / wide run it off
   the edge (hides the photo's cut-off end), tilt lays an upright tube on a diagonal, long is the full-length tube. */

const IMG_BASE = '/img/products/';

const PRODUCTS = [
  {
    id: 'smart-bracket', kind: 'bracket', name: 'Smart Bracket LED Light', group: 'Matrix IoT radar bracket lamp',
    blurb: 'Energy-saving all-in-one bracket LED light, model ET-MR-SFD01-24. Radar detection and the IoT gateway light it only when needed and show usage in real time.',
    specs: [['Model', 'ET-MR-SFD01-24'], ['Size (L×W×H)', '1185 × 58 × 50 mm'], ['Input voltage', 'AC 185–265 V'], ['Power', '0–24 W adjustable'],
            ['Efficacy', '150–160 lm/W'], ['Power factor', '≥ 0.9'], ['Colour temperature', '6500 K (±300 K)'], ['Beam angle', '120°'],
            ['Driver', 'Built-in non-isolated'], ['Body', 'Aluminium profile + aluminium board'], ['Protection', 'IP20'], ['Operating temperature', '-20 ~ 45 °C'],
            ['Annual lumen depreciation', '< 3%'], ['Design life', '50,000 hours or more'], ['Service life', '100,000 hours'], ['Warranty', '5 years from purchase date']],
    images: [{ src: 'bracket-1', fit: 'long' }, { src: 'bracket-2', fit: 'long' }, { src: 'bracket-3', fit: 'long' }]
  },
  {
    id: 't8-pro', kind: 'tube', name: 'Smart T8 LED Lamp PRO', group: 'Matrix IoT radar T8 lamp',
    blurb: 'Energy-saving straight T8 LED lamp, model ET-MR-T8A1200-18. Radar detection and the IoT gateway light it only when needed and show usage in real time.',
    specs: [['Model', 'ET-MR-T8A1200-18'], ['Size (L×Ø)', '1198 × Ø28 mm'], ['Input voltage', 'AC 185–265 V'], ['Power', '0–18 W adjustable'],
            ['Efficacy', '170–180 lm/W'], ['Power factor', '≥ 0.9'], ['Colour temperature', '6500 K (±300 K)'], ['Beam angle', '90°'],
            ['Driver', 'Built-in non-isolated'], ['Body', 'Aluminium board'], ['Protection', 'IP20'], ['Operating temperature', '-20 ~ 45 °C'],
            ['Annual lumen depreciation', '< 2%'], ['Design life', '50,000 hours or more'], ['Warranty', '5 years from purchase date']],
    images: [{ src: 't8-pro-1', fit: 'long' }]
  }
];

const $ = (id) => document.getElementById(id);
const url = (img) => `${IMG_BASE}${img.src}.webp`;

let current = 0;      // product in the spotlight
let view = 0;         // photo in the spotlight
let lit = true;       // light on / off
let filter = 'all';

/* ---------- Spotlight ---------- */

/** Re-triggers the tube "strike" flicker. */
function ignite() {
  const stage = $('stage');
  stage.classList.remove('ignite');
  void stage.offsetWidth;            // restart the animation
  if (lit) stage.classList.add('ignite');
}

function setLit(on, withStrike = true) {
  lit = on;
  const stage = $('stage'), btn = $('power');
  stage.classList.toggle('lit', on);
  btn.setAttribute('aria-pressed', String(on));
  btn.querySelector('span').textContent = on ? 'Light on' : 'Light off';
  if (on && withStrike) ignite(); else stage.classList.remove('ignite');
}

/** Swaps the big photo: old one sinks away, new one rises in. */
function showImage(p, i, instant = false) {
  const el = $('spot-img'), img = p.images[i];
  const apply = () => {
    el.src = url(img);
    el.alt = `${p.name}, photo ${i + 1} of ${p.images.length}`;
    el.className = img.fit ? 'fit-' + img.fit : '';
    el.classList.add('in');
  };
  if (instant) return apply();
  el.classList.add('out');
  setTimeout(apply, 170);
}

function renderViews(p) {
  const box = $('spot-views');
  box.innerHTML = p.images.map((img, i) =>
    `<button type="button" data-i="${i}" aria-pressed="${i === view}" aria-label="Photo ${i + 1} of ${p.images.length}">
       <img src="${url(img)}" alt="" loading="lazy" class="${img.fit ? 'fit-' + img.fit : ''}"></button>`).join('');
  box.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.i);
    if (i === view) return;
    view = i;
    box.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(Number(x.dataset.i) === i)));
    showImage(p, i);
  }));
}

function select(index, { strike = true, instant = false } = {}) {
  current = (index + PRODUCTS.length) % PRODUCTS.length;
  view = 0;
  const p = PRODUCTS[current];
  $('spot-group').textContent = p.group;
  $('spot-name').textContent = p.name;
  $('spot-blurb').textContent = p.blurb;
  $('spot-specs').innerHTML = p.specs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('count').textContent = `${current + 1} of ${PRODUCTS.length}`;
  renderViews(p);
  showImage(p, 0, instant);
  if (strike && lit) ignite();
  document.querySelectorAll('.card').forEach((c) => c.setAttribute('aria-current', String(c.dataset.id === p.id)));
  history.replaceState(null, '', '#' + p.id);
}

/* ---------- Card grid ---------- */

function renderCards(animateFilter = false) {
  const box = $('cards');
  const list = PRODUCTS.filter((p) => filter === 'all' || p.kind === filter);
  box.innerHTML = list.map((p, n) => {
    const hero = p.images[0];
    return `<button type="button" class="card" data-id="${p.id}" style="--i:${n}" aria-current="${PRODUCTS[current].id === p.id}">
      <div class="pic"><img src="${url(hero)}" alt="" loading="lazy" class="${hero.fit ? 'fit-' + hero.fit : ''}"></div>
      <div class="meta"><b>${p.name}</b><span>${p.group}</span></div></button>`;
  }).join('') || '<div class="empty">No products in this group.</div>';
  box.classList.toggle('refilter', animateFilter);
  box.querySelectorAll('.card').forEach((c) => (c.onclick = () => {
    select(PRODUCTS.findIndex((p) => p.id === c.dataset.id));
    $('spot').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }));
}

/* ---------- Boot ---------- */

(async function init() {
  await shell();                         // left rail + sign-in check (from app.js)

  const start = PRODUCTS.findIndex((p) => p.id === location.hash.slice(1));
  current = start >= 0 ? start : 0;

  renderCards();
  setLit(true, false);
  select(current, { strike: false, instant: true });
  setTimeout(ignite, 250);               // power on shortly after the page appears

  $('power').onclick = () => setLit(!lit);
  $('prev').onclick = () => select(current - 1);
  $('next').onclick = () => select(current + 1);
  $('filter').querySelectorAll('button').forEach((b) => (b.onclick = () => {
    filter = b.dataset.f;
    $('filter').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    renderCards(true);
  }));
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (e.key === 'ArrowLeft') select(current - 1);
    if (e.key === 'ArrowRight') select(current + 1);
  });
})();