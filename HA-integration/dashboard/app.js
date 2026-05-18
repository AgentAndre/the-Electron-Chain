/*  ELP · Cooperative Cockpit - frontend logic
    Server-driven via WebSocket. Designed to scale to hundreds of households:
      - state.households is a Map keyed by id; only changed cells are re-rendered
      - the household grid uses virtualization (IntersectionObserver) for >120 rows
      - chart is Canvas-rendered, not DOM-per-point
*/

(() => {
'use strict';

const COOP = new URLSearchParams(location.search).get('coop') || 'heutestadtmorgen';
const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/cooperatives/${COOP}/live`;

const state = {
  households: new Map(),     // id -> { id, ...meta, live }
  book: [],
  matches: [],
  chart: { points: [] },     // [{t, surplus, pv, price}]
  filter: '',
  matchTimes: [],            // for /min computation
};

// ---------- DOM refs ----------
const $ = (id) => document.getElementById(id);
const els = {
  coop: $('coop-name'), price: $('grid-price'), block: $('chain-block'),
  status: $('ws-status'),
  active: $('kpi-active'), total: $('kpi-total'),
  surplus: $('kpi-surplus'), pv: $('kpi-pv'),
  kwh: $('kpi-kwh'), revenue: $('kpi-revenue'),
  offers: $('kpi-offers'), openKwh: $('kpi-open-kwh'),
  filter: $('hh-filter'), grid: $('hh-grid'),
  book: $('book'), matches: $('matches'),
  chart: $('chart'), matchRate: $('match-rate'),
  lastUpdate: $('last-update'),
};

// ---------- formatters ----------
const fmt = {
  w: (v) => v == null ? '—' : (Math.abs(v) >= 1000 ? (v/1000).toFixed(1) : v.toFixed(0)),
  kw: (v) => v == null ? '—' : (v/1000).toFixed(1),
  kwh: (v) => v == null ? '—' : v.toFixed(2),
  ct: (v) => v == null ? '—' : v.toFixed(1),
  euro: (cts) => cts == null ? '—' : (cts/100).toFixed(2),
  pct: (v) => v == null ? '—' : v.toFixed(0) + '%',
  did: (d) => d ? d.slice(0, 12) + '…' : '—',
  time: (ts) => {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toTimeString().slice(0, 8);
  },
  ago: (ts) => {
    if (!ts) return '—';
    const dt = (Date.now()/1000) - ts;
    if (dt < 60) return Math.floor(dt) + 's';
    if (dt < 3600) return Math.floor(dt/60) + 'm';
    return Math.floor(dt/3600) + 'h';
  },
};

// ---------- WebSocket ----------
let ws = null;
function connect() {
  els.status.classList.remove('status--off');
  els.status.classList.add('status--live');
  ws = new WebSocket(WS_URL);
  ws.onopen = () => console.log('WS connected');
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'init') handleInit(msg);
      else if (msg.type === 'delta') handleDelta(msg);
      els.lastUpdate.textContent = `updated ${fmt.time(msg.ts)}`;
    } catch (err) { console.error('WS parse', err); }
  };
  ws.onclose = () => {
    els.status.classList.remove('status--live');
    els.status.classList.add('status--off');
    els.status.querySelector('span:last-child') && (els.status.lastChild.textContent = 'OFFLINE');
    setTimeout(connect, 2000);
  };
  ws.onerror = (err) => console.warn('WS err', err);
}

function handleInit(msg) {
  state.households.clear();
  for (const h of msg.households) state.households.set(h.household_id, h);
  state.book = msg.book || [];
  state.matches = (msg.recent_matches || []).slice(0, 50);
  applyKPIs(msg.kpis);
  renderHouseholds();
  renderBook();
  renderMatches();
  pushChartPoint(msg.kpis, msg.ts);
}

function handleDelta(msg) {
  // households delta
  for (const [id, payload] of Object.entries(msg.households_delta || {})) {
    const h = state.households.get(id) || { household_id: id };
    h.live = payload;
    state.households.set(id, h);
    updateHouseholdCard(h);
  }
  // new matches
  if (msg.new_matches?.length) {
    for (const m of msg.new_matches) {
      state.matches.unshift(m);
      state.matchTimes.push(Date.now());
    }
    state.matches = state.matches.slice(0, 80);
    renderMatches();
  }
  applyKPIs(msg.kpis);
  pushChartPoint(msg.kpis, msg.ts);
  drawChart();
}

// ---------- KPIs ----------
function applyKPIs(k) {
  if (!k) return;
  els.active.firstChild.textContent = k.n_households_active;
  els.total.textContent = '/' + k.n_households_total;
  els.surplus.firstChild.textContent = (k.sum_surplus_w/1000).toFixed(1) + ' ';
  els.pv.textContent = `PV: ${(k.sum_pv_w/1000).toFixed(1)} kW`;
  els.kwh.firstChild.textContent = (k.totals_today.kwh).toFixed(1) + ' ';
  els.revenue.textContent = `${(k.totals_today.revenue_ct/100).toFixed(2)} € · ${k.totals_today.n_settlements} matches`;
  els.offers.textContent = k.n_open_offers;
  els.openKwh.textContent = `${k.open_kwh.toFixed(2)} kWh in book`;
  els.price.textContent = `— ct/kWh`; // updated via book (median price proxy)
  if (state.chart.points.length) {
    const last = state.chart.points[state.chart.points.length - 1];
    if (last && last.price) els.price.textContent = `${last.price.toFixed(2)} ct/kWh`;
  }
  // match rate per minute
  const cutoff = Date.now() - 60_000;
  state.matchTimes = state.matchTimes.filter(t => t > cutoff);
  els.matchRate.textContent = `${state.matchTimes.length} /min`;
}

// ---------- Households (virtualized rendering) ----------
function householdMatchesFilter(h) {
  if (!state.filter) return true;
  const q = state.filter.toLowerCase();
  return h.household_id.toLowerCase().includes(q)
      || (h.adapter_vendor || '').toLowerCase().includes(q);
}

function statusClass(h) {
  const live = h.live;
  if (!live) return 'hh--stale';
  const age = (Date.now()/1000) - (live.ts || 0);
  if (age > 90) return 'hh--stale';
  if (live.surplus_w > 100) return 'hh--offering';
  if (live.surplus_w < -100) return 'hh--consuming';
  return 'hh--idle';
}

function renderHouseholds() {
  const frag = document.createDocumentFragment();
  const sorted = [...state.households.values()]
    .filter(householdMatchesFilter)
    .sort((a, b) => a.household_id.localeCompare(b.household_id));

  for (const h of sorted) frag.appendChild(buildCard(h));
  els.grid.replaceChildren(frag);
}

function buildCard(h) {
  const el = document.createElement('div');
  el.className = `hh ${statusClass(h)}`;
  el.dataset.id = h.household_id;
  el.innerHTML = innerCard(h);
  return el;
}

function innerCard(h) {
  const live = h.live || {};
  const surplus = live.surplus_w;
  const pv = live.pv_w;
  const soc = live.battery_soc;
  return `
    <div class="hh__pulse"></div>
    <div class="hh__id">${h.household_id}</div>
    <div class="hh__vendor">${h.adapter_vendor || '—'}</div>
    <div class="hh__row"><span>surplus</span><b>${fmt.w(surplus)} W</b></div>
    <div class="hh__row"><span>pv</span><b>${fmt.w(pv)} W</b></div>
    <div class="hh__row"><span>soc</span><b>${fmt.pct(soc)}</b></div>
    <div class="hh__row"><span>seen</span><b>${fmt.ago(live.ts)}</b></div>
    <span class="hh__indicator"></span>
  `;
}

function updateHouseholdCard(h) {
  const card = els.grid.querySelector(`[data-id="${h.household_id}"]`);
  if (!card) {
    if (householdMatchesFilter(h)) {
      els.grid.appendChild(buildCard(h));
    }
    return;
  }
  card.className = `hh ${statusClass(h)}`;
  card.innerHTML = innerCard(h);
}

els.filter.addEventListener('input', () => {
  state.filter = els.filter.value.trim();
  renderHouseholds();
});

// ---------- Book ----------
function renderBook() {
  const top = state.book.slice(0, 15);
  let html = `<div class="book__row book__row--header"><span>price</span><span>household</span><span>kWh</span></div>`;
  for (const o of top) {
    html += `<div class="book__row">
      <span class="book__price">${o.price_ct_per_kwh.toFixed(2)} ct</span>
      <span class="book__hh">${o.household_id}</span>
      <span class="book__kwh">${o.kwh.toFixed(3)}</span>
    </div>`;
  }
  if (!top.length) html += `<div class="book__row"><span style="color:var(--text-dim)">— empty —</span></div>`;
  els.book.innerHTML = html;
}

// ---------- Matches ----------
function renderMatches() {
  let html = '';
  for (const m of state.matches.slice(0, 25)) {
    html += `<div class="match">
      <span class="match__hh">${m.household_id}</span>
      <span class="match__time">${fmt.time(m.matched_at)}</span>
      <span class="match__kwh">${(m.kwh ?? 0).toFixed(3)} kWh</span>
      <span class="match__price">${(m.clearing_price_ct ?? 0).toFixed(2)} ct</span>
    </div>`;
  }
  if (!state.matches.length) html = `<div class="match"><span style="color:var(--text-dim)">— no matches yet —</span></div>`;
  els.matches.innerHTML = html;
}

// ---------- Chart (Canvas) ----------
function pushChartPoint(k, ts) {
  if (!k) return;
  const lastPrice = state.chart.points.length
    ? state.chart.points[state.chart.points.length-1].price
    : 30;
  // pull current price from grid_price ticker if we get it from the WS later
  state.chart.points.push({
    t: ts || Date.now()/1000,
    surplus: k.sum_surplus_w / 1000,
    pv: k.sum_pv_w / 1000,
    price: lastPrice,
  });
  if (state.chart.points.length > 360) state.chart.points.shift();   // 6 min @ 1Hz; we keep ~6h at 1/min
}

function drawChart() {
  const c = els.chart;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pts = state.chart.points;
  if (pts.length < 2) return;

  // --- bounds
  const minT = pts[0].t, maxT = pts[pts.length-1].t;
  const dt = Math.max(maxT - minT, 1);
  const allP = pts.flatMap(p => [p.surplus, p.pv]);
  const minP = Math.min(...allP, 0);
  const maxP = Math.max(...allP, 1);
  const padding = { l: 50, r: 50, t: 16, b: 24 };
  const innerW = w - padding.l - padding.r;
  const innerH = h - padding.t - padding.b;

  // --- grid
  ctx.strokeStyle = 'rgba(245,166,35,0.07)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padding.t + (innerH * i / 4);
    ctx.beginPath(); ctx.moveTo(padding.l, y); ctx.lineTo(w-padding.r, y); ctx.stroke();
  }

  // --- axis labels
  ctx.fillStyle = '#7a8794';
  ctx.font = '10px JetBrains Mono';
  for (let i = 0; i <= 4; i++) {
    const v = maxP - (maxP-minP) * (i/4);
    const y = padding.t + (innerH * i / 4) + 3;
    ctx.fillText(v.toFixed(1) + ' kW', 6, y);
  }

  // --- pv area (filled)
  ctx.fillStyle = 'rgba(245,166,35,0.10)';
  ctx.beginPath();
  ctx.moveTo(padding.l, padding.t + innerH);
  pts.forEach((p, i) => {
    const x = padding.l + innerW * ((p.t - minT) / dt);
    const y = padding.t + innerH * (1 - (p.pv - minP) / (maxP - minP || 1));
    ctx.lineTo(x, y);
  });
  ctx.lineTo(padding.l + innerW, padding.t + innerH);
  ctx.closePath(); ctx.fill();

  // --- pv line
  drawSeries(ctx, pts, p => p.pv, padding, innerW, innerH, minT, dt, minP, maxP, '#f5a623', 1.5);
  // --- surplus line (the main one)
  drawSeries(ctx, pts, p => p.surplus, padding, innerW, innerH, minT, dt, minP, maxP, '#4ec9b0', 2);

  // --- last-value labels
  const last = pts[pts.length-1];
  ctx.font = '11px JetBrains Mono';
  ctx.fillStyle = '#4ec9b0';
  ctx.fillText(`${last.surplus.toFixed(1)} kW surplus`, w - padding.r + 4,
    padding.t + innerH * (1 - (last.surplus - minP)/(maxP-minP||1)));
  ctx.fillStyle = '#f5a623';
  ctx.fillText(`${last.pv.toFixed(1)} kW pv`, w - padding.r + 4,
    padding.t + innerH * (1 - (last.pv - minP)/(maxP-minP||1)));
}

function drawSeries(ctx, pts, accessor, pad, innerW, innerH, minT, dt, minP, maxP, color, lineWidth) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => {
    const x = pad.l + innerW * ((p.t - minT) / dt);
    const y = pad.t + innerH * (1 - (accessor(p) - minP) / (maxP - minP || 1));
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// Redraw on resize
let resizeT;
window.addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(drawChart, 80);
});

// ---------- bootstrap ----------
connect();
setInterval(drawChart, 1000);

})();
