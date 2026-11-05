'use strict';
'require baseclass';
'require fs';
'require rpc';

/*
 * Nightfall: Status → Overview extras.
 *  - a strip of live tiles with mini graphs (internet, WAN speed, CPU, temperature, memory);
 *  - cards sorted by priority, can be dragged (or moved with ↑ ↓ on the grip) and remembered per browser;
 *  - coloured status badges for Wi-Fi signal and port link state.
 * Data comes from /usr/libexec/nightfall-stats and /usr/libexec/nightfall-history (Nightfall monitor package).
 */

const STATS = '/usr/libexec/nightfall-stats';
const HIST = '/usr/libexec/nightfall-history';
const APPSBIN = '/usr/libexec/nightfall-apps';
const ORDER_KEY = 'nightfall-overview-order-v1';
const SIZE_KEY = 'nightfall-overview-size-v1';
const HEIGHT_KEY = 'nightfall-overview-h-v1';
const WIN = 600;            /* seconds shown in mini graphs */
const EVERY = 3000;         /* ms between samples */
const ALERTS_EVERY = 5;     /* ping / alerts every N samples */

const callIfaces = rpc.declare({ object: 'network.interface', method: 'dump' });
const callHints = rpc.declare({ object: 'luci-rpc', method: 'getHostHints', expect: { '': {} } });
const callWireless = rpc.declare({ object: 'network.wireless', method: 'status', expect: { '': {} } });
const callIwDevs = rpc.declare({ object: 'iwinfo', method: 'devices', expect: { devices: [] } });
const callIwInfo = rpc.declare({ object: 'iwinfo', method: 'info', params: [ 'device' ] });
const callAssoc = rpc.declare({ object: 'iwinfo', method: 'assoclist', params: [ 'device' ], expect: { results: [] } });
const callReboot = rpc.declare({ object: 'system', method: 'reboot' });

/* shared live numbers (filled by the live strip, read by the health card) */
const SHARED = { t: null, cpu: null, mem: null, temp: null, online: null, ping: null, loss: null };
let DRAG = false;           /* true while a card is being dragged: the DOM observer must not re-sort */

const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/* card priority: lower goes first; unknown cards keep their order after the known ones */
const PRIORITY = [
	/Интернет|Internet/i, /^(Сеть|Network)$/i, /порт|Port/i, /Беспровод|Wireless|Wi-?Fi/i, /Топ клиентов/i, /Трафик по приложениям/i, /Доступ в интернет/,
	/Состояние роутера/, /сейчас$/, /Лента событий/, /Быстрые действия/,
	/^(Система|System)$/i, /Температур|Temperature/i, /Память|Memory/i, /Хранилищ|Storage/i, /DHCP|Аренд/i, /DSL/i
];

function fmtRate(bps) {
	const bits = bps * 8;
	if (bits >= 1e9) return [ nf2.format(bits / 1e9), 'Гбит/с' ];
	if (bits >= 1e6) return [ (bits >= 1e8 ? nf0 : nf1).format(bits / 1e6), 'Мбит/с' ];
	if (bits >= 1e3) return [ nf0.format(bits / 1e3), 'Кбит/с' ];
	return [ nf0.format(bits), 'бит/с' ];
}

function niceCeil(v) {
	if (v <= 0) return 1;
	const p = Math.pow(10, Math.floor(Math.log10(v)));
	for (const m of [ 1, 2, 2.5, 5, 10 ])
		if (v <= m * p) return m * p;
	return 10 * p;
}

function SVG(tag, attrs, children) {
	const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const k in attrs || {})
		el.setAttribute(k, attrs[k]);
	for (const c of [].concat(children || []))
		if (c != null) el.appendChild(c);
	return el;
}


/* стиль графиков из настроек темы (Персонализация → Графики): заливка, линия, столбики, ступени; сглаживание */
function nfPlot(segs, H) {
	const root = document.documentElement, kind = root.getAttribute('data-nf-chart') || 'area', smooth = root.getAttribute('data-nf-chart-smooth') !== 'off';
	const f = n => n.toFixed(1);
	let line = '', area = '';
	segs.forEach(p => {
		if (!p.length) return;
		let d = 'M' + f(p[0][0]) + ' ' + f(p[0][1]);
		if (kind === 'bars') {   /* столбики: вертикальные штрихи цвета ряда (без заливки) */
			p.forEach(q => { line += 'M' + f(q[0]) + ' ' + f(q[1]) + 'V' + H; });
			return;
		}
		if (kind === 'step') {
			for (let i = 1; i < p.length; i++) d += 'L' + f(p[i][0]) + ' ' + f(p[i - 1][1]) + 'L' + f(p[i][0]) + ' ' + f(p[i][1]);
		}
		else if (smooth && p.length > 2) {
			for (let i = 0; i < p.length - 1; i++) {
				const a = p[Math.max(0, i - 1)], b = p[i], c = p[i + 1], e = p[Math.min(p.length - 1, i + 2)];
				const y1 = Math.max(0, Math.min(H, b[1] + (c[1] - a[1]) / 6)), y2 = Math.max(0, Math.min(H, c[1] - (e[1] - b[1]) / 6));
				d += 'C' + f(b[0] + (c[0] - a[0]) / 6) + ' ' + f(y1) + ' ' + f(c[0] - (e[0] - b[0]) / 6) + ' ' + f(y2) + ' ' + f(c[0]) + ' ' + f(c[1]);
			}
		}
		else for (let i = 1; i < p.length; i++) d += 'L' + f(p[i][0]) + ' ' + f(p[i][1]);
		line += d;
		if (kind !== 'line') area += d + 'L' + f(p[p.length - 1][0]) + ' ' + H + 'L' + f(p[0][0]) + ' ' + H + 'Z';
	});
	return { line, area };
}

/* time based mini graph; classes[i] is the colour class of series i */
function spark(classes) {
	const W = 100, H = 34;
	const parts = classes.map(c => ({
		area: SVG('path', { class: 'a ' + c }),
		line: SVG('path', { class: 'l ' + c })
	}));
	const el = SVG('svg', { class: 'nf-spark', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' },
		parts.reduce((a, p) => a.concat([ p.area, p.line ]), []));

	return {
		el,
		update(times, arrays, max, min) {
			const now = times.length ? times[times.length - 1] : 0, lo = min || 0, span = (max - lo) || 1;
			parts.forEach((p, i) => {
				const vals = arrays[i] || [];
				const pts = [];
				for (let k = 0; k < times.length; k++) {
					if (vals[k] == null || now - times[k] > WIN) continue;
					pts.push([ W - (now - times[k]) / WIN * W, H - 2 - Math.max(0, Math.min(1, (vals[k] - lo) / span)) * (H - 4) ]);
				}
				const pl = nfPlot([ pts ], H);
				p.line.setAttribute('d', pl.line);
				p.area.setAttribute('d', classes.length === 1 ? pl.area : '');
			});
		}
	};
}

function badge(kind, text) {
	return E('span', { class: 'nf-badge ' + kind }, text);
}

/* ---------- tile details: a dialog with a longer history chart ---------- */

const DETAIL = {
	net: { title: 'Интернет', cols: [ [ 7, 'Интернет', 'nf-c-down' ], [ 6, 'До шлюза', 'nf-c-up' ] ], fmt: v => nf0.format(v) + ' мс', ceil: v => niceCeil(Math.max(20, v)) },
	wan: { title: 'Трафик WAN', cols: [ [ 4, 'Загрузка', 'nf-c-down' ], [ 5, 'Отдача', 'nf-c-up' ] ], fmt: v => fmtRate(v).join(' '), ceil: v => niceCeil(Math.max(12500, v)) },
	cpu: { title: 'Процессор', cols: [ [ 1, 'Загрузка', 'nf-c-cpu' ] ], fmt: v => nf0.format(v) + '%', ceil: () => 100 },
	temp: { title: 'Температура', cols: [ [ 3, 'Процессор', 'nf-c-temp' ] ], fmt: v => nf1.format(v) + ' °C', ceil: v => Math.max(100, niceCeil(v)), floor: 30 },
	mem: { title: 'Память', cols: [ [ 2, 'Занято', 'nf-c-mem' ] ], fmt: v => nf0.format(v) + '%', ceil: () => 100 }
};
const DRANGE = { h: [ 'fine', 3600, 'Час' ], d: [ 'coarse', 86400, 'Сутки' ], w: [ 'coarse', 604800, 'Неделя' ] };

function openDetail(key, from) {
	const cfg = DETAIL[key];
	if (!cfg || document.querySelector('.nf-dlg-bg')) return;
	const two = v => String(v).padStart(2, '0');
	const clock = (ts, long) => { const d = new Date(ts * 1000); return (long ? two(d.getDate()) + '.' + two(d.getMonth() + 1) + ' ' : '') + two(d.getHours()) + ':' + two(d.getMinutes()); };
	let range = 'h', data = null;

	const W = 600, H = 220;
	const svg = SVG('svg', { class: 'nf-dchart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
	const xl = E('div', { class: 'nf-dx' });
	const tip = E('div', { class: 'nf-dtip', hidden: '' });
	const wrap = E('div', { class: 'nf-dplot' }, [ svg, tip ]);
	const stats = E('div', { class: 'nf-dstats' });
	const note = E('div', { class: 'nf-dnote' });
	const tabs = {};
	const seg = E('div', { class: 'nf-dseg', role: 'tablist' }, Object.keys(DRANGE).map(k =>
		tabs[k] = E('button', { type: 'button', click: () => { range = k; load(); } }, DRANGE[k][2])));
	const legend = E('div', { class: 'nf-dleg' }, cfg.cols.map(x => E('span', {}, [ E('i', { class: x[2] }), x[1] ])));

	const bg = E('div', { class: 'nf-dlg-bg' });
	const close = () => { document.removeEventListener('keydown', onKey); bg.classList.remove('on'); window.setTimeout(() => { bg.remove(); if (from && from.focus) from.focus(); }, 200); };
	const onKey = ev => { if (ev.key === 'Escape') close(); };
	const dlg = E('div', { class: 'nf-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-label': cfg.title }, [
		E('div', { class: 'nf-dlg-h' }, [ E('h4', {}, [ E('i', { class: 'nf-ci', 'data-i': key === 'wan' || key === 'net' ? 'net' : key === 'cpu' ? 'system' : key }), cfg.title ]), seg,
			E('button', { type: 'button', class: 'nf-dlg-x', 'aria-label': 'Закрыть', click: close }, '×') ]),
		stats, legend, wrap, xl, note ]);
	bg.appendChild(dlg);
	bg.addEventListener('mousedown', ev => { if (ev.target === bg) close(); });
	document.addEventListener('keydown', onKey);
	document.body.appendChild(bg);
	window.requestAnimationFrame(() => bg.classList.add('on'));
	const closeBtn = dlg.querySelector('.nf-dlg-x'); closeBtn.focus();

	function draw() {
		const R = DRANGE[range];
		Object.keys(tabs).forEach(k => tabs[k].setAttribute('aria-pressed', String(k === range)));
		svg.replaceChildren(); xl.replaceChildren(); tip.hidden = true;
		if (!data || !data.rows) { note.textContent = data === false ? 'Сборщик истории не запущен: графика нет.' : 'Загружаю…'; stats.replaceChildren(); return; }
		const end = data.now, win = R[1];
		const rows = data.rows.filter(r => end - r[0] <= win);
		if (rows.length < 2) { note.textContent = 'Пока мало данных за этот период.'; stats.replaceChildren(); return; }
		note.textContent = '';
		const series = cfg.cols.map(x => rows.map(r => r[x[0]] != null && r[x[0]] >= 0 ? r[x[0]] : null));
		const all = [].concat(...series).filter(v => v != null);
		const hi = cfg.ceil(all.length ? Math.max(...all) : 1), lo = cfg.floor || 0, span = (hi - lo) || 1;
		const t0 = end - win;
		const X = t => (t - t0) / win * W, Y = v => H - 4 - Math.max(0, Math.min(1, (v - lo) / span)) * (H - 10);
		for (let i = 0; i <= 4; i++) svg.appendChild(SVG('line', { class: 'g', x1: 0, x2: W, y1: Y(lo + span * i / 4), y2: Y(lo + span * i / 4) }));
		series.forEach((vals, si) => {
			let d = '', ad = '', fx = 0, lx = 0, open = false;
			rows.forEach((r, k) => {
				const v = vals[k];
				if (v == null) { open = false; return; }
				const x = X(r[0]).toFixed(1), y = Y(v).toFixed(1);
				d += (open ? 'L' : 'M') + x + ' ' + y;
				if (!open) fx = x;
				lx = x; open = true;
			});
			if (cfg.cols.length === 1 && d) ad = d + 'L' + lx + ' ' + H + 'L' + fx + ' ' + H + 'Z';
			if (ad) svg.appendChild(SVG('path', { class: 'a ' + cfg.cols[si][2], d: ad }));
			svg.appendChild(SVG('path', { class: 'l ' + cfg.cols[si][2], d }));
		});
		const cur = SVG('line', { class: 'cur', y1: 0, y2: H, x1: 0, x2: 0, visibility: 'hidden' });
		svg.appendChild(cur);
		for (const f of [ 0, .25, .5, .75, 1 ]) xl.appendChild(E('span', {}, clock(t0 + win * f, range !== 'h' && win > 86400 * 1.5)));

		const st = cfg.cols.map((x, si) => {
			const v = series[si].filter(q => q != null);
			return v.length ? [ x[1], v[v.length - 1], Math.min(...v), v.reduce((s, q) => s + q, 0) / v.length, Math.max(...v) ] : null;
		}).filter(Boolean);
		const loss = key === 'net' ? rows.map(r => r[8]).filter(v => v != null && v >= 0) : [];
		const cells = [].concat(...st.map(s => [ [ s[0] + (st.length > 1 ? ' · сейчас' : ': сейчас'), s[1] ], [ st.length > 1 ? s[0] + ' · мин' : 'мин', s[2] ], [ st.length > 1 ? s[0] + ' · средн.' : 'средн.', s[3] ], [ st.length > 1 ? s[0] + ' · макс' : 'макс', s[4] ] ]
			.map(x => E('div', { class: 'nf-ds' }, [ E('span', {}, x[0]), E('b', {}, cfg.fmt(x[1])) ]))));
		if (loss.length) cells.push(E('div', { class: 'nf-ds' }, [ E('span', {}, 'потери в среднем'), E('b', {}, nf1.format(loss.reduce((s, q) => s + q, 0) / loss.length) + '%') ]));
		stats.replaceChildren(...cells);

		const move = ev => {
			const r = wrap.getBoundingClientRect(), f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), t = t0 + f * win;
			let bi = 0, bd = 1e12;
			rows.forEach((q, k) => { const dd = Math.abs(q[0] - t); if (dd < bd) { bd = dd; bi = k; } });
			const x = X(rows[bi][0]);
			cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.setAttribute('visibility', 'visible');
			tip.replaceChildren(E('span', {}, clock(rows[bi][0], win > 86400)), ...cfg.cols.map((cc, si) => E('div', {}, [ E('i', { class: cc[2] }), cc[1] + ' ', E('b', {}, series[si][bi] != null ? cfg.fmt(series[si][bi]) : '–') ])));
			tip.hidden = false;
			const px = x / W * r.width;
			tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, px + 12)) + 'px';
		};
		wrap.onpointermove = move;
		wrap.onpointerleave = () => { cur.setAttribute('visibility', 'hidden'); tip.hidden = true; };
	}

	function load() {
		draw();
		fs.exec(HIST, [ 'series', DRANGE[range][0] ]).then(res => {
			try { data = JSON.parse(res.stdout); } catch (e) { data = false; }
			if (data && data.info && !data.info.started) data = false;
			draw();
		}).catch(() => { data = false; draw(); });
	}
	load();
}

/* ---------- live tiles ---------- */

function liveStrip() {
	const S = {
		t: [], cpu: [], mem: [], temp: [], rx: [], tx: [], ping: [],
		last: null, wan: null, online: null, gw: null, net: null, loss: null
	};
	const R = {};   /* DOM refs */

	const sp = {
		net: spark([ 'nf-c-down' ]), wan: spark([ 'nf-c-down', 'nf-c-up' ]), cpu: spark([ 'nf-c-cpu' ]),
		temp: spark([ 'nf-c-temp' ]), mem: spark([ 'nf-c-mem' ])
	};

	const tile = (key, title, extra, ...rows) => E('div', { class: 'nf-tile', 'data-tile': key }, [
		E('div', { class: 'nf-tile-k' }, [ E('span', {}, title), extra || '' ]) ].concat(rows));

	R.netBadge = E('span', {}, badge('off', '—'));
	R.tempBadge = E('span');
	const strip = E('div', { class: 'nf-live' }, [
		E('div', { class: 'nf-live-h' }, [
			E('span', {}, 'Сейчас'),
			R.reset = E('button', { type: 'button', class: 'nf-linkbtn', title: 'Вернуть порядок карточек по умолчанию' }, 'Сбросить порядок карточек')
		]),
		E('div', { class: 'nf-live-grid' }, [
			tile('net', 'Интернет', R.netBadge,
				R.netV = E('div', { class: 'nf-tile-v' }, '–'), R.netS = E('div', { class: 'nf-tile-s' }, ' '), sp.net.el),
			tile('wan', 'Трафик WAN', null,
				R.wanV = E('div', { class: 'nf-tile-v' }, '–'), R.wanS = E('div', { class: 'nf-tile-s' }, ' '), sp.wan.el),
			tile('cpu', 'Процессор', null,
				R.cpuV = E('div', { class: 'nf-tile-v' }, '–'), R.cpuS = E('div', { class: 'nf-tile-s' }, ' '), sp.cpu.el),
			tile('temp', 'Температура', R.tempBadge,
				R.tempV = E('div', { class: 'nf-tile-v' }, '–'), R.tempS = E('div', { class: 'nf-tile-s' }, ' '), sp.temp.el),
			tile('mem', 'Память', null,
				R.memV = E('div', { class: 'nf-tile-v' }, '–'), R.memS = E('div', { class: 'nf-tile-s' }, ' '), sp.mem.el)
		])
	]);

	strip.addEventListener('click', ev => {
		const t = ev.target.closest && ev.target.closest('.nf-tile[data-tile]');
		if (t) openDetail(t.getAttribute('data-tile'), t);
	});
	strip.addEventListener('keydown', ev => {
		const t = ev.target.closest && ev.target.closest('.nf-tile[data-tile]');
		if (t && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); openDetail(t.getAttribute('data-tile'), t); }
	});
	strip.querySelectorAll('.nf-tile').forEach(t => { t.setAttribute('tabindex', '0'); t.setAttribute('role', 'button'); t.setAttribute('title', 'Нажмите, чтобы открыть график'); });

	function trim(now) {
		while (S.t.length && S.t[0] < now - WIN) {
			S.t.shift(); S.cpu.shift(); S.mem.shift(); S.temp.shift(); S.rx.shift(); S.tx.shift(); S.ping.shift();
		}
	}

	function pickTemp(list) {
		let main = null, first = null;
		for (const [ n, v ] of list || []) {
			const c = v / 1000;
			if (!isFinite(c) || c <= 0 || /phy|mt76|mt79|wifi|wlan|ath|iwlwifi/i.test(n)) continue;
			if (first == null) first = c;
			if (main == null && /cpu|soc|core|a53|a73|thermal/i.test(n)) main = c;
		}
		return main != null ? main : first;
	}

	function ingest(d) {
		const now = Date.now() / 1000, prev = S.last;
		S.last = d;
		if (!prev || d.up <= prev.up) return;

		const sum = x => x[0] + x[1] + x[2] + x[3] + x[4] + x[5] + x[6] + x[7];
		const dt = sum(d.cpu[0]) - sum(prev.cpu[0]);
		const cpu = dt > 0 ? 100 * (1 - ((d.cpu[0][3] + d.cpu[0][4]) - (prev.cpu[0][3] + prev.cpu[0][4])) / dt) : null;

		const up = d.up - prev.up;
		let rx = null, tx = null;
		const dev = S.wan;
		if (dev) {
			const a = prev.net.find(n => n[0] === dev), b = d.net.find(n => n[0] === dev);
			if (a && b && up > 0) {
				rx = Math.max(0, (b[1] - a[1]) / up);
				tx = Math.max(0, (b[5] - a[5]) / up);
			}
		}

		S.t.push(now); S.cpu.push(cpu);
		S.mem.push(100 * (d.mem.total - d.mem.avail) / d.mem.total);
		S.temp.push(pickTemp(d.temps));
		S.rx.push(rx); S.tx.push(tx);
		S.ping.push(S.net != null && S.net >= 0 ? S.net : null);
		trim(now);
	}

	function render() {
		const d = S.last;
		if (!d) return;
		const lastOf = a => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };

		/* internet */
		R.netBadge.replaceChildren(S.online === true ? badge('ok', 'Онлайн') : S.online === false ? badge('bad', 'Нет связи') : badge('off', 'Нет данных'));
		R.netV.textContent = S.net != null && S.net >= 0 ? nf0.format(S.net) + ' мс' : (S.online === false ? '—' : '–');
		R.netS.textContent = S.gw != null && S.gw >= 0 ? 'до шлюза ' + nf1.format(S.gw) + ' мс' : (S.online == null ? 'история не собирается' : ' ');
		sp.net.update(S.t, [ S.ping ], niceCeil(Math.max(20, ...S.ping.filter(v => v != null))));

		/* WAN speed */
		const rx = lastOf(S.rx), tx = lastOf(S.tx);
		if (rx != null) {
			const r = fmtRate(rx), u = fmtRate(tx || 0);
			R.wanV.textContent = '↓ ' + r[0] + ' ' + r[1];
			R.wanS.textContent = '↑ ' + u[0] + ' ' + u[1];
		}
		else R.wanV.textContent = S.wan ? '–' : 'WAN не найден';
		sp.wan.update(S.t, [ S.rx, S.tx ], niceCeil(Math.max(12500, ...S.rx.filter(v => v != null), ...S.tx.filter(v => v != null))));

		/* CPU */
		const cpu = lastOf(S.cpu);
		R.cpuV.textContent = cpu != null ? nf0.format(cpu) + '%' : '–';
		R.cpuS.textContent = 'нагрузка ' + d.load.map(v => nf2.format(v)).join(' · ');
		sp.cpu.update(S.t, [ S.cpu ], 100);

		/* temperature */
		const t = lastOf(S.temp);
		if (t != null) {
			R.tempV.textContent = nf1.format(t) + ' °C';
			R.tempBadge.replaceChildren(t >= 85 ? badge('bad', 'Жарко') : t >= 70 ? badge('warn', 'Тепло') : badge('ok', 'Норма'));
			R.tempS.textContent = 'процессор';
		}
		else { R.tempV.textContent = '–'; R.tempS.textContent = 'нет датчика'; R.tempBadge.replaceChildren(); }
		sp.temp.update(S.t, [ S.temp ], 100, 30);

		/* memory */
		const m = d.mem, used = m.total - m.avail;
		R.memV.textContent = nf0.format(100 * used / m.total) + '%';
		R.memS.textContent = nf0.format(used / 1024) + ' МБ из ' + nf0.format(m.total / 1024) + ' МБ';
		sp.mem.update(S.t, [ S.mem ], 100);

		SHARED.t = Date.now(); SHARED.cpu = cpu; SHARED.mem = 100 * used / m.total; SHARED.temp = t;
		SHARED.online = S.online; SHARED.ping = S.net; SHARED.loss = S.loss;
	}

	function sample() {
		return fs.exec(STATS, []).then(res => {
			let d = null;
			try { d = JSON.parse(res.stdout); } catch (e) { /* ignore */ }
			if (!d) throw new Error('no data');
			ingest(d);
			render();
		});
	}

	function history() {
		return fs.exec(HIST, [ 'alerts' ]).then(res => {
			let h = null;
			try { h = JSON.parse(res.stdout); } catch (e) { /* ignore */ }
			if (!h || !h.info || !h.info.started) { S.online = null; return; }
			const last = (h.last || [])[0];
			const fresh = last && h.now - last[0] <= 90;
			S.net = fresh ? last[7] : null;
			S.gw = fresh ? last[6] : null;
			S.loss = fresh && last[8] != null && last[8] >= 0 ? last[8] : null;
			S.online = fresh ? last[7] >= 0 : null;
			if ((h.active || []).some(a => a[0] === 'wan')) S.online = false;
		}).catch(() => { S.online = null; });
	}

	function seed() {
		return fs.exec(HIST, [ 'series', 'fine' ]).then(res => {
			let h = null;
			try { h = JSON.parse(res.stdout); } catch (e) { /* ignore */ }
			if (!h || !h.rows) return;
			for (const r of h.rows) {
				if (h.now - r[0] > WIN) continue;
				S.t.push(r[0]); S.cpu.push(r[1] >= 0 ? r[1] : null); S.mem.push(r[2] >= 0 ? r[2] : null);
				S.temp.push(r[3] >= 0 ? r[3] : null); S.rx.push(r[4] >= 0 ? r[4] : null); S.tx.push(r[5] >= 0 ? r[5] : null);
				S.ping.push(r[7] >= 0 ? r[7] : null);
			}
		}).catch(() => {});
	}

	function findWan() {
		return callIfaces().then(res => {
			for (const i of (res && res.interface) || []) {
				const dev = i.l3_device || i.device;
				if (dev && i.up && (i.route || []).some(r => r.target === '0.0.0.0' || r.target === '::')) { S.wan = dev; return; }
			}
		}).catch(() => {});
	}

	let n = 0, timer = null;
	function tick() {
		if (document.hidden || window.getComputedStyle(strip).display === 'none') return;
		sample().then(() => {
			if (n++ % ALERTS_EVERY === 0) return history().then(render);
		}).catch(() => {
			/* stats script not available (no ACL or package missing): drop the strip */
			if (!S.last) { strip.remove(); window.clearInterval(timer); }
		});
	}

	return {
		el: strip,
		resetBtn: R.reset,
		start() {
			Promise.all([ findWan(), seed() ]).then(() => history()).then(() => {
				tick();
				timer = window.setInterval(tick, EVERY);
			});
		}
	};
}

/* ---------- cards: priority order, drag & drop ---------- */

const PIN_KEY = 'nightfall-overview-pins-v1';
const NAMES_KEY = 'nightfall-names-v1';
let PIN_MEM = null, NAMES_MEM = null, EDITING = false;

function loadPins() {
	try { const v = JSON.parse(window.localStorage.getItem(PIN_KEY) || 'null'); return Array.isArray(v) ? v : (PIN_MEM || []); }
	catch (e) { return PIN_MEM || []; }
}

function savePins(list) {
	PIN_MEM = list;
	try { window.localStorage.setItem(PIN_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
}

function loadNames() {
	try { const v = JSON.parse(window.localStorage.getItem(NAMES_KEY) || 'null'); return v && typeof v === 'object' ? v : (NAMES_MEM || {}); }
	catch (e) { return NAMES_MEM || {}; }
}

function setName(key, value) {
	const n = Object.assign({}, loadNames());
	if (value) n[key] = value; else delete n[key];
	NAMES_MEM = n;
	try { window.localStorage.setItem(NAMES_KEY, JSON.stringify(n)); } catch (e) { /* private mode */ }
}

const nameKey = k => String(k || '').toUpperCase();

/* inline rename: swaps the title box for an input; Enter or leaving the field saves, Esc cancels, empty text restores the automatic name */
function editName(box, key, auto, done) {
	const inp = E('input', { class: 'nf-rename', type: 'text', maxlength: '40', placeholder: auto, 'aria-label': 'Своё имя устройства' });
	inp.value = loadNames()[nameKey(key)] || '';
	box.replaceChildren(inp);
	EDITING = true;
	inp.focus(); inp.select();
	let fin = false;
	const end = save => {
		if (fin) return;
		fin = true; EDITING = false;
		if (save) setName(nameKey(key), inp.value.trim());
		done();
	};
	inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') end(true); else if (ev.key === 'Escape') end(false); });
	inp.addEventListener('blur', () => end(true));
}

let MEM = null;   /* fallback when localStorage is blocked: order survives until the page is reloaded */

function loadOrder() {
	try { const v = JSON.parse(window.localStorage.getItem(ORDER_KEY) || 'null'); return Array.isArray(v) ? v : MEM; }
	catch (e) { return MEM; }
}

function saveOrder(list) {
	MEM = list || null;
	try {
		if (list) window.localStorage.setItem(ORDER_KEY, JSON.stringify(list));
		else window.localStorage.removeItem(ORDER_KEY);
	} catch (e) { /* private mode */ }
}

function cardsOf(view) {
	return Array.from(view.children).filter(c => c.classList.contains('cbi-section') && c.querySelector(':scope > .cbi-title h3'));
}

function titleOf(sec) {
	const h = sec.querySelector(':scope > .cbi-title h3');
	return h ? (h.getAttribute('data-nf-title') || h.textContent.trim()) : '';
}

function rank(title, index, saved, pins) {
	const pin = pins && pins.includes(title) ? 0 : 1;
	const si = saved ? saved.indexOf(title) : -1;
	if (si >= 0) return [ pin, 0, si, 0 ];
	let p = PRIORITY.findIndex(re => re.test(title));
	if (p < 0) p = 100;
	return [ pin, 1, p, index ];
}

function sortCards(view, saved) {
	const cards = cardsOf(view);
	if (cards.length < 2) return;
	const pins = loadPins();
	const sorted = cards.map((c, i) => ({ c, r: rank(titleOf(c), i, saved, pins) }))
		.sort((a, b) => a.r[0] - b.r[0] || a.r[1] - b.r[1] || a.r[2] - b.r[2] || a.r[3] - b.r[3]).map(x => x.c);
	if (sorted.every((c, i) => c === cards[i])) return;   /* already in order: do not touch the DOM (restarts animations) */
	const marker = document.createComment('nf');
	view.insertBefore(marker, cards[0]);
	sorted.forEach(c => view.insertBefore(c, marker));
	marker.remove();
}

/* FLIP: remember where the elements were, run the change, then glide them from the old place to the new one */
function flip(items, mutate) {
	if (document.documentElement.getAttribute('data-nf-motion') === 'off') { mutate(); return; }
	const before = new Map(items.map(e => [ e, e.getBoundingClientRect() ]));
	mutate();
	const moved = [];
	items.forEach(e => {
		const a = before.get(e), b = e.getBoundingClientRect();
		const dx = a.left - b.left, dy = a.top - b.top;
		if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
		e.style.transition = 'none';
		e.style.transform = 'translate(' + dx + 'px, ' + dy + 'px)';
		moved.push(e);
	});
	if (!moved.length) return;
	void document.body.offsetWidth;
	window.requestAnimationFrame(() => moved.forEach(e => {
		e.classList.add('nf-moving');
		e.style.transition = 'transform .3s cubic-bezier(.2, .8, .2, 1)';
		e.style.transform = '';
		let done = false;
		const fin = () => { if (done) return; done = true; e.style.transition = ''; e.classList.remove('nf-moving'); e.removeEventListener('transitionend', fin); };
		e.addEventListener('transitionend', fin);
		window.setTimeout(fin, 420);
	}));
}

/* pointer-driven drag: the card follows the cursor, a dashed slot marks where it will land, the others glide aside */
function startDrag(view, sec, ev, persist) {
	const rect = sec.getBoundingClientRect(), cs = window.getComputedStyle(sec);
	const offX = ev.clientX - rect.left, offY = ev.clientY - rect.top;
	let px = ev.clientX, py = ev.clientY, last = 0, raf = 0, ended = false;

	const slot = E('div', { class: 'nf-slot' });
	slot.style.gridColumn = cs.gridColumnStart + ' / ' + cs.gridColumnEnd;
	slot.style.gridRowEnd = sec.style.gridRowEnd;
	slot.style.height = rect.height + 'px';
	slot.style.marginBottom = cs.marginBottom;
	DRAG = true;
	view.insertBefore(slot, sec);
	document.body.classList.add('nf-drag-on');
	sec.classList.add('nf-lifted');
	sec.style.left = rect.left + 'px'; sec.style.top = rect.top + 'px';
	sec.style.width = rect.width + 'px'; sec.style.height = rect.height + 'px';

	const check = () => {
		const now = performance.now();
		if (now - last < 150) return;
		const others = cardsOf(view).filter(c => c !== sec);
		const target = others.find(c => { const r = c.getBoundingClientRect(); return px >= r.left && px <= r.right && py >= r.top && py <= r.bottom; });
		if (!target) return;
		const r = target.getBoundingClientRect(), wide = r.width > view.clientWidth * 0.7;
		const rx = (px - r.left) / r.width - 0.5, ry = (py - r.top) / r.height - 0.5;
		const before = (!wide && Math.abs(rx) > Math.abs(ry)) ? rx < 0 : ry < 0;
		const ref = before ? target : target.nextSibling;
		if (ref === slot || slot.nextSibling === ref) return;
		flip(others, () => view.insertBefore(slot, ref));
		last = now;
	};

	const loop = () => {
		if (ended) return;
		if (py < 70) window.scrollBy(0, -Math.min(22, (70 - py) / 3 + 4));
		else if (py > window.innerHeight - 70) window.scrollBy(0, Math.min(22, (py - (window.innerHeight - 70)) / 3 + 4));
		check();
		raf = window.requestAnimationFrame(loop);
	};

	const move = e => {
		px = e.clientX; py = e.clientY;
		sec.style.left = (px - offX) + 'px'; sec.style.top = (py - offY) + 'px';
		check();
	};

	const finish = () => {
		if (ended) return;
		ended = true;
		window.cancelAnimationFrame(raf);
		window.removeEventListener('pointermove', move);
		window.removeEventListener('pointerup', finish);
		window.removeEventListener('pointercancel', finish);
		const t = slot.getBoundingClientRect();
		const land = () => {
			view.insertBefore(sec, slot);
			slot.remove();
			sec.classList.remove('nf-lifted', 'nf-landing');
			sec.style.left = sec.style.top = sec.style.width = sec.style.height = sec.style.transition = '';
			document.body.classList.remove('nf-drag-on');
			persist();
			DRAG = false;
		};
		if (document.documentElement.getAttribute('data-nf-motion') === 'off') { land(); return; }
		sec.classList.add('nf-landing');
		sec.style.left = t.left + 'px'; sec.style.top = t.top + 'px';
		let done = false;
		const fin = () => { if (done) return; done = true; land(); };
		sec.addEventListener('transitionend', fin);
		window.setTimeout(fin, 320);
	};

	window.addEventListener('pointermove', move);
	window.addEventListener('pointerup', finish);
	window.addEventListener('pointercancel', finish);
	raf = window.requestAnimationFrame(loop);
}

const ICONS = [
	[ /Интернет|Internet/i, 'net' ], [ /^(Сеть|Network)$/i, 'network' ], [ /порт|Port/i, 'ports' ], [ /Беспровод|Wireless|Wi.?Fi/i, 'wifi' ],
	[ /Топ клиентов/i, 'top' ], [ /Состояние роутера/i, 'health' ], [ /Лента|событ/i, 'events' ], [ /Быстрые/i, 'quick' ],
	[ /^(Система|System)$/i, 'system' ], [ /Температур/i, 'temp' ], [ /Память|Memory/i, 'mem' ], [ /Хранилищ|Storage/i, 'disk' ], [ /DHCP|Аренд/i, 'dhcp' ]
];
const iconFor = title => (ICONS.find(x => x[0].test(title)) || [ 0, 'generic' ])[1];

/* размер карточки: '' (обычная) → wide → min; запоминается по названию карточки */
let SIZE_MEM = null;
function loadSizes() {
	try { const v = JSON.parse(window.localStorage.getItem(SIZE_KEY) || 'null'); return v && typeof v === 'object' ? v : (SIZE_MEM || {}); }
	catch (e) { return SIZE_MEM || {}; }
}
function saveSizes(m) {
	SIZE_MEM = m;
	try { window.localStorage.setItem(SIZE_KEY, JSON.stringify(m)); } catch (e) { /* private mode */ }
}
/* высота карточки, которую пользователь задал, потянув за уголок (px, по названию карточки) */
let H_MEM = null;
function loadHeights() {
	try { const v = JSON.parse(window.localStorage.getItem(HEIGHT_KEY) || 'null'); return v && typeof v === 'object' ? v : (H_MEM || {}); }
	catch (e) { return H_MEM || {}; }
}
function saveHeights(m) {
	H_MEM = m;
	try { window.localStorage.setItem(HEIGHT_KEY, JSON.stringify(m)); } catch (e) { /* private mode */ }
}
/* IP и MAC в таблицах (аренда DHCP, Wi‑Fi) не переносим по символам */
const NW_RE = /^((\d{1,3}\.){3}\d{1,3}|([0-9a-f]{2}[:-]){5}[0-9a-f]{2})$/i;
function markNoWrap(view) {
	view.querySelectorAll('.td, td').forEach(td => {
		if (!td.classList.contains('nf-nw') && NW_RE.test(td.textContent.trim())) td.classList.add('nf-nw');
	});
}

/* Таблицы с живыми данными (Wi‑Fi клиенты, аренды DHCP): LuCI пересобирает строки каждые 5 секунд, и ширина колонок и высота строк
   «дышат» из-за меняющегося текста (сигнал, скорость, подписи). Запоминаем наибольшие размеры и не даём таблице сжиматься обратно.
   Вызывается синхронно из MutationObserver, до отрисовки кадра, поэтому скачка не видно. Сбрасывается при изменении размера окна. */
let STAB_GEN = 0, STAB_W = window.innerWidth;
const STAB_MEM = {};   /* наибольшие размеры по id таблицы: LuCI создаёт таблицу заново при каждом опросе, память должна переживать смену элемента */
window.addEventListener('resize', () => { if (Math.abs(window.innerWidth - STAB_W) > 2) { STAB_W = window.innerWidth; STAB_GEN++; } });
/* смена размера карточек, плотности, шрифта или стиля в «Персонализации»: забываем накопленные минимумы, иначе таблицы остались бы прежнего размера */
new MutationObserver(() => {
	STAB_GEN++;
	const v = document.getElementById('view');
	if (v) { v.querySelectorAll('.cbi-section').forEach(c => { if (!c.classList.contains('nf-fixh')) c.style.minHeight = ''; }); window.setTimeout(() => { stabilizeTables(v); window.dispatchEvent(new Event('resize')); }, 120); }
}).observe(document.documentElement, { attributes: true, attributeFilter: [ 'data-nf-ov-size', 'data-nf-density', 'data-nf-font', 'data-nf-style', 'data-nf-radius', 'data-nf-fsz', 'data-nf-ovwide', 'style' ] });
/* «Подключённые клиенты»: имя узла в первой строке, ниже IP и MAC (отдельный столбец MAC скрывается) */
function decorateHosts(view) {
	view.querySelectorAll('#wifi_assoclist_table').forEach(tb => {
		let any = false;
		tb.querySelectorAll('tr.tr, .tr').forEach(r => {
			if (r.classList.contains('table-titles') || r.querySelector(':scope > .th, :scope > th')) return;
			const c = r.querySelectorAll(':scope > .td, :scope > td');
			if (c.length < 3 || c[2].querySelector('.nf-host')) { if (c.length >= 3) any = true; return; }
			const mac = (c[1].textContent || '').trim(), raw = (c[2].textContent || '').trim();
			const m = /^(.+?)\s*\(([^)]*)\)\s*$/.exec(raw);
			const name = m ? m[1] : '', addrs = (m ? m[2] : raw).split(/\s*,\s*/).filter(Boolean);
			const v4 = addrs.find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || addrs[0] || '';
			const wrap = E('div', { class: 'nf-host', title: raw }), isMac = x => x && /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(x);
			if (name) {
				wrap.appendChild(E('div', { class: 'nf-h1' }, name));
				wrap.appendChild(E('div', { class: 'nf-h2' }, [ v4, isMac(mac) ? E('span', { class: 'nf-h2m' }, ' · ' + mac) : '' ]));
			} else wrap.appendChild(E('div', { class: 'nf-h1 nf-h1ip' }, [ v4 || '?', isMac(mac) ? E('span', { class: 'nf-h2m' }, ' · ' + mac) : '' ]));
			c[2].textContent = ''; c[2].appendChild(wrap);
			any = true;
		});
		tb.classList.toggle('nf-hostmerged', any);
	});
}
function stabilizeTables(view) {
	view.querySelectorAll('.table').forEach(tb => {
		if (!tb.querySelector('.td[data-title], td')) return;
		const st = tb.id ? (STAB_MEM[tb.id] = STAB_MEM[tb.id] || {}) : (tb.__nfSt = tb.__nfSt || {});
		if (st.gen !== STAB_GEN) { st.gen = STAB_GEN; st.col = []; st.row = []; st.h = 0; }
		if (tb.__nfGen !== STAB_GEN) { tb.__nfGen = STAB_GEN; tb.querySelectorAll('.tr, tr').forEach(r => { r.style.minHeight = ''; r.querySelectorAll('.td, .th, td, th').forEach(c => { c.style.minWidth = ''; }); }); tb.style.minHeight = ''; }
		const rows = Array.from(tb.querySelectorAll(':scope > .tr, :scope > tbody > tr, :scope > thead > tr'));
		if (!rows.length || tb.getBoundingClientRect().width < 40) return;
		rows.forEach((r, ri) => {
			const cells = Array.from(r.querySelectorAll(':scope > .td, :scope > .th, :scope > td, :scope > th'));
			cells.forEach((c, ci) => {
				const w = Math.ceil(c.getBoundingClientRect().width);
				if (w > (st.col[ci] || 0)) st.col[ci] = w;
				if (st.col[ci] && c.style.minWidth !== st.col[ci] + 'px') c.style.minWidth = st.col[ci] + 'px';
			});
			const h = Math.ceil(r.getBoundingClientRect().height);
			if (h > (st.row[ri] || 0)) st.row[ri] = h;
			if (st.row[ri] && r.style.minHeight !== st.row[ri] + 'px') r.style.minHeight = st.row[ri] + 'px';
		});
		const th = Math.ceil(tb.getBoundingClientRect().height);
		if (th > st.h) st.h = th;
		if (st.h && tb.style.minHeight !== st.h + 'px') tb.style.minHeight = st.h + 'px';
	});
}

function syncSizes(view, relayoutNow) {
	const m = loadSizes();
	cardsOf(view).forEach(sec => {
		const t = titleOf(sec), v = m[t] || '';
		sec.classList.toggle('nf-wide', v === 'wide');
		sec.classList.toggle('nf-min', v === 'min');
		const hh = +loadHeights()[t] || 0;
		sec.style.minHeight = hh && v !== 'min' ? hh + 'px' : '';
		sec.classList.toggle('nf-fixh', !!hh && v !== 'min');
		const b = sec.querySelector(':scope > .cbi-title .nf-size');
		if (b) { b.setAttribute('data-s', v); b.title = v === 'wide' ? 'Широкая. Нажмите, чтобы свернуть' : v === 'min' ? 'Свёрнута. Нажмите, чтобы вернуть обычный размер' : 'Обычный размер. Нажмите, чтобы растянуть на всю ширину'; }
	});
	if (relayoutNow) window.dispatchEvent(new Event('resize'));
}

function syncPins(view) {
	const pins = loadPins();
	cardsOf(view).forEach(sec => {
		const on = pins.includes(titleOf(sec));
		sec.classList.toggle('nf-pinned', on);
		const b = sec.querySelector(':scope > .cbi-title .nf-pin');
		if (b) { b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Открепить' : 'Закрепить вверху'; }
	});
}

function decorateCards(view) {
	const persist = () => saveOrder(cardsOf(view).map(titleOf));

	cardsOf(view).forEach(sec => {
		if (sec.hasAttribute('data-nf-card')) { if (sec.__nfRs && sec.__nfRs.parentNode !== sec) sec.appendChild(sec.__nfRs); return; }   /* LuCI может пересобрать содержимое: возвращаем уголок на место */
		sec.setAttribute('data-nf-card', '1');

		const h3 = sec.querySelector(':scope > .cbi-title h3');
		const tn = h3.firstChild;
		if (!tn || tn.nodeType !== 3) return;

		const title = tn.data.trim();
		h3.setAttribute('data-nf-title', title);
		const grip = E('span', {
			class: 'nf-grip', role: 'button', tabindex: '0', title: 'Потяните, чтобы переместить карточку (или нажмите ↑ ↓ на этом значке)',
			'aria-label': 'Переместить карточку «' + title + '»'
		}, '⋮⋮');
		const pin = E('button', { type: 'button', class: 'nf-pin', title: 'Закрепить вверху', 'aria-label': 'Закрепить карточку «' + title + '»', 'aria-pressed': 'false' });
		pin.addEventListener('click', ev => {
			ev.preventDefault(); ev.stopPropagation();
			const pins = loadPins().filter(t => t !== title);
			if (!loadPins().includes(title)) pins.push(title);
			savePins(pins);
			syncPins(view);
			flip(cardsOf(view), () => sortCards(view, loadOrder()));
		});
		const size = E('button', { type: 'button', class: 'nf-size', 'data-s': '', 'aria-label': 'Размер карточки «' + title + '»' });
		size.addEventListener('click', ev => {
			ev.preventDefault(); ev.stopPropagation();
			const m = Object.assign({}, loadSizes()), cur = m[title] || '';
			const nx = cur === '' ? 'wide' : cur === 'wide' ? 'min' : '';
			if (nx) m[title] = nx; else delete m[title];
			saveSizes(m);
			syncSizes(view, true);
		});
		h3.replaceChild(E('span', { class: 'nf-ttl' }, [ grip, E('i', { class: 'nf-ci', 'data-i': iconFor(title), 'aria-hidden': 'true' }), title, pin, size ]), tn);

		const hb = h3.querySelector(':scope > .label[data-indicator], :scope > .cbi-button, :scope > button');
		if (hb) {
			const sync = () => {
				const tx = (hb.textContent || '').trim();
				if (tx) { hb.setAttribute('title', tx); hb.setAttribute('aria-label', tx); }
				hb.classList.toggle('nf-show', /показ|разв|show|unhide/i.test(tx));
			};
			sync(); hb.addEventListener('mouseenter', sync); hb.addEventListener('focus', sync);
			hb.addEventListener('click', () => { window.setTimeout(sync, 60); window.setTimeout(sync, 400); });
		}

		grip.addEventListener('pointerdown', ev => {
			if (DRAG || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
			ev.preventDefault();
			const x0 = ev.clientX, y0 = ev.clientY;
			const probe = e => {
				if (Math.abs(e.clientX - x0) + Math.abs(e.clientY - y0) < 4) return;
				drop();
				startDrag(view, sec, e, persist);
			};
			const drop = () => { window.removeEventListener('pointermove', probe); window.removeEventListener('pointerup', drop); window.removeEventListener('pointercancel', drop); };
			window.addEventListener('pointermove', probe);
			window.addEventListener('pointerup', drop);
			window.addEventListener('pointercancel', drop);
		});

		/* уголок для растягивания: вправо/влево меняет ширину (одна колонка или вся ширина), вниз/вверх высоту */
		const rs = E('span', { class: 'nf-rs', role: 'slider', tabindex: '0', 'aria-label': 'Размер карточки «' + title + '»: стрелки меняют ширину и высоту, Delete сбрасывает',
			title: 'Потяните, чтобы изменить размер. Двойное нажатие сбрасывает.' });
		sec.appendChild(rs); sec.__nfRs = rs;
		const setH = (px, save) => {
			const m = Object.assign({}, loadHeights());
			if (px) m[title] = Math.round(px); else delete m[title];
			if (save) saveHeights(m);
			sec.style.minHeight = px ? Math.round(px) + 'px' : '';
			sec.classList.toggle('nf-fixh', !!px);
		};
		const setW = wide => {
			const m = Object.assign({}, loadSizes());
			if (wide) m[title] = 'wide'; else delete m[title];
			saveSizes(m);
			syncSizes(view, true);
		};
		rs.addEventListener('pointerdown', ev => {
			if (ev.pointerType === 'mouse' && ev.button !== 0) return;
			ev.preventDefault(); ev.stopPropagation();
			const x0 = ev.clientX, y0 = ev.clientY, h0 = sec.getBoundingClientRect().height, wide0 = sec.classList.contains('nf-wide');
			const multi = window.matchMedia('(min-width: 900px)').matches;
			rs.setPointerCapture(ev.pointerId);
			sec.classList.add('nf-resizing');
			let moved = false;
			const mv = e => {
				const dy = e.clientY - y0, dx = e.clientX - x0;
				if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
				if (!moved) return;
				setH(Math.max(90, h0 + dy), false);
				if (multi) {
					if (!wide0 && dx > 70) sec.classList.add('nf-wide');
					else if (wide0 && dx < -70) sec.classList.remove('nf-wide');
					else sec.classList.toggle('nf-wide', wide0);
				}
				window.dispatchEvent(new Event('resize'));
			};
			const up = () => {
				rs.removeEventListener('pointermove', mv); rs.removeEventListener('pointerup', up); rs.removeEventListener('pointercancel', up);
				sec.classList.remove('nf-resizing');
				if (!moved) return;   /* простое нажатие ничего не запоминает */
				const hh = Math.round(sec.getBoundingClientRect().height);
				saveHeights(Object.assign({}, loadHeights(), { [title]: Math.max(90, hh) }));
				const m = Object.assign({}, loadSizes());
				if (sec.classList.contains('nf-wide')) m[title] = 'wide'; else if (m[title] === 'wide') delete m[title];
				saveSizes(m);
				syncSizes(view, true);
			};
			rs.addEventListener('pointermove', mv); rs.addEventListener('pointerup', up); rs.addEventListener('pointercancel', up);
		});
		rs.addEventListener('dblclick', () => { setH(0, true); setW(false); });
		rs.addEventListener('keydown', ev => {
			const cur = sec.getBoundingClientRect().height;
			if (ev.key === 'ArrowRight') setW(true);
			else if (ev.key === 'ArrowLeft') setW(false);
			else if (ev.key === 'ArrowDown') setH(cur + 40, true);
			else if (ev.key === 'ArrowUp') setH(Math.max(90, cur - 40), true);
			else if (ev.key === 'Delete' || ev.key === 'Backspace' || ev.key === 'Home') { setH(0, true); setW(false); }
			else return;
			ev.preventDefault(); window.dispatchEvent(new Event('resize'));
		});

		grip.addEventListener('keydown', ev => {
			if (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown') return;
			ev.preventDefault();
			const list = cardsOf(view), i = list.indexOf(sec);
			let ok = false;
			if (ev.key === 'ArrowUp' && i > 0) { flip(list, () => view.insertBefore(sec, list[i - 1])); ok = true; }
			else if (ev.key === 'ArrowDown' && i < list.length - 1) { flip(list, () => view.insertBefore(list[i + 1], sec)); ok = true; }
			if (!ok) return;
			grip.focus();
			persist();
		});
	});
}

/* ---------- status badges ---------- */

function signalLevel(dbm) {
	if (dbm >= -60) return [ 'ok', 'Отличный' ];
	if (dbm >= -70) return [ 'ok', 'Хороший' ];
	if (dbm >= -80) return [ 'warn', 'Слабый' ];
	return [ 'bad', 'Плохой' ];
}

/* Идемпотентно: вызывается синхронно из MutationObserver (до отрисовки кадра),
   поэтому «сырой» текст LuCI («нет соединения», «1 GbE») ни разу не попадает на экран. */
function enhanceBadges(view) {
	/* Wi-Fi clients: signal strength */
	view.querySelectorAll('.ifacebadge[data-signal]').forEach(b => {
		const raw = b.getAttribute('data-signal');
		const have = b.querySelector(':scope > .nf-badge');
		if (have && b.getAttribute('data-nf-q') === raw) return;
		const dbm = parseInt(raw, 10);
		b.setAttribute('data-nf-q', raw);
		if (!isFinite(dbm)) return;
		const [ kind, text ] = signalLevel(dbm);
		if (have) { have.className = 'nf-badge ' + kind; if (have.textContent !== text) have.textContent = text; }
		else b.appendChild(badge(kind, text));
	});

	/* port boxes: link state next to the speed */
	view.querySelectorAll('.ifacebox').forEach(box => {
		const img = box.querySelector('.ifacebox-body > img[src*="port_"], .ifacebox-body > img[src*="/pse_"]');
		if (!img) return;
		const up = /_up\.svg/.test(img.getAttribute('src'));
		const state = up ? 'up' : 'down';
		if (box.getAttribute('data-nf-port') !== state) box.setAttribute('data-nf-port', state);
		const body = img.parentNode, node = body.lastChild;
		if (!node || node === img || node.nodeName === 'BR') return;
		if (node.nodeType === 3) {
			const raw = node.data.trim();
			if (!raw) return;
			let txt = raw;
			if (!up && /соедин|no link|not connected|disconnected|нет/i.test(txt)) txt = 'нет связи';
			const bd = badge(up ? 'ok' : 'off', txt);
			bd.title = raw;
			body.replaceChild(bd, node);
		}
		else if (!node.classList.contains('nf-badge') || !node.classList.contains(up ? 'ok' : 'off')) {
			node.classList.remove('ok', 'off');
			node.classList.add('nf-badge', up ? 'ok' : 'off');
		}
	});
}

/* ---------- dense grid layout: each card spans N rows of 8px ---------- */

function gridLayout(view) {
	const ROW = 8, GAP = 16;
	let raf = 0;
	const ro = new ResizeObserver(() => schedule());
	const seen = new WeakSet();

	function apply() {
		raf = 0;
		const grid = window.getComputedStyle(view).display === 'grid';
		Array.from(view.children).forEach(el => {
			if (!(el.classList.contains('cbi-section') || el.classList.contains('nf-live'))) return;
			if (!seen.has(el)) { seen.add(el); ro.observe(el); }
			if (!grid) { el.style.gridRowEnd = ''; return; }
			const h = el.getBoundingClientRect().height;
			el.style.gridRowEnd = 'span ' + Math.max(1, Math.ceil((h + GAP) / ROW));
		});
	}
	function schedule() { if (!raf) raf = window.requestAnimationFrame(apply); }

	window.addEventListener('resize', schedule);
	return schedule;
}


/* ---------- top clients card ---------- */

function fmtBytes(b) {
	const u = [ 'Б', 'КБ', 'МБ', 'ГБ', 'ТБ' ];
	let i = 0;
	while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
	return (i < 2 ? nf0 : nf2).format(b) + ' ' + u[i];
}

function normIp(ip) {
	if (ip.indexOf(':') < 0) return ip;
	const h = ip.toLowerCase().split('::');
	const a = h[0] ? h[0].split(':') : [], b = h.length > 1 && h[1] ? h[1].split(':') : [];
	const mid = h.length > 1 ? new Array(Math.max(0, 8 - a.length - b.length)).fill('0') : [];
	return a.concat(mid, b).map(g => g.padStart(4, '0')).join(':');
}

function topCard() {
	const body = E('div', { class: 'nf-top-b' }, E('div', { class: 'nf-empty' }, 'Собираю данные…'));
	const el = E('div', { class: 'cbi-section nf-top fade-in' }, [
		E('div', { class: 'cbi-title' }, E('h3', {}, 'Топ клиентов')), body ]);
	let names = null, timer = null;

	let last = null;

	function render(dv) {
		if (EDITING) return;
		last = dv;
		if (!dv || !Array.isArray(dv.rate)) {
			body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Нет данных'), E('span', {}, 'Сбор статистики по устройствам не запущен.') ]));
			return;
		}
		const ipName = {};
		for (const mac in names || {})
			for (const ip of (names[mac].ipaddrs || []).concat(names[mac].ip6addrs || []))
				ipName[normIp(ip)] = { n: names[mac].name || mac, k: mac };
		const routerIps = ((dv.info && dv.info.router_ips) || '').split(/\s+/).filter(Boolean);
		const rows = {};
		const row = ip => {
			const nm = ipName[normIp(ip)], k = routerIps.includes(ip) ? 'router' : nm ? nm.k : ip;
			return rows[k] || (rows[k] = { k, name: routerIps.includes(ip) ? 'Роутер' : nm ? nm.n : ip, ip, rd: 0, ru: 0, dd: 0, du: 0 });
		};
		if (dv.now - dv.ts <= 60) for (const [ ip, d, u ] of dv.rate) { const r = row(ip); r.rd += d; r.ru += u; }
		for (const [ ip, d, u ] of dv.day || []) { const r = row(ip); r.dd += d; r.du += u; }
		const list = Object.values(rows).filter(r => r.rd + r.ru + r.dd + r.du > 0)
			.sort((a, b) => (b.rd + b.ru) - (a.rd + a.ru) || (b.dd + b.du) - (a.dd + a.du)).slice(0, 5);
		if (!list.length) {
			body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Пока тихо'), E('span', {}, 'Сейчас нет заметного трафика от устройств.') ]));
			return;
		}
		const mx = Math.max(1, ...list.map(r => r.rd + r.ru));
		body.replaceChildren(...list.map(r => {
			const dn = fmtRate(r.rd), up = fmtRate(r.ru);
			const canName = r.k !== 'router' && /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(r.k);
			const custom = canName ? loadNames()[nameKey(r.k)] : '';
			const nbox = E('div', { class: 'nf-top-n' });
			const draw = () => {
				nbox.replaceChildren(E('b', { title: r.k }, custom || r.name), E('span', {}, (custom ? r.name + ' · ' : '') + (r.name === r.ip ? '' : r.ip)));
				if (canName) nbox.firstChild.appendChild(E('button', { type: 'button', class: 'nf-edit', title: 'Своё имя', 'aria-label': 'Переименовать «' + (custom || r.name) + '»',
					click: ev => { ev.stopPropagation(); editName(nbox, r.k, r.name, () => render(last)); } }));
			};
			draw();
			return E('div', { class: 'nf-top-r' }, [
				nbox,
				E('div', { class: 'nf-top-bar' }, E('i', { style: 'width:' + Math.max(2, Math.round((r.rd + r.ru) / mx * 100)) + '%' })),
				E('div', { class: 'nf-top-v' }, [ E('span', {}, '↓ ' + dn[0] + ' ' + dn[1]), E('span', {}, '↑ ' + up[0] + ' ' + up[1]) ]),
				E('div', { class: 'nf-top-d' }, [ 'за день ', E('b', {}, fmtBytes(r.dd + r.du)) ])
			]);
		}));
	}

	function load() {
		if (document.hidden || window.getComputedStyle(el).display === 'none') return;
		Promise.all([ fs.exec(HIST, [ 'devices' ]), names ? null : L.resolveDefault(callHints(), {}) ]).then(r => {
			if (r[1]) names = r[1];
			let dv = null;
			try { dv = JSON.parse(r[0].stdout); } catch (e) { /* no collector */ }
			render(dv);
		}).catch(() => render(null));
	}

	return { el, contains: n => el.contains(n), start() { load(); timer = window.setInterval(load, 8000); } };
}

/* ---------- traffic by application (YouTube, Telegram…) ---------- */

/* значки приложений: простые линейные символы по типу сервиса (не логотипы компаний) */
const APP_SHAPES = {
	play: [ [ 'rect', { x: 3, y: 5, width: 18, height: 14, rx: 4 } ], [ 'path', { d: 'M10 9.5v5l4.5-2.5z' } ] ],
	chat: [ [ 'path', { d: 'M4 5h16v11H9l-5 4z' } ] ],
	camera: [ [ 'rect', { x: 3, y: 3, width: 18, height: 18, rx: 5 } ], [ 'circle', { cx: 12, cy: 12, r: 4 } ], [ 'circle', { cx: 17.2, cy: 6.8, r: .6 } ] ],
	people: [ [ 'circle', { cx: 9, cy: 8, r: 3 } ], [ 'path', { d: 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6' } ], [ 'circle', { cx: 17, cy: 9, r: 2.4 } ], [ 'path', { d: 'M16 14.2c2.8.2 5 2.4 5 5.3' } ] ],
	music: [ [ 'path', { d: 'M9 18V6l10-2v12' } ], [ 'circle', { cx: 6.5, cy: 18, r: 2.5 } ], [ 'circle', { cx: 16.5, cy: 16, r: 2.5 } ] ],
	video: [ [ 'rect', { x: 3, y: 6, width: 12, height: 12, rx: 2 } ], [ 'path', { d: 'M15 10l6-3v10l-6-3' } ] ],
	game: [ [ 'rect', { x: 2, y: 8, width: 20, height: 9, rx: 4.5 } ], [ 'path', { d: 'M7 12.5h3M8.5 11v3' } ], [ 'circle', { cx: 15.5, cy: 12, r: .6 } ], [ 'circle', { cx: 17.5, cy: 13.5, r: .6 } ] ],
	search: [ [ 'circle', { cx: 11, cy: 11, r: 6.5 } ], [ 'path', { d: 'M16 16l5 5' } ] ],
	cloud: [ [ 'path', { d: 'M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 9.5 4.3 4.3 0 0 1 17.5 18z' } ] ],
	apps: [ [ 'rect', { x: 3, y: 3, width: 8, height: 8, rx: 2 } ], [ 'rect', { x: 13, y: 3, width: 8, height: 8, rx: 2 } ], [ 'rect', { x: 3, y: 13, width: 8, height: 8, rx: 2 } ], [ 'rect', { x: 13, y: 13, width: 8, height: 8, rx: 2 } ] ],
	globe: [ [ 'circle', { cx: 12, cy: 12, r: 9 } ], [ 'path', { d: 'M3 12h18M12 3c2.6 2.4 4 5.4 4 9s-1.4 6.6-4 9c-2.6-2.4-4-5.4-4-9s1.4-6.6 4-9z' } ] ]
};
const APP_GLYPH = { 'YouTube': 'play', 'Netflix': 'play', 'Twitch': 'play', 'Telegram': 'chat', 'WhatsApp': 'chat', 'Discord': 'chat', 'ВКонтакте': 'people', 'Facebook': 'people', 'X (Twitter)': 'chat',
	'Instagram': 'camera', 'TikTok': 'music', 'Spotify': 'music', 'Zoom': 'video', 'Steam': 'game', 'Яндекс': 'search', 'Google': 'search', 'Cloudflare': 'cloud', 'Amazon': 'cloud', 'Apple': 'apps', 'Microsoft': 'apps' };
function appGlyph(name) {
	const el = SVG('svg', { viewBox: '0 0 24 24', width: 18, height: 18, class: 'nf-ic', 'aria-hidden': 'true' }, (APP_SHAPES[APP_GLYPH[name] || 'globe']).map(sh => SVG(sh[0], sh[1])));
	return el;
}
const APP_COLORS = { 'YouTube': '#ff3b30', 'Telegram': '#2aabee', 'WhatsApp': '#25d366', 'Instagram': '#e1306c', 'Facebook': '#1877f2', 'TikTok': '#25c8c8',
	'Netflix': '#e50914', 'Twitch': '#9146ff', 'Spotify': '#1db954', 'Discord': '#5865f2', 'Zoom': '#2d8cff', 'Steam': '#66c0f4', 'ВКонтакте': '#0077ff',
	'Яндекс': '#fc3f1d', 'Google': '#4285f4', 'Apple': '#a2aaad', 'Microsoft': '#00a4ef', 'Amazon': '#ff9900', 'X (Twitter)': '#8899a6', 'Cloudflare': '#f38020' };
const PERIODS = [ [ 'day', 'Сегодня', 1 ], [ 'week', '7 дней', 7 ], [ 'month', '30 дней', 30 ] ];

function ymd(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }

/* суммы по приложениям за период: today — строки «ip, приложение, вниз, вверх», hist — то же с датой первой колонкой.
   «Прочее · домен» сворачивается в «Прочее», а домены уходят в подробности (other). */
function sumApps(data, days, ip) {
	const tot = {}, other = {};
	const add = (a, d, u) => {
		const m = /^Прочее(?: · (.+))?$/.exec(a);
		if (m) {
			const t = other[m[1] || ''] || (other[m[1] || ''] = [ 0, 0 ]);
			t[0] += d; t[1] += u;
			a = 'Прочее';
		}
		const t = tot[a] || (tot[a] = [ 0, 0 ]);
		t[0] += d; t[1] += u;
	};
	for (const [ i, a, d, u ] of data.day || []) if (!ip || i === ip) add(a, d, u);
	if (days > 1) {
		const t = String(data.today || '');
		const base = /^\d{8}$/.test(t) ? new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8)) : new Date();
		base.setDate(base.getDate() - (days - 1));
		const from = ymd(base);
		for (const [ dt, i, a, d, u ] of data.hist || []) if (+dt >= from && (!ip || i === ip)) add(a, d, u);
	}
	return { tot, other };
}

function appsCard() {
	const body = E('div', { class: 'nf-apps-b' }, E('div', { class: 'nf-empty' }, 'Собираю данные…'));
	const el = xcard('nf-apps', 'Трафик по приложениям', body);
	let names = null, timer = null, data = null, period = 'day', dev = '', busy = false;

	const run = cmd => fs.exec(APPSBIN, [ cmd ]).then(r => { try { return JSON.parse(r.stdout); } catch (e) { return null; } });

	function label(ip) {
		for (const mac in names || {}) {
			const n = names[mac];
			if ((n.ipaddrs || []).concat(n.ip6addrs || []).some(x => normIp(x) === normIp(ip)))
				return loadNames()[nameKey(mac)] || n.name || ip;
		}
		return ip;
	}

	function toggle(cmd, ask) {
		if (busy || (ask && !window.confirm(ask))) return;
		busy = true;
		body.replaceChildren(E('div', { class: 'nf-empty' }, cmd === 'enable' ? 'Включаю…' : 'Выключаю…'));
		run(cmd).then(r => {
			busy = false;
			if (!r || !r.ok) { body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Не получилось'), E('span', {}, (r && r.error) || 'Нет ответа от роутера. Выйдите и войдите снова (права обновляются при входе).') ])); return; }
			window.setTimeout(load, cmd === 'enable' ? 2500 : 500);
		}).catch(() => { busy = false; load(); });
	}

	function render() {
		if (EDITING || busy) return;
		if (!data || typeof data.enabled === 'undefined') {
			body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Нет данных'), E('span', {}, 'Сборщик статистики не запущен или не обновлён до версии с учётом приложений.') ]));
			return;
		}
		if (!data.enabled) {
			body.replaceChildren(E('div', { class: 'nf-apps-off' }, [
				E('b', {}, 'Сколько трафика у YouTube, Telegram и других'),
				E('span', {}, 'Роутер сопоставит адреса соединений с именами сайтов из DNS-запросов и покажет, кто сколько скачал. Для этого будет включён журнал DNS в dnsmasq: он пишется в память роутера (не на диск) и обрезается до 1 МБ. Выключить можно здесь же.'),
				E('button', { type: 'button', class: 'cbi-button cbi-button-action', click: () => toggle('enable', 'Включить учёт трафика по приложениям?\n\nБудет включён журнал DNS в dnsmasq (в памяти роутера) и dnsmasq перезапустится на пару секунд.') }, 'Включить учёт')
			]));
			return;
		}
		const p = PERIODS.find(x => x[0] === period) || PERIODS[0];
		const ips = {};
		for (const r of (data.day || [])) ips[r[0]] = 1;
		for (const r of (data.hist || [])) ips[r[1]] = 1;
		const sel = E('select', { class: 'nf-apps-dev', 'aria-label': 'Устройство', change: ev => { dev = ev.target.value; render(); } },
			[ E('option', { value: '' }, 'Все устройства') ].concat(Object.keys(ips).sort().map(ip => E('option', { value: ip }, label(ip) + (label(ip) === ip ? '' : ' · ' + ip)))));
		sel.value = dev && ips[dev] ? dev : '';
		if (sel.value !== dev) dev = sel.value;
		const seg = E('div', { class: 'nf-apps-seg', role: 'group', 'aria-label': 'Период' }, PERIODS.map(x =>
			E('button', { type: 'button', 'aria-pressed': String(x[0] === period), click: () => { period = x[0]; render(); } }, x[1])));

		const { tot, other } = sumApps(data, p[2], dev);
		const rows = Object.keys(tot).map(a => ({ a, d: tot[a][0], u: tot[a][1], t: tot[a][0] + tot[a][1] })).filter(r => r.t > 0).sort((x, y) => (x.a === 'Прочее') - (y.a === 'Прочее') || y.t - x.t);
		const sum = rows.reduce((n, r) => n + r.t, 0);
		const list = rows.slice(0, 9);
		const content = [];
		if (!list.length) {
			content.push(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Пока пусто'), E('span', {}, data.dnsmap > 0 ? 'Данных за этот период ещё нет.' : 'Журнал DNS пока пуст. Подождите несколько минут, пока устройства сделают запросы. Если ничего не появляется, проверьте, что устройства используют DNS роутера (а не DoH/DoT в браузере или телефоне).') ]));
		}
		else {
			const mx = Math.max(1, ...list.map(r => r.t));
			list.forEach(r => {
				content.push(E('div', { class: 'nf-apps-r', style: '--c:' + (APP_COLORS[r.a] || 'var(--nf-text-dim)') }, [
					E('div', { class: 'nf-apps-n' }, [ r.a === 'Прочее' ? E('i') : appGlyph(r.a), E('b', {}, r.a) ]),
					E('div', { class: 'nf-top-bar' }, E('i', { style: 'width:' + Math.max(2, Math.round(r.t / mx * 100)) + '%' })),
					E('div', { class: 'nf-apps-v' }, [ E('b', {}, fmtBytes(r.t)), E('span', {}, '↓ ' + fmtBytes(r.d) + ' · ↑ ' + fmtBytes(r.u)) ]),
					E('div', { class: 'nf-apps-p' }, sum ? nf0.format(r.t / sum * 100) + '%' : '')
				]));
				/* из чего состоит «Прочее»: самые тяжёлые домены (по ним можно добавить правило в /etc/nightfall-apps.list) */
				if (r.a === 'Прочее') {
					const top = Object.keys(other).map(k => ({ k: k || 'прямые адреса без имени', t: other[k][0] + other[k][1] })).filter(x => x.t > 0).sort((x, y) => y.t - x.t).slice(0, 6);
					if (top.length) content.push(E('div', { class: 'nf-apps-sub' }, [ E('span', {}, 'Крупнее всего:') ].concat(top.map(x => E('span', { class: 'nf-apps-chip', title: x.k }, [ x.k + ' ', E('b', {}, fmtBytes(x.t)) ])))));
				}
			});
		}
		body.replaceChildren(E('div', { class: 'nf-apps-bar' }, [ seg, sel ]), ...content,
			E('div', { class: 'nf-apps-f' }, [
				E('span', {}, 'Всего ' + fmtBytes(sum) + '. Данные приблизительные: трафик через VPN и шифрованный DNS определить нельзя.'),
				E('button', { type: 'button', class: 'nf-link', click: () => toggle('disable', 'Выключить учёт трафика по приложениям?\n\nЖурнал DNS в dnsmasq будет возвращён к прежним настройкам.') }, 'Выключить учёт')
			]));
	}

	function load() {
		if (idle(el) || busy || EDITING) return;
		Promise.all([ fs.exec(HIST, [ 'apps' ]), names ? null : L.resolveDefault(callHints(), {}) ]).then(r => {
			if (r[1]) names = r[1];
			try { data = JSON.parse(r[0].stdout); } catch (e) { data = null; }
			render();
		}).catch(() => { data = null; render(); });
	}

	return { el, contains: n => el.contains(n), start() { load(); timer = window.setInterval(load, 15000); } };
}

/* ---------- «Доступ в интернет»: отключение устройств вручную и по расписанию ---------- */

const BLOCKBIN = '/usr/libexec/nightfall-block';

function blockCard() {
	const body = E('div', { class: 'nf-blk-b' }, E('div', { class: 'nf-empty' }, 'Собираю данные…'));
	const el = xcard('nf-block', 'Доступ в интернет', body);
	let timer = null, devs = null, busy = false, open = null, note = '', logOn = false, logRows = null;

	const run = args => fs.exec(BLOCKBIN, args).then(r => { try { return JSON.parse(r.stdout); } catch (e) { return null; } });

	function act(args, okNote) {
		if (busy) return;
		busy = true;
		run(args).then(r => {
			busy = false;
			note = r && r.ok ? okNote : ((r && r.error) || 'Нет ответа от роутера. Выйдите и войдите в LuCI снова (права обновляются при входе).');
			open = r && r.ok ? null : open;
			load(true);
		}).catch(() => { busy = false; note = 'Не получилось выполнить команду.'; load(true); });
	}

	function sched(d) {
		const from = E('input', { type: 'time', value: d.from || '23:00', 'aria-label': 'Отключать с' });
		const to = E('input', { type: 'time', value: d.to || '07:00', 'aria-label': 'Включать в' });
		return E('div', { class: 'nf-blk-sched' }, [
			E('span', {}, 'Отключать каждый день с'), from, E('span', {}, 'до'), to,
			E('button', { type: 'button', class: 'cbi-button cbi-button-action', click: () => act([ 'sched', d.mac, from.value, to.value, d.name || '' ], 'Расписание сохранено.') }, 'Сохранить'),
			d.from ? E('button', { type: 'button', class: 'cbi-button', click: () => act([ 'sched', d.mac, 'off' ], 'Расписание убрано.') }, 'Убрать') : ''
		]);
	}

	function quotaRow(d) {
		const gb = E('input', { type: 'number', min: '0.1', step: '0.1', value: d.quota ? String(Math.round(d.quota / 102.4) / 10) : '', placeholder: 'ГБ', 'aria-label': 'Лимит в сутки, ГБ' });
		return E('div', { class: 'nf-blk-sched' }, [
			E('span', {}, 'Лимит трафика в сутки'), gb, E('span', {}, 'ГБ'),
			E('button', { type: 'button', class: 'cbi-button cbi-button-action', click: () => {
				const v = parseFloat(String(gb.value).replace(',', '.'));
				if (!(v > 0)) { note = 'Введите лимит в гигабайтах, например 5.'; render(); return; }
				act([ 'quota', d.mac, String(Math.round(v * 1024)), d.name || '' ], 'Лимит задан: интернет отключится до конца суток, когда устройство скачает ' + v + ' ГБ.');
			} }, 'Задать'),
			d.quota ? E('button', { type: 'button', class: 'cbi-button', click: () => act([ 'quota', d.mac, 'off' ], 'Лимит убран.') }, 'Убрать') : ''
		]);
	}

	function render() {
		if (EDITING || busy) return;
		if (!devs) {
			body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Нет данных'), E('span', {}, 'Не удалось получить список устройств. Если вы только что обновили тему, выйдите и войдите в LuCI снова.') ]));
			return;
		}
		const rows = devs.slice().sort((a, b) => ((b.active ? 1 : 0) - (a.active ? 1 : 0)) || ((b.from || b.quota ? 1 : 0) - (a.from || a.quota ? 1 : 0)) || (b.online - a.online) || (a.name || a.ip || a.mac).localeCompare(b.name || b.ip || b.mac)).slice(0, 30);
		const list = rows.map(d => {
			const nm = d.name || d.ip || d.mac;
			const q = d.quota ? ' · 📉 ' + fmtBytes(d.used) + ' из ' + fmtBytes(d.quota * 1048576) : '';
			const st = d.active ? E('span', { class: 'nf-blk-st bad' }, (d.reason === 'quota' ? 'лимит исчерпан' : d.reason === 'sched' ? 'по расписанию' : 'отключено') + q)
				: E('span', { class: 'nf-blk-st ' + (d.online && !d.from && !d.quota ? 'ok' : '') }, (d.from ? '⏰ ' + d.from + '–' + d.to + (d.snoozed ? ' (пропуск до завтра)' : '') + ' · ' : '') + (d.online ? 'в сети' : 'не в сети') + q);
			const line = E('div', { class: 'nf-blk-r' + (d.active ? ' off' : '') }, [
				E('div', { class: 'nf-blk-n' }, [ E('b', {}, nm), E('span', {}, (d.ip ? d.ip + ' · ' : '') + d.mac) ]),
				st,
				E('div', { class: 'nf-blk-a' }, [
					E('button', { type: 'button', class: 'cbi-button ' + (d.active ? 'cbi-button-action' : 'cbi-button-remove'),
						click: () => act([ d.active ? 'unblock' : 'block', d.mac, nm ], d.active ? nm + ': интернет возвращён.' : nm + ': интернет отключён.') }, d.active ? 'Вернуть' : 'Отключить'),
					E('button', { type: 'button', class: 'cbi-button', 'aria-expanded': String(open === d.mac), click: () => { open = open === d.mac ? null : d.mac; render(); } }, '⏰')
				])
			]);
			return open === d.mac ? E('div', { class: 'nf-blk-g' }, [ line, sched(d), quotaRow(d) ]) : line;
		});
		body.replaceChildren(
			note ? E('div', { class: 'nf-blk-note' }, note) : '',
			...(list.length ? list : [ E('div', { class: 'nf-empty' }, 'Устройств не видно.') ]),
			logOn ? E('div', { class: 'nf-blk-log' }, (logRows && logRows.length ? logRows.map(r => E('div', {}, [ E('span', {}, new Date(r[0] * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })), E('b', {}, r[2] || r[1]), E('span', { class: r[3] === 'on' ? 'bad' : 'ok' }, r[3] === 'on' ? 'отключён' : 'возвращён'), E('i', {}, r[4]) ])) : [ E('div', { class: 'nf-empty' }, 'Записей пока нет.') ])) : '',
			E('div', { class: 'nf-apps-f' }, [ E('span', {}, 'Устройству отключается выход в интернет (по MAC-адресу). Роутер и локальная сеть остаются доступными, поэтому вернуть доступ можно всегда. Устройства со «случайным» Wi-Fi адресом лучше отключить в настройках самого телефона. То же можно делать кнопками в Telegram-боте.'),
				E('button', { type: 'button', class: 'nf-link', click: () => { logOn = !logOn; if (logOn) run([ 'log' ]).then(r => { logRows = r && r.ok ? r.log : []; render(); }); else render(); } }, logOn ? 'Скрыть журнал' : 'Журнал блокировок') ]));
	}

	function load(force) {
		if (!force && (idle(el) || busy || EDITING || open)) return;
		run([ 'list' ]).then(r => { devs = r && r.ok ? r.devices : null; render(); }).catch(() => { devs = null; render(); });
	}

	return { el, contains: n => el.contains(n), start() { load(true); timer = window.setInterval(load, 20000); } };
}

/* ---------- extra cards ---------- */

function xcard(cls, title, body) {
	return E('div', { class: 'cbi-section nf-xcard ' + cls + ' fade-in' }, [ E('div', { class: 'cbi-title' }, E('h3', {}, title)), body ]);
}

function idle(el) { return document.hidden || window.getComputedStyle(el).display === 'none'; }

function healthCard() {
	const C = 2 * Math.PI * 38;
	const ARC = 'M46 8a38 38 0 1 1 0 76a38 38 0 1 1 0-76';
	const fg = SVG('path', { class: 'fg', d: ARC, 'stroke-dasharray': C.toFixed(1), 'stroke-dashoffset': C.toFixed(1) });
	const num = E('b', {}, '–'), head = E('strong', {}, 'Собираю данные…'), chips = E('div', { class: 'nf-chips' });
	const ring = E('div', { class: 'nf-ring' }, [ SVG('svg', { viewBox: '0 0 92 92' }, [ SVG('path', { class: 'bg', d: ARC }), fg ]), num ]);
	const el = xcard('nf-health', 'Состояние роутера', E('div', { class: 'nf-health-b' }, [ ring, E('div', { class: 'nf-health-t' }, [ head, chips ]) ]));
	let timer = null;

	function render() {
		const s = SHARED;
		if (s.t == null || idle(el)) return;
		let score = 100;
		const f = [];
		const add = (pen, lvl, text) => { score -= pen; f.push([ lvl, text ]); };

		if (s.online === false) add(50, 'bad', 'Нет интернета');
		else if (s.online === true) f.push([ 'ok', 'Интернет работает' ]);
		if (s.ping != null && s.ping >= 0) {
			if (s.ping > 150) add(15, 'bad', 'Высокий пинг ' + nf0.format(s.ping) + ' мс');
			else if (s.ping > 80) add(6, 'warn', 'Пинг ' + nf0.format(s.ping) + ' мс');
		}
		if (s.loss != null && s.loss > 2) add(s.loss > 10 ? 20 : 10, s.loss > 10 ? 'bad' : 'warn', 'Потери ' + nf0.format(s.loss) + '%');
		if (s.cpu != null) {
			if (s.cpu > 90) add(20, 'bad', 'Процессор ' + nf0.format(s.cpu) + '%');
			else if (s.cpu > 70) add(8, 'warn', 'Процессор ' + nf0.format(s.cpu) + '%');
		}
		if (s.mem != null) {
			if (s.mem > 90) add(20, 'bad', 'Память ' + nf0.format(s.mem) + '%');
			else if (s.mem > 80) add(8, 'warn', 'Память ' + nf0.format(s.mem) + '%');
		}
		if (s.temp != null) {
			if (s.temp > 80) add(25, 'bad', 'Жарко ' + nf0.format(s.temp) + ' °C');
			else if (s.temp > 70) add(12, 'warn', 'Тепло ' + nf0.format(s.temp) + ' °C');
			else if (s.temp > 60) add(4, 'warn', 'Температура ' + nf0.format(s.temp) + ' °C');
		}
		score = Math.max(0, Math.min(100, Math.round(score)));
		const bad = f.filter(x => x[0] !== 'ok');
		if (!bad.length) f.push([ 'ok', 'Нагрузка в норме' ]);

		num.textContent = String(score);
		fg.setAttribute('stroke-dashoffset', (C * (1 - score / 100)).toFixed(1));
		ring.style.setProperty('--c', score >= 85 ? 'var(--nf-g-up, #2ea043)' : score >= 65 ? '#e8a317' : 'var(--nf-g-bad, #e5484d)');
		head.textContent = score >= 85 ? 'Всё хорошо' : score >= 65 ? 'Есть замечания' : score >= 40 ? 'Нужно внимание' : 'Проблемы';
		chips.replaceChildren(...f.slice(0, 6).map(x => E('span', { class: 'nf-chip ' + x[0] }, x[1])));
	}

	return { el, contains: n => el.contains(n), start() { render(); timer = window.setInterval(render, 3000); } };
}

function wifiCard() {
	const body = E('div', { class: 'nf-wifi-b' }, E('div', { class: 'nf-empty' }, 'Ищу подключённые устройства…'));
	const el = xcard('nf-wifi', 'Wi‑Fi сейчас', body);
	let names = null, timer = null;
	const BAND = { '2g': '2,4 ГГц', '5g': '5 ГГц', '6g': '6 ГГц', '60g': '60 ГГц' };

	const open = new Set();
	let lastList = null;
	const dur = s => { s = +s || 0; const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? d + ' д ' + h + ' ч' : h ? h + ' ч ' + m + ' мин' : m + ' мин'; };

	function render(list) {
		if (EDITING) return;
		lastList = list;
		if (!list.length) {
			body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Никого нет'), E('span', {}, 'К Wi‑Fi сейчас не подключено ни одно устройство.') ]));
			return;
		}
		list.sort((a, b) => b.signal - a.signal);
		body.replaceChildren(...list.map(s => {
			const lv = signalLevel(s.signal), n = lv[0] === 'ok' ? (s.signal >= -60 ? 4 : 3) : lv[0] === 'warn' ? 2 : 1;
			const mac = nameKey(s.mac), hint = names && names[mac] || {};
			const auto = hint.name || s.mac, custom = loadNames()[mac] || '', shown = custom || auto;
			const rx = s.rx && s.rx.rate ? nf0.format(s.rx.rate / 1000) : '–', tx = s.tx && s.tx.rate ? nf0.format(s.tx.rate / 1000) : '–';
			const isOpen = open.has(mac);
			const title = E('b', { title: s.mac }, shown);
			const row = E('div', { class: 'nf-sta', role: 'button', tabindex: '0', 'aria-expanded': String(isOpen) }, [
				E('div', { class: 'nf-av' }, shown.charAt(0)),
				title,
				E('div', { class: 'nf-sig', 'data-l': lv[0] }, [
					E('i', {}, [ 1, 2, 3, 4 ].map(k => E('s', { class: k <= n ? 'on' : '', style: 'height:' + (4 + k * 3) + 'px' }))),
					E('span', {}, nf0.format(s.signal) + ' дБм') ]),
				E('small', {}, [ s.ssid, s.band, '↓' + rx + ' ↑' + tx + ' Мбит/с' ].filter(Boolean).join(' · '))
			]);
			const kv = (k, v) => v == null || v === '' ? null : E('div', {}, [ E('span', {}, k), E('b', {}, v) ]);
			const snr = s.noise != null && s.noise < 0 ? s.signal - s.noise : null;
			const det = E('div', { class: 'nf-sta-d' }, [
				kv('MAC', s.mac), kv('IP', ((hint.ipaddrs || [])[0]) || ((hint.ip6addrs || [])[0])), kv('Сеть', [ s.ssid, s.band ].filter(Boolean).join(' · ')),
				kv('Сигнал', nf0.format(s.signal) + ' дБм · ' + lv[1]), kv('Шум', s.noise != null && s.noise < 0 ? nf0.format(s.noise) + ' дБм' : ''), kv('Запас сигнала', snr != null ? nf0.format(snr) + ' дБ' : ''),
				kv('Скорость ↓', s.rx && s.rx.rate ? nf0.format(s.rx.rate / 1000) + ' Мбит/с' + (s.rx.mhz ? ' · ' + s.rx.mhz + ' МГц' : '') : ''),
				kv('Скорость ↑', s.tx && s.tx.rate ? nf0.format(s.tx.rate / 1000) + ' Мбит/с' + (s.tx.mhz ? ' · ' + s.tx.mhz + ' МГц' : '') : ''),
				kv('Подключён', s.connected_time ? dur(s.connected_time) : ''), kv('Был тих', s.inactive != null ? nf0.format(s.inactive) + ' мс' : ''),
				kv('Пакетов ↓/↑', s.rx && s.tx && s.rx.packets != null ? nf0.format(s.rx.packets) + ' / ' + nf0.format(s.tx.packets) : ''),
				kv('Режим', [ s.he ? 'Wi‑Fi 6' : s.vht ? 'Wi‑Fi 5' : s.ht ? 'Wi‑Fi 4' : '' ].filter(Boolean).join(''))
			].filter(Boolean));
			const rn = E('button', { type: 'button', class: 'nf-qa nf-rn', click: ev => {
				ev.stopPropagation();
				editName(title.parentNode.querySelector('b'), mac, auto, () => render(lastList));
			} }, custom ? 'Изменить имя' : 'Дать имя');
			det.appendChild(E('div', { class: 'nf-sta-a' }, rn));
			const toggle = () => { if (open.has(mac)) open.delete(mac); else open.add(mac); render(lastList); };
			row.addEventListener('click', toggle);
			row.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } });
			return E('div', { class: 'nf-sta-w' + (isOpen ? ' open' : '') }, isOpen ? [ row, det ] : [ row ]);
		}));
	}

	function load() {
		if (idle(el)) return;
		Promise.all([ callWireless().then(v => v || {}, () => null), names ? null : L.resolveDefault(callHints(), {}) ]).then(r => {
			if (r[0] === null) { body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Нет доступа к данным Wi‑Fi'), E('span', {}, 'После обновления темы выйдите из LuCI и войдите заново, затем выполните: /etc/init.d/rpcd restart') ])); return; }
			if (r[1]) names = Object.keys(r[1]).reduce((o, k) => { o[k.toUpperCase()] = r[1][k]; return o; }, {});
			const ifs = [];
			for (const radio in r[0] || {}) {
				const rc = r[0][radio] || {};
				for (const i of rc.interfaces || []) {
					const cfg = i.config || {};
					if (i.ifname && (cfg.mode || 'ap') === 'ap')
						ifs.push({ dev: i.ifname, ssid: cfg.ssid || '', band: BAND[(rc.config || {}).band] || '' });
				}
			}
			const next = ifs.length ? Promise.resolve(ifs) : L.resolveDefault(callIwDevs(), []).then(d => (d || []).map(dev => ({ dev, ssid: '', band: '' })));
			return next.then(list => {
			if (!list.length) { body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Wi‑Fi не найден'), E('span', {}, 'Беспроводные интерфейсы не настроены или выключены.') ])); return; }
			return Promise.all(list.map(i => Promise.all([ L.resolveDefault(callAssoc(i.dev), []), (i.ssid && i.band) ? null : L.resolveDefault(callIwInfo(i.dev), null) ]).then(r => {
					const inf = r[1] || {}, f = +inf.frequency || 0;
					const band = i.band || (f ? (f < 3000 ? BAND['2g'] : f < 5925 ? BAND['5g'] : BAND['6g']) : '');
					return (r[0] || []).map(s => Object.assign({}, s, { ssid: i.ssid || inf.ssid || '', band }));
				}))).then(l => render([].concat(...l)));
			});
		}).catch(() => {});
	}

	return { el, contains: n => el.contains(n), start() { load(); timer = window.setInterval(load, 8000); } };
}

function eventsCard() {
	const body = E('div', { class: 'nf-ev-b' }, E('div', { class: 'nf-empty' }, 'Читаю журнал…'));
	const el = xcard('nf-events', 'Лента событий', body);
	let timer = null;
	const LV = { ok: 'ok', info: 'info', warn: 'warn', warning: 'warn', crit: 'bad', critical: 'bad', bad: 'bad', error: 'bad', err: 'bad' };
	const two = v => String(v).padStart(2, '0');
	function when(ts) {
		const d = new Date(ts * 1000), n = new Date();
		const hm = two(d.getHours()) + ':' + two(d.getMinutes());
		return d.toDateString() === n.toDateString() ? hm : two(d.getDate()) + '.' + two(d.getMonth() + 1) + ' ' + hm;
	}

	function load() {
		if (idle(el)) return;
		fs.exec(HIST, [ 'series', 'fine' ]).then(res => {
			let h = null;
			try { h = JSON.parse(res.stdout); } catch (e) { /* no collector */ }
			if (!h || !Array.isArray(h.events)) {
				body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Нет данных'), E('span', {}, 'Сбор истории не запущен.') ]));
				return;
			}
			const raw = h.events.slice().reverse(), list = [];
			for (const e of raw) {   /* identical neighbours collapse into one row with a counter */
				const last = list[list.length - 1];
				if (last && last[2] === e[2]) last[3]++; else list.push([ e[0], e[1], e[2], 1 ]);
				if (list.length >= 8 && !(last && last[2] === e[2])) break;
			}
			if (!list.length) { body.replaceChildren(E('div', { class: 'nf-empty' }, [ E('b', {}, 'Всё спокойно'), E('span', {}, 'Событий пока не было.') ])); return; }
			body.replaceChildren(...list.map(e => E('div', { class: 'nf-ev', 'data-l': LV[String(e[1]).toLowerCase()] || 'info' }, [ E('div', {}, e[3] > 1 ? e[2] + ' ×' + e[3] : e[2]), E('span', {}, when(e[0])) ])));
		}).catch(() => {});
	}

	return { el, contains: n => el.contains(n), start() { load(); timer = window.setInterval(load, 15000); } };
}

function quickCard() {
	const note = E('div', { class: 'nf-qnote' });
	const body = E('div', { class: 'nf-quick-b' });
	const el = xcard('nf-quick', 'Быстрые действия', body);

	function action(label, confirmText, run) {
		let timer = null;
		const b = E('button', { type: 'button', class: 'nf-qa' }, label);
		b.addEventListener('click', () => {
			if (!b.classList.contains('arm')) {
				b.classList.add('arm'); b.textContent = confirmText;
				timer = window.setTimeout(() => { b.classList.remove('arm'); b.textContent = label; }, 4000);
				return;
			}
			window.clearTimeout(timer);
			b.classList.remove('arm'); b.textContent = label; b.disabled = true;
			Promise.resolve(run()).catch(() => { note.textContent = 'Не получилось выполнить действие (нет прав?).'; }).then(() => { b.disabled = false; });
		});
		return b;
	}

	function waitBack() {
		let was = false;
		const t = window.setInterval(() => {
			fetch(window.location.pathname, { cache: 'no-store' }).then(r => { if (r.ok && was) { window.clearInterval(t); window.location.reload(); } }).catch(() => { was = true; });
		}, 3000);
	}

	body.append(
		action('Перезапустить Wi‑Fi', 'Нажмите ещё раз', () => {
			note.textContent = 'Перезапускаю Wi‑Fi… устройства переподключатся сами.';
			return fs.exec('/sbin/wifi', [ 'reload' ]).then(r => { note.textContent = r.code === 0 ? 'Wi‑Fi перезапущен.' : 'Команда вернула ошибку ' + r.code; });
		}),
		action('Перезагрузить роутер', 'Точно перезагрузить?', () => {
			note.textContent = 'Роутер перезагружается… страница обновится сама, когда он вернётся.';
			return callReboot().then(waitBack);
		}),
		note);

	return { el, contains: n => el.contains(n), start() {} };
}

/* ---------- init ---------- */

return baseclass.extend({
	__init__() {
		const path = (L.env.dispatchpath || []).join('/');
		if (path !== 'admin/status/overview') return;

		const view = document.getElementById('view');
		if (!view) return;

		let strip = null, extras = [], ready = false, timer = null;
		const relayout = gridLayout(view);

		const run = () => {
			timer = null;
			if (DRAG || !cardsOf(view).length) return;

			if (!ready) {
				ready = true;
				strip = liveStrip();
				strip.resetBtn.addEventListener('click', () => { saveOrder(null); sortCards(view, null); });
				sortCards(view, loadOrder());
				view.insertBefore(strip.el, cardsOf(view)[0]);
				strip.start();
				extras = [ healthCard(), wifiCard(), eventsCard(), quickCard(), topCard(), appsCard(), blockCard() ];
				extras.forEach(x => { view.appendChild(x.el); x.start(); });
			}
			else {
				sortCards(view, loadOrder());
				const first = cardsOf(view)[0];
				if (first && strip.el.nextSibling !== first && strip.el.parentNode === view)
					view.insertBefore(strip.el, first);
			}

			decorateCards(view);
			syncPins(view);
			syncSizes(view);
			markNoWrap(view); decorateHosts(view);
			enhanceBadges(view);
			relayout();
		};

		const schedule = muts => {
			if (timer || (muts && muts.every(m => (strip && strip.el.contains(m.target)) || extras.some(x => x.contains(m.target)) || (m.target === view && DRAG)))) return;
			timer = window.setTimeout(run, 250);
		};
		new MutationObserver(muts => {
			const own = muts.every(m => (strip && strip.el.contains(m.target)) || extras.some(x => x.contains(m.target)) || (m.target === view && DRAG));
			if (!own) { enhanceBadges(view); markNoWrap(view); decorateHosts(view); stabilizeTables(view); }
			schedule(muts);
		}).observe(view, { childList: true, subtree: true, characterData: true });
		/* значки сигнала и Wi-Fi в таблицах догружаются уже после вставки строк: учитываем их размер сразу, не ждать следующего опроса */
		view.addEventListener('load', ev => { if (ev.target && ev.target.tagName === 'IMG') stabilizeTables(view); }, true);
		schedule();
	}
});
