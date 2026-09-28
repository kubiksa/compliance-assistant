/*
 * compliance-catalog front end
 *
 * Reads window.COMPLIANCE_DATA (embedded at build time) and renders a
 * hash-routed, fully static catalog. No network requests, no storage.
 *
 * Routes
 *   #/                     home
 *   #/topics               topic tiles
 *   #/topic/<id>           one topic
 *   #/regulations          regulation library
 *   #/reg/<id>[/<obl>]     one regulation, optionally with a requirement expanded
 *   #/crosswalk            shared controls across regulations
 *   #/documents            document index
 *   #/doc/<id>             one document and everything it supports
 *   #/timeline             key dates
 *   #/reviews              items past their review date
 *   #/glossary             plain-language definitions
 *   #/search/<query>       search results
 */
(function () {
  'use strict';

  var D = window.COMPLIANCE_DATA;
  if (!D) {
    document.getElementById('app').textContent = 'No catalog data was embedded. Rebuild with build.js.';
    return;
  }
  var C = D.catalog || {};

  // ------------------------------------------------------------------
  // Indexes
  // ------------------------------------------------------------------
  function byId(list) {
    var m = {};
    (list || []).forEach(function (x) { m[x.id] = x; });
    return m;
  }
  var REG = byId(D.regulations);
  var DOC = byId(D.documents);
  var TOPIC = byId(D.topics);
  var CTRL = byId(D.controls);
  var OBL = byId(D.obligations);
  var ROLE = byId(D.roles);
  var LAYERS = C.layers || [];
  var LAYER = byId(LAYERS);
  var MAP = {};
  (D.mappings || []).forEach(function (m) { MAP[m.obligation_id] = m; });

  var STATUS_KEYS = ['addressed', 'partially_addressed', 'not_addressed', 'not_assessed'];
  var LABEL = {
    addressed: 'Addressed in documentation',
    partially_addressed: 'Partially addressed',
    not_addressed: 'Not addressed',
    not_assessed: 'Not yet assessed'
  };
  Object.keys(C.status_labels || {}).forEach(function (k) { LABEL[k] = C.status_labels[k]; });

  var SOURCE_TYPE_LABEL = { mandate: 'Mandate', guidance: 'Guidance', standard: 'Standard', market: 'Market-based' };
  var OBLIGATION_VERB = {
    compliant_with: 'Must comply with',
    certified_to: 'Certified or attested to',
    aligned_with: 'Aligned with',
    implements: 'Implements',
    supports_client: 'Context: supports client obligations'
  };

  var oblsByReg = {};
  var oblsByCtrl = {};
  var oblsByTopic = {};
  var oblsByDoc = {};
  D.obligations.forEach(function (o) {
    (oblsByReg[o.regulation_id] = oblsByReg[o.regulation_id] || []).push(o);
    if (o.common_control) (oblsByCtrl[o.common_control] = oblsByCtrl[o.common_control] || []).push(o);
    oblTopics(o).forEach(function (t) { (oblsByTopic[t] = oblsByTopic[t] || []).push(o); });
    var m = MAP[o.id];
    if (m) (m.documents || []).forEach(function (e) {
      (oblsByDoc[e.document_id] = oblsByDoc[e.document_id] || []).push(o);
    });
  });

  function oblTopics(o) {
    var t = (o.topics || []).slice();
    if (o.common_control && CTRL[o.common_control] && t.indexOf(CTRL[o.common_control].topic) < 0) {
      t.unshift(CTRL[o.common_control].topic);
    }
    return t;
  }
  function status(o) { return (MAP[o.id] && MAP[o.id].status) || 'not_assessed'; }
  function isContext(r) { return r.obligation_type === 'supports_client' || r.coverage === 'context'; }

  // ------------------------------------------------------------------
  // Dates and review cadence
  // ------------------------------------------------------------------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function parseDate(s) {
    if (!s) return null;
    var p = String(s).split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  var TODAY = (function () { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); })();
  function fmtDate(s) {
    var d = parseDate(s);
    return d ? MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() : '';
  }
  function daysUntil(s) {
    var d = parseDate(s);
    return d ? Math.round((d - TODAY) / 86400000) : null;
  }
  function keyDateText(k) { return k.date_text || fmtDate(k.date) || 'Date not set'; }
  function isFutureDate(k) { return k.date ? daysUntil(k.date) >= 0 : !!k.pending; }
  function nextDate(r) {
    var f = (r.key_dates || []).filter(isFutureDate);
    f.sort(function (a, b) { return (a.date || '9999') < (b.date || '9999') ? -1 : 1; });
    return f[0] || null;
  }
  function lastDateText(r) {
    var past = (r.key_dates || []).filter(function (k) { return k.date && !isFutureDate(k); });
    past.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
    return past[0] ? past[0].label + ': ' + keyDateText(past[0]) : '';
  }
  function interval(item) { return item.review_interval_days || C.review_interval_days || 365; }
  function isOverdue(item) {
    if (!item || !item.last_reviewed) return false;
    return -daysUntil(item.last_reviewed) > interval(item);
  }

  // ------------------------------------------------------------------
  // State (in memory only)
  // ------------------------------------------------------------------
  var state = {
    applies: {},          // applicability id -> true
    facets: {},           // field -> { value: true }
    groupBy: 'category',
    docLayer: 'all'
  };
  function appliesSelected() { return Object.keys(state.applies).filter(function (k) { return state.applies[k]; }); }
  function regApplies(r) {
    var sel = appliesSelected();
    if (!sel.length) return true;
    if (r.applies_if === 'always') return true;
    if (!Array.isArray(r.applies_if)) return false;
    return r.applies_if.some(function (a) { return sel.indexOf(a) >= 0; });
  }
  function applicableRegs() { return D.regulations.filter(regApplies); }

  // ------------------------------------------------------------------
  // Facets
  // ------------------------------------------------------------------
  function facetDefs() {
    var defs = [{ field: 'source_type', label: 'Type', values: SOURCE_TYPE_LABEL }];
    (C.facets || []).forEach(function (f) { defs.push(f); });
    defs.push({ field: '_timing', label: 'Timing', values: { upcoming: 'Upcoming date', in_force: 'In force now' } });
    var sv = {};
    STATUS_KEYS.forEach(function (k) { sv[k] = LABEL[k]; });
    defs.push({ field: '_status', label: 'Has requirements that are', values: sv });
    return defs;
  }
  function regValues(r, field) {
    if (field === '_timing') return nextDate(r) ? ['upcoming'] : ['in_force'];
    if (field === '_status') {
      if (isContext(r)) return [];
      var s = {};
      (oblsByReg[r.id] || []).forEach(function (o) { s[status(o)] = true; });
      if ((r.total_obligations || 0) > (oblsByReg[r.id] || []).length) s.not_assessed = true;
      if (!(oblsByReg[r.id] || []).length) s.not_assessed = true;
      return Object.keys(s);
    }
    var v = r[field];
    if (v == null) return [];
    return Array.isArray(v) ? v : [v];
  }
  function passesFacets(r, skipField) {
    return Object.keys(state.facets).every(function (field) {
      if (field === skipField) return true;
      var sel = Object.keys(state.facets[field]).filter(function (k) { return state.facets[field][k]; });
      if (!sel.length) return true;
      var vals = regValues(r, field);
      return sel.some(function (s) { return vals.indexOf(s) >= 0; });
    });
  }
  function filteredRegs() { return applicableRegs().filter(function (r) { return passesFacets(r); }); }
  function facetLabel(field, value) {
    var f = facetDefs().filter(function (d) { return d.field === field; })[0];
    return (f && f.values[value]) || value;
  }

  // ------------------------------------------------------------------
  // Coverage
  // ------------------------------------------------------------------
  function coverage(list, extraUnlisted) {
    var c = { addressed: 0, partially_addressed: 0, not_addressed: 0, not_assessed: 0, total: 0 };
    list.forEach(function (o) { c[status(o)]++; c.total++; });
    if (extraUnlisted > 0) { c.not_assessed += extraUnlisted; c.total += extraUnlisted; }
    return c;
  }
  function regCoverage(r) {
    var listed = oblsByReg[r.id] || [];
    return coverage(listed, Math.max(0, (r.total_obligations || 0) - listed.length));
  }

  // ------------------------------------------------------------------
  // DOM helpers
  // ------------------------------------------------------------------
  function el(tag, attrs) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style') node.setAttribute('style', v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child == null || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); return; }
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  function svg(path, color, size) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('width', size || 20); s.setAttribute('height', size || 20);
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none');
    s.setAttribute('stroke', color || 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    path.split('|').forEach(function (d) {
      var p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); s.appendChild(p);
    });
    return s;
  }
  var ICON = {
    check: 'M20 6 9 17l-5-5',
    dash: 'M5 12h14',
    info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z|M12 16v-5|M12 8h.01',
    warn: 'M12 9v4|M12 17h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    download: 'M12 3v12|m7 10 5 5 5-5|M5 21h14'
  };
  function link(route, text, cls) { return el('a', { href: '#/' + route, class: cls }, text); }
  function regLink(r) { return link('reg/' + enc(r.id), r.name); }
  function enc(s) { return encodeURIComponent(s); }
  function pill(st) { return el('span', { class: 'pill st-' + st }, LABEL[st] || st); }
  function roleName(id) { return id && ROLE[id] ? ROLE[id].name : null; }

  function bar(c, large) {
    var b = el('div', { class: 'bar' + (large ? ' bar-lg' : ''), role: 'img', 'aria-label': coverageText(c) });
    if (c.total) ['addressed', 'partially_addressed', 'not_addressed'].forEach(function (k) {
      if (c[k]) b.appendChild(el('span', { class: 'b-' + k, style: 'width:' + Math.max(1.5, 100 * c[k] / c.total) + '%' }));
    });
    return b;
  }
  function coverageText(c) {
    if (!c.total) return 'No requirements listed yet';
    var assessed = c.total - c.not_assessed;
    return c.addressed + ' of ' + c.total + ' addressed' + (assessed < c.total ? ', ' + c.not_assessed + ' not yet assessed' : '');
  }

  function docLink(d) {
    var inner = [el('span', { class: 'doc-id' }, d.id), el('span', { class: 'doc-title' }, d.title + (d.revision ? ', ' + d.revision : ''))];
    var wrap = el('div', { class: 'stack-sm', style: 'gap:2px' });
    if (d.url) {
      wrap.appendChild(el('a', { class: 'doc-link', href: d.url, title: 'Open in the document system' }, inner));
    } else {
      wrap.appendChild(el('div', { class: 'doc-link' }, el('span', { class: 'mono', style: 'font-size:13px' }, d.id), el('span', { class: 'doc-title' }, d.title)));
    }
    var meta = el('div', { class: 'row', style: 'gap:6px' });
    if (d.restricted) meta.appendChild(el('span', { class: 'tag tag-restricted' }, 'Restricted access'));
    if (!d.url && d.status_note) meta.appendChild(el('span', { class: 'sub muted', style: 'font-size:13px' }, d.status_note));
    if (meta.childNodes.length) wrap.appendChild(meta);
    return wrap;
  }

  // Glossary terms become <abbr> hints in plain-language text.
  var TERMS = [];
  (D.glossary || []).forEach(function (g) {
    [g.term].concat(g.aliases || []).forEach(function (t) { TERMS.push({ text: t, def: g.definition, term: g.term }); });
  });
  TERMS.sort(function (a, b) { return b.text.length - a.text.length; });
  var TERM_RE = TERMS.length ? new RegExp('\\b(' + TERMS.map(function (t) {
    return t.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('|') + ')\\b', 'g') : null;
  function plain(text) {
    if (!text) return null;
    text = String(text).trim();
    if (!TERM_RE) return text;
    var frag = document.createDocumentFragment();
    var used = {};
    var last = 0;
    text.replace(TERM_RE, function (match, _g, offset) {
      var t = TERMS.filter(function (x) { return x.text === match; })[0];
      if (!t || used[t.term]) return match;
      used[t.term] = true;
      frag.appendChild(document.createTextNode(text.slice(last, offset)));
      frag.appendChild(el('abbr', { class: 'term', title: t.def }, match));
      last = offset + match.length;
      return match;
    });
    frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  // ------------------------------------------------------------------
  // CSV export
  // ------------------------------------------------------------------
  function csvCell(v) {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function downloadCsv(filename, header, rows) {
    var text = [header].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var a = el('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function csvButton(label, fn) {
    return el('button', { type: 'button', class: 'btn btn-small', onClick: fn }, svg(ICON.download, null, 16), label);
  }
  function requirementRows(regs) {
    var rows = [];
    regs.forEach(function (r) {
      if (isContext(r)) return;
      (oblsByReg[r.id] || []).forEach(function (o) {
        var m = MAP[o.id] || {};
        rows.push([
          r.id, r.name, o.control_id, o.title,
          o.common_control && CTRL[o.common_control] ? CTRL[o.common_control].name : '',
          oblTopics(o).map(function (t) { return TOPIC[t] ? TOPIC[t].name : t; }).join('; '),
          LABEL[status(o)],
          (m.documents || []).map(function (e) { return e.document_id; }).join('; '),
          m.rationale || '', m.last_reviewed || '', isOverdue(m) ? 'Yes' : ''
        ]);
      });
    });
    return rows;
  }
  var REQ_HEADER = ['Regulation ID', 'Regulation', 'Requirement ID', 'Requirement', 'Shared control', 'Topics',
    'Documentation status', 'Documents', 'Rationale', 'Last reviewed', 'Review overdue'];
  function fileStamp() { return (C.as_of || new Date().toISOString().slice(0, 10)); }

  // ------------------------------------------------------------------
  // Chrome
  // ------------------------------------------------------------------
  var NAV = [
    ['', 'Home'], ['topics', 'Topics'], ['regulations', 'Regulations'], ['crosswalk', 'Shared controls'],
    ['documents', 'Documents'], ['timeline', 'Timeline'], ['glossary', 'Glossary']
  ];
  function header(route) {
    var nav = el('nav', { class: 'nav', 'aria-label': 'Main' });
    NAV.forEach(function (n) {
      var current = n[0] === route || (n[0] === 'topics' && route === 'topic') || (n[0] === 'regulations' && route === 'reg') ||
        (n[0] === 'documents' && route === 'doc');
      nav.appendChild(el('a', { href: '#/' + n[0], 'aria-current': current ? 'page' : null }, n[1]));
    });
    return [
      el('header', { class: 'topbar' }, el('div', { class: 'topbar-inner' },
        el('a', { class: 'brand', href: '#/' },
          el('span', { class: 'brand-title' }, C.title || 'Compliance Catalog'),
          C.organization ? el('span', { class: 'brand-org' }, C.organization) : null),
        nav)),
      el('div', { class: 'notice' }, el('div', { class: 'notice-inner' },
        svg(ICON.info, '#1B3A5C'),
        el('div', { style: 'flex:1 1 480px' }, C.scope_notice || 'This catalog shows whether each requirement is addressed in documentation.'),
        C.sample_notice ? el('span', { class: 'sample-flag' }, C.sample_notice) : null,
        el('span', { class: 'notice-meta' }, C.as_of ? 'Status as of ' + fmtDate(C.as_of) : '')))
    ];
  }
  function footer() {
    var bm = D.build_metadata || {};
    return el('footer', { class: 'footer' }, el('div', { class: 'footer-inner' },
      el('div', null, C.footer_note || 'Static snapshot. Links open the authoritative documents in their source system.'),
      el('div', null, 'Built ' + (bm.built_at ? fmtDate(bm.built_at.slice(0, 10)) : '') +
        (C.version ? ', version ' + C.version : '') + ', compliance-catalog ' + (bm.tool_version || ''))));
  }
  function crumbs(parts) {
    var n = el('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' });
    parts.forEach(function (p, i) {
      if (i) n.appendChild(el('span', { 'aria-hidden': 'true' }, '/'));
      n.appendChild(p[1] != null ? link(p[1], p[0]) : el('span', { style: 'color:#1B2430;font-weight:500' }, p[0]));
    });
    return n;
  }
  function filterNote() {
    var sel = appliesSelected();
    if (!sel.length) return null;
    var names = sel.map(function (id) {
      var a = (C.applicability || []).filter(function (x) { return x.id === id; })[0];
      return a ? (a.short || a.label) : id;
    });
    return el('div', { class: 'row muted', style: 'font-size:15px' },
      'Showing regulations that match: ' + names.join('; ') + '.',
      el('button', { type: 'button', class: 'linkbtn', onClick: function () { state.applies = {}; render(true); } }, 'Show everything'),
      link('', 'Change selections'));
  }

  // ------------------------------------------------------------------
  // Shared sections
  // ------------------------------------------------------------------
  function applicabilityPanel() {
    var list = C.applicability || [];
    if (!list.length) return null;
    var grid = el('div', { class: 'applies' });
    list.forEach(function (a) {
      var id = 'ap-' + a.id;
      var box = el('input', { type: 'checkbox', id: id, checked: state.applies[a.id] ? true : null,
        onChange: function (e) { state.applies[a.id] = e.target.checked; render(true); } });
      grid.appendChild(el('label', { class: 'check', for: id }, box,
        el('span', null, el('span', { class: 'check-label' }, a.label), a.help ? el('span', { class: 'check-help' }, a.help) : null)));
    });
    var n = applicableRegs().length;
    return el('section', { class: 'panel stack', 'aria-labelledby': 'ap-h' },
      el('div', { class: 'spread' },
        el('h2', { id: 'ap-h' }, C.applicability_prompt || 'Check everything that applies to you'),
        el('div', { class: 'row' },
          el('span', { class: 'muted' }, appliesSelected().length ? n + ' of ' + D.regulations.length + ' regulations apply' :
            'Nothing checked, so all ' + D.regulations.length + ' regulations are shown'),
          appliesSelected().length ? el('button', { type: 'button', class: 'linkbtn', onClick: function () { state.applies = {}; render(true); } }, 'Clear') : null)),
      grid);
  }

  function upcomingPanel() {
    var items = [];
    applicableRegs().forEach(function (r) {
      (r.key_dates || []).forEach(function (k) { if (isFutureDate(k)) items.push({ r: r, k: k }); });
    });
    items.sort(function (a, b) { return (a.k.date || '9999') < (b.k.date || '9999') ? -1 : 1; });
    if (!items.length) return null;
    var grid = el('div', { class: 'grid-3' });
    items.slice(0, 3).forEach(function (it) {
      var d = it.k.date ? daysUntil(it.k.date) : null;
      grid.appendChild(el('a', { class: 'panel panel-tight date-card', href: '#/reg/' + enc(it.r.id), style: 'text-decoration:none;color:inherit' },
        el('div', { class: 'spread' },
          el('span', { class: 'kicker' }, it.r.name),
          d != null ? el('span', { class: 'tag ' + (d <= 120 ? 'tag-soon' : 'tag-quiet') }, d === 0 ? 'Today' : d + ' days') :
            el('span', { class: 'tag tag-quiet' }, 'Date not set')),
        el('div', { style: 'font-size:18px;font-weight:600' }, it.k.label),
        el('div', { class: 'when' }, keyDateText(it.k)),
        it.k.detail ? el('div', { class: 'muted', style: 'font-size:15px' }, it.k.detail) : null));
    });
    return el('section', { class: 'stack' },
      el('div', { class: 'spread' }, el('h2', { style: 'font-size:20px;font-weight:600' }, 'Coming up'), link('timeline', 'See all dates')),
      grid);
  }

  function reviewBanner() {
    var m = D.mappings.filter(isOverdue).length;
    var d = D.documents.filter(isOverdue).length;
    if (!m && !d) return null;
    var parts = [];
    if (m) parts.push(m + ' requirement mapping' + (m > 1 ? 's' : ''));
    if (d) parts.push(d + ' document' + (d > 1 ? 's' : ''));
    return el('div', { class: 'callout' }, svg(ICON.warn, '#7A3500', 22),
      el('div', null, el('strong', null, parts.join(' and ') + ' past their review date. '), link('reviews', 'See what needs review')));
  }

  function topicTiles() {
    var grid = el('div', { class: 'tiles' });
    D.topics.forEach(function (t) {
      var n = (oblsByTopic[t.id] || []).filter(function (o) { return regApplies(REG[o.regulation_id]); }).length;
      grid.appendChild(el('a', { class: 'tile' + (n ? '' : ' tile-empty'), href: '#/topic/' + enc(t.id) },
        el('span', { class: 'tile-name' }, t.name),
        el('span', { class: 'tile-blurb' }, t.blurb || ''),
        el('span', { class: 'tile-count' }, n ? n + ' requirement' + (n > 1 ? 's' : '') :
          ((oblsByTopic[t.id] || []).length ? 'None for your selections' : 'No requirements mapped yet'))));
    });
    return grid;
  }

  function facetPanel() {
    var wrap = el('div', { class: 'panel facets' });
    var base = applicableRegs();
    facetDefs().forEach(function (f) {
      var chips = el('div', { class: 'chips' });
      Object.keys(f.values).forEach(function (v) {
        var on = !!(state.facets[f.field] && state.facets[f.field][v]);
        var count = base.filter(function (r) { return passesFacets(r, f.field) && regValues(r, f.field).indexOf(v) >= 0; }).length;
        chips.appendChild(el('button', {
          type: 'button', class: 'chip', 'aria-pressed': on ? 'true' : 'false', disabled: !on && !count ? true : null,
          onClick: function () {
            state.facets[f.field] = state.facets[f.field] || {};
            state.facets[f.field][v] = !on;
            render(true);
          }
        }, f.values[v] + ' (' + count + ')'));
      });
      wrap.appendChild(el('div', { class: 'facet' }, el('div', { class: 'facet-label' }, f.label), chips));
    });
    var any = Object.keys(state.facets).some(function (k) { return Object.keys(state.facets[k]).some(function (v) { return state.facets[k][v]; }); });
    if (any) wrap.appendChild(el('div', null, el('button', { type: 'button', class: 'linkbtn', onClick: function () { state.facets = {}; render(true); } }, 'Clear filters')));
    return wrap;
  }

  function regTable(regs) {
    var tableFacets = (C.facets || []).filter(function (f) { return f.in_table; });
    var head = el('tr', null, el('th', null, 'Regulation'), el('th', null, 'Type'),
      tableFacets.map(function (f) { return el('th', null, f.label); }),
      el('th', null, 'Key date'), el('th', null, 'Documentation coverage'));
    var tbody = el('tbody');
    var groups = groupRegs(regs);
    groups.forEach(function (g) {
      if (g.label) tbody.appendChild(el('tr', { class: 'group' }, el('td', { colspan: 4 + tableFacets.length }, g.label)));
      g.items.forEach(function (r) {
        var nd = nextDate(r);
        var c = regCoverage(r);
        tbody.appendChild(el('tr', { class: 'clickable', onClick: function (e) { if (e.target.tagName !== 'A') go('reg/' + enc(r.id)); } },
          el('td', null, el('a', { href: '#/reg/' + enc(r.id), style: 'font-weight:600' }, r.name),
            el('span', { class: 'sub' }, r.id + (r.full_title && r.full_title !== r.name ? ', ' + r.full_title : ''))),
          el('td', null, SOURCE_TYPE_LABEL[r.source_type] || r.source_type),
          tableFacets.map(function (f) { return el('td', null, regValues(r, f.field).map(function (v) { return f.values[v] || v; }).join(', ')); }),
          el('td', { style: nd ? 'color:#9A4A00;font-weight:600' : null },
            nd ? nd.label + ': ' + keyDateText(nd) : (r.date_display || lastDateText(r))),
          el('td', null, isContext(r) ? el('span', { class: 'pill st-context' }, 'Context only') :
            el('div', { class: 'stack-sm', style: 'gap:6px' }, bar(c), el('span', { style: 'font-size:13px' }, coverageText(c))))));
      });
    });
    if (!regs.length) tbody.appendChild(el('tr', null, el('td', { colspan: 4 + tableFacets.length, class: 'empty' },
      'No regulations match these selections. Clear a filter or uncheck an applicability box to see more.')));
    return el('div', { class: 'table-wrap' }, el('table', null, el('caption', { class: 'visually-hidden' }, 'Regulations'), el('thead', null, head), tbody));
  }
  function groupRegs(regs) {
    if (state.groupBy === 'date') {
      var sorted = regs.slice().sort(function (a, b) {
        var x = nextDate(a), y = nextDate(b);
        var xa = x ? (x.date || '9998') : '9999', ya = y ? (y.date || '9998') : '9999';
        return xa < ya ? -1 : xa > ya ? 1 : a.name.localeCompare(b.name);
      });
      return [{ label: null, items: sorted }];
    }
    if (state.groupBy === 'id') return [{ label: null, items: regs.slice().sort(function (a, b) { return a.id.localeCompare(b.id); }) }];
    var field = C.group_field || 'category';
    var order = [];
    var map = {};
    var defs = (C.facets || []).filter(function (f) { return f.field === field; })[0];
    var keys = defs ? Object.keys(defs.values) : [];
    regs.forEach(function (r) {
      var v = regValues(r, field)[0] || 'other';
      if (!map[v]) { map[v] = []; order.push(v); }
      map[v].push(r);
    });
    order.sort(function (a, b) { return (keys.indexOf(a) < 0 ? 99 : keys.indexOf(a)) - (keys.indexOf(b) < 0 ? 99 : keys.indexOf(b)); });
    return order.map(function (v) { return { label: defs ? defs.values[v] || v : v, items: map[v] }; });
  }

  function librarySection(showIntro) {
    var regs = filteredRegs();
    var seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Group by' });
    [['category', 'Category'], ['date', 'Key date'], ['id', 'ID']].forEach(function (g) {
      seg.appendChild(el('button', { type: 'button', 'aria-pressed': state.groupBy === g[0] ? 'true' : 'false',
        onClick: function () { state.groupBy = g[0]; render(true); } }, g[1]));
    });
    return el('section', { class: 'stack', style: 'gap:20px', 'aria-labelledby': 'lib-h' },
      showIntro ? el('div', { class: 'stack-sm' },
        el('h2', { id: 'lib-h', class: 'section-title' }, 'Or look up a regulation'),
        el('p', { class: 'section-intro' }, 'Narrow the list with any combination of filters. Counts update as you choose.')) :
        el('h2', { id: 'lib-h', class: 'visually-hidden' }, 'Regulation library'),
      facetPanel(),
      el('div', { class: 'spread', style: 'align-items:center' },
        el('div', null, el('strong', null, regs.length + ' regulation' + (regs.length === 1 ? '' : 's')), el('span', { class: 'muted' }, ' shown')),
        el('div', { class: 'row' }, el('span', { class: 'muted', style: 'font-size:14px' }, 'Group by'), seg,
          csvButton('Regulations CSV', function () {
            downloadCsv('regulations-' + fileStamp() + '.csv',
              ['ID', 'Regulation', 'Full title', 'Type', 'Relationship', 'Next date', 'Addressed', 'Partial', 'Not addressed', 'Not yet assessed', 'Total'],
              regs.map(function (r) {
                var c = regCoverage(r); var nd = nextDate(r);
                return [r.id, r.name, r.full_title || '', SOURCE_TYPE_LABEL[r.source_type] || '', OBLIGATION_VERB[r.obligation_type] || '',
                  nd ? nd.label + ' ' + keyDateText(nd) : '', c.addressed, c.partially_addressed, c.not_addressed, c.not_assessed, c.total];
              }));
          }),
          csvButton('Requirements CSV', function () {
            downloadCsv('requirements-' + fileStamp() + '.csv', REQ_HEADER, requirementRows(regs));
          }))),
      regTable(regs),
      legend());
  }
  function legend() {
    return el('div', { class: 'legend' },
      el('span', null, el('span', { class: 'swatch', style: 'background:#1B3A5C' }), LABEL.addressed),
      el('span', null, el('span', { class: 'swatch', style: 'background:#D98B2B' }), LABEL.partially_addressed),
      el('span', null, el('span', { class: 'swatch', style: 'background:#8E1B1B' }), LABEL.not_addressed),
      el('span', null, el('span', { class: 'swatch', style: 'background:#E3E1DA;border:1px solid #A9A69C' }), LABEL.not_assessed));
  }

  // ------------------------------------------------------------------
  // Pages
  // ------------------------------------------------------------------
  function pageHome() {
    var q = el('input', { type: 'search', id: 'q', placeholder: C.search_placeholder || 'Try "access", "breach", or a document ID' });
    var form = el('form', { class: 'search', role: 'search', onSubmit: function (e) {
      e.preventDefault(); if (q.value.trim()) go('search/' + enc(q.value.trim()));
    } }, el('label', { for: 'q', class: 'visually-hidden' }, 'Search'), q, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Search'));
    return [
      el('section', { class: 'stack', style: 'gap:18px' },
        el('h1', { class: 'page-title' }, C.home_heading || 'Find the requirements that apply to your work'),
        el('p', { class: 'lede' }, C.home_intro || 'Start from a plain-language topic or a regulation you already know. Every requirement links to the documents that address it.'),
        form),
      applicabilityPanel(),
      reviewBanner(),
      upcomingPanel(),
      el('section', { class: 'stack', style: 'gap:20px' },
        el('div', { class: 'stack-sm' },
          el('h2', { class: 'section-title' }, 'Start with what you are working on'),
          el('p', { class: 'section-intro' }, 'Each topic lists every requirement on that subject, across all regulations, in plain language first.')),
        topicTiles()),
      librarySection(true)
    ];
  }

  function pageTopics() {
    return [
      el('section', { class: 'stack' }, el('h1', { class: 'page-title' }, 'Topics'),
        el('p', { class: 'lede' }, 'Plain-language subjects. Each one gathers the related requirements from every regulation.')),
      filterNote(), topicTiles()
    ];
  }

  function pageRegulations() {
    return [
      el('section', { class: 'stack' }, el('h1', { class: 'page-title' }, 'Regulations'),
        el('p', { class: 'lede' }, 'Every regulation, standard, and framework in the catalog, with its type, key dates, and documentation coverage.')),
      applicabilityPanel(),
      librarySection(false)
    ];
  }

  function requirementTable(obls, opts) {
    opts = opts || {};
    var tbody = el('tbody');
    obls.forEach(function (o) {
      var r = REG[o.regulation_id];
      var m = MAP[o.id] || {};
      var docsCell = el('td', null);
      var ds = (m.documents || []).map(function (e) { return DOC[e.document_id]; }).filter(Boolean);
      if (ds.length) docsCell.appendChild(el('div', { class: 'docs-list' }, ds.map(docLink)));
      else docsCell.appendChild(el('span', { class: 'muted', style: 'font-size:14px' }, 'None mapped yet'));
      tbody.appendChild(el('tr', null,
        el('td', { style: 'width:220px' },
          el('a', { href: '#/reg/' + enc(r.id) + '/' + enc(o.id), style: 'font-weight:600' }, r.name),
          r.condition ? el('span', { class: 'tag', style: 'margin-top:6px' }, r.condition) : null),
        el('td', null, el('div', { class: 'stack-sm' },
          el('div', null, el('span', { class: 'mono', style: 'font-size:14px' }, o.control_id), ' ', el('strong', null, o.title)),
          wording(o),
          (m.mapped_against_version || o.version) ? el('div', { class: 'version-note' }, 'Assessed against ' + (m.mapped_against_version || o.version)) : null)),
        el('td', { style: 'width:220px' }, el('div', { class: 'stack-sm' }, pill(status(o)),
          m.rationale ? el('span', { style: 'font-size:13px;color:#333C48' }, m.rationale) : null,
          isOverdue(m) ? el('span', { class: 'overdue' }, 'Review overdue') : null)),
        docsCell));
    });
    return el('table', null,
      el('thead', null, el('tr', null, el('th', null, 'Regulation'), el('th', null, 'Requirement and wording'),
        el('th', null, 'Documentation status'), el('th', null, opts.docsHeader || 'Addressed in'))),
      tbody);
  }
  function wording(o) {
    if (!o.text) return null;
    var official = o.official_wording !== false;
    return el('div', { class: 'stack-sm', style: 'gap:4px' },
      el('div', { class: 'wording' }, o.text.trim()),
      official ? null : el('div', { class: 'wording-note' },
        o.wording_note || (REG[o.regulation_id] && REG[o.regulation_id].wording_note) || C.summary_note || 'Summary, not the official wording.'));
  }

  function pageTopic(id) {
    var t = TOPIC[id];
    if (!t) return notFound('topic');
    var all = (oblsByTopic[id] || []);
    var obls = all.filter(function (o) { return regApplies(REG[o.regulation_id]); });
    var hidden = all.length - obls.length;
    var c = coverage(obls, 0);
    var regsHere = {};
    obls.forEach(function (o) { regsHere[o.regulation_id] = true; });

    var cards = [];
    D.controls.filter(function (cc) { return cc.topic === id; }).forEach(function (cc) {
      var list = (oblsByCtrl[cc.id] || []).filter(function (o) { return regApplies(REG[o.regulation_id]); });
      if (list.length) cards.push(reqCard(cc.name, cc.summary, list));
    });
    obls.filter(function (o) { return !o.common_control || CTRL[o.common_control].topic !== id; }).forEach(function (o) {
      cards.push(reqCard(o.plain_title || o.title, o.plain_summary, [o]));
    });

    var side = el('aside', { class: 'stack' },
      el('div', { class: 'panel stack' },
        el('h2', { style: 'font-size:16px' }, 'Where this topic stands'),
        bar(c, true),
        el('div', { class: 'stack-sm', style: 'font-size:15px' }, STATUS_KEYS.map(function (k) {
          return el('div', { class: 'spread' }, el('span', null, LABEL[k]), el('strong', null, c[k]));
        })),
        el('div', { class: 'muted', style: 'font-size:13px' }, c.total + ' requirements from ' + Object.keys(regsHere).length + ' regulations')),
      (t.related || []).length ? el('div', { class: 'panel stack-sm' }, el('h2', { style: 'font-size:16px;margin-bottom:4px' }, 'Related topics'),
        t.related.map(function (r) { return link('topic/' + enc(r), TOPIC[r].name); })) : null);

    return [
      crumbs([['Home', ''], ['Topics', 'topics'], [t.name]]),
      el('div', { class: 'split' },
        el('section', { class: 'stack', style: 'gap:22px' },
          el('h1', { class: 'page-title' }, t.name),
          t.summary ? el('p', { class: 'lede' }, plain(t.summary)) : null,
          (t.applies_to_you || []).length ? el('div', { class: 'panel stack' },
            el('h2', { style: 'font-size:18px' }, 'This applies to you if you are'),
            el('ul', { class: 'checklist' }, t.applies_to_you.map(function (s) {
              return el('li', null, svg(ICON.check, '#1B3A5C'), el('span', null, s));
            }))) : null,
          filterNote()),
        side),
      el('section', { class: 'stack', style: 'gap:22px' },
        el('div', { class: 'stack-sm' }, el('h2', { class: 'section-title' }, 'What is required'),
          el('p', { class: 'section-intro' }, 'Each requirement is described in plain terms first. Underneath are the regulations that require it, their wording, and where the documentation addresses it.')),
        cards.length ? cards : el('div', { class: 'panel empty' }, hidden ?
          'None of the regulations you checked on the home page have requirements on this topic.' :
          'No requirements have been mapped to this topic yet.'),
        hidden && cards.length ? el('p', { class: 'muted' }, hidden + ' more requirement' + (hidden > 1 ? 's' : '') + ' on this topic belong to regulations outside your selections.') : null)
    ];
  }
  function reqCard(title, summary, obls) {
    var regs = {};
    obls.forEach(function (o) { regs[o.regulation_id] = true; });
    var n = Object.keys(regs).length;
    return el('article', { class: 'req' },
      el('div', { class: 'req-head' },
        el('div', null, el('h3', null, title), summary ? el('p', null, plain(summary)) : null),
        el('div', { class: 'muted', style: 'white-space:nowrap;font-size:14px' }, 'Required by ' + n + ' regulation' + (n > 1 ? 's' : ''))),
      el('div', { style: 'overflow-x:auto' }, requirementTable(obls)));
  }

  function pageReg(id, openObl) {
    var r = REG[id];
    if (!r) return notFound('regulation');
    var obls = oblsByReg[id] || [];
    var c = regCoverage(r);
    var nd = nextDate(r);
    var ctx = isContext(r);

    var tags = el('div', { class: 'row', style: 'gap:8px' },
      el('span', { class: 'mono', style: 'font-weight:500;color:#333C48;margin-right:4px' }, r.id),
      el('span', { class: 'tag' }, SOURCE_TYPE_LABEL[r.source_type]),
      el('span', { class: 'tag' }, OBLIGATION_VERB[r.obligation_type]),
      (C.facets || []).map(function (f) {
        return regValues(r, f.field).map(function (v) { return el('span', { class: 'tag tag-quiet' }, f.values[v] || v); });
      }),
      nd ? el('span', { class: 'tag tag-soon' }, 'Upcoming: ' + keyDateText(nd)) : null);

    var regDoc = r.reg_document ? DOC[r.reg_document] : null;
    var buttons = el('div', { class: 'row' },
      regDoc && regDoc.url ? el('a', { class: 'btn btn-primary', href: regDoc.url }, 'Open ' + regDoc.id + ' ' + (C.reg_doc_label || 'reference file')) : null,
      r.source_url ? el('a', { class: 'btn', href: r.source_url, target: '_blank', rel: 'noopener' }, 'Official source') : null,
      (r.key_dates || []).length ? link('timeline', 'See on timeline', 'btn') : null);

    var applyBox = el('section', { class: 'panel stack' }, el('h2', null, 'Does this apply to my work?'),
      (r.applies_when || []).length ? el('div', { class: 'stack-sm' }, el('div', { class: 'kicker', style: 'color:#1B3A5C' }, 'Applies when'),
        el('ul', { class: 'checklist' }, r.applies_when.map(function (s) { return el('li', null, svg(ICON.check, '#1B3A5C'), el('span', null, plain(s))); }))) : null,
      (r.does_not_apply || []).length ? el('div', { class: 'stack-sm' }, el('div', { class: 'kicker' }, 'Does not apply, or applies differently'),
        el('ul', { class: 'checklist' }, r.does_not_apply.map(function (s) { return el('li', { class: 'muted' }, svg(ICON.dash, '#545C68'), el('span', null, plain(s))); }))) : null,
      roleName(r.accountable_role) ? el('div', { class: 'muted', style: 'font-size:14px;border-top:1px solid #E7E8E3;padding-top:12px' },
        'Not sure? Ask the ' + roleName(r.accountable_role) + ' before the work starts.') : null);

    var datesBox = (r.key_dates || []).length ? el('section', { class: 'panel stack' }, el('h2', null, 'Key dates'), timelineList(r.key_dates.map(function (k) { return { k: k }; }), false)) : null;

    var out = [
      crumbs([['Home', ''], ['Regulations', 'regulations'], [r.name]]),
      el('section', { class: 'stack', style: 'gap:16px' }, tags,
        el('h1', { class: 'page-title' }, r.name),
        r.full_title && r.full_title !== r.name ? el('div', { class: 'muted', style: 'font-size:17px;margin-top:-6px' }, r.full_title) : null,
        r.summary ? el('p', { class: 'lede' }, plain(r.summary)) : null,
        buttons),
      el('div', { class: datesBox ? 'grid-2' : '' }, applyBox, datesBox)
    ];
    if (r.version_note) out.push(el('div', { class: 'callout' }, svg(ICON.warn, '#7A3500', 22),
      el('div', null, el('strong', null, 'Version assessed: ' + (r.version_tracked || '')), el('div', null, plain(r.version_note)))));

    if (ctx) {
      out.push(el('div', { class: 'panel stack-sm' }, el('h2', null, 'Why this is listed'),
        el('p', null, plain(r.context_note || 'This is listed for context. Documentation coverage is not tracked against it.'))));
      return out;
    }

    out.push(el('section', { class: 'stack' },
      el('div', { class: 'spread' }, el('h2', { class: 'section-title' }, 'Documentation coverage'),
        el('div', { class: 'muted', style: 'font-size:14px' },
          r.last_reviewed ? 'Last reviewed ' + fmtDate(r.last_reviewed) + (roleName(r.accountable_role) ? ' by the ' + roleName(r.accountable_role) : '') : 'No review date recorded',
          isOverdue(r) ? el('span', { class: 'overdue' }, ', review overdue') : null)),
      el('div', { class: 'stats' },
        el('div', { class: 'stat' }, el('div', { class: 'stat-num' }, c.total), el('div', { class: 'stat-label' }, 'Requirements in scope')),
        STATUS_KEYS.map(function (k) {
          return el('div', { class: 'stat k-' + k }, el('div', { class: 'stat-num' }, c[k]), el('div', { class: 'stat-label' }, LABEL[k]));
        }))));

    var tbody = el('tbody');
    var families = [];
    var fam = {};
    obls.forEach(function (o) {
      var f = o.family || 'Requirements';
      if (!fam[f]) { fam[f] = []; families.push(f); }
      fam[f].push(o);
    });
    families.forEach(function (f) {
      if (families.length > 1 || f !== 'Requirements') tbody.appendChild(el('tr', { class: 'group' }, el('td', { colspan: 4 }, f + ' (' + fam[f].length + ')')));
      fam[f].forEach(function (o) {
        var m = MAP[o.id] || {};
        var open = openObl === o.id;
        var toggle = function () { go('reg/' + enc(r.id) + (open ? '' : '/' + enc(o.id)), true); };
        var ds = (m.documents || []).map(function (e) { return e.document_id; });
        tbody.appendChild(el('tr', { class: 'clickable' + (open ? ' selected' : ''), onClick: function (e) { if (e.target.tagName !== 'A' && e.target.tagName !== 'BUTTON') toggle(); } },
          el('td', { class: 'mono', style: 'font-size:14px;white-space:nowrap' }, o.control_id),
          el('td', null, el('button', { type: 'button', class: 'linkbtn', 'aria-expanded': open ? 'true' : 'false', onClick: toggle, style: 'text-align:left;font-weight:600;text-decoration:none;color:#1B2430' }, o.title)),
          el('td', null, el('div', { class: 'stack-sm' }, pill(status(o)), isOverdue(m) ? el('span', { class: 'overdue' }, 'Review overdue') : null)),
          el('td', { style: 'font-size:14px' }, ds.length ? ds.join(', ') : el('span', { class: 'muted' }, 'None mapped yet'))));
        if (open) tbody.appendChild(el('tr', null, el('td', { colspan: 4, style: 'background:#F7F9FB;padding:16px' }, detailPanel(o))));
      });
    });
    var more = (r.total_obligations || 0) - obls.length;
    if (more > 0) tbody.appendChild(el('tr', null, el('td', { colspan: 4, class: 'muted' },
      more + ' more requirement' + (more > 1 ? 's are' : ' is') + ' in scope but not yet added to the catalog. They count as not yet assessed.')));
    if (!obls.length && more <= 0) tbody.appendChild(el('tr', null, el('td', { colspan: 4, class: 'empty' }, 'No requirements have been added for this regulation yet.')));

    out.push(el('section', { class: 'stack' },
      el('div', { class: 'spread', style: 'align-items:center' }, el('h2', { style: 'font-size:22px;font-weight:600' }, 'Requirements'),
        csvButton('Requirements CSV', function () { downloadCsv(r.id + '-requirements-' + fileStamp() + '.csv', REQ_HEADER, requirementRows([r])); })),
      el('p', { class: 'muted' }, 'Select a requirement to see its wording, the documents at each layer, and the other regulations it overlaps with.'),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, el('th', null, 'ID'), el('th', null, 'Requirement'), el('th', null, 'Documentation status'), el('th', null, 'Documents'))),
        tbody))));
    return out;
  }

  function detailPanel(o) {
    var m = MAP[o.id] || {};
    var byLayer = {};
    LAYERS.forEach(function (l) { byLayer[l.id] = []; });
    (m.documents || []).forEach(function (e) {
      var d = DOC[e.document_id];
      if (!d) return;
      var l = e.layer || d.layer;
      (byLayer[l] = byLayer[l] || []).push(d);
    });
    var trace = el('div', { class: 'trace', style: '--layers:' + Math.min(LAYERS.length, 4) });
    LAYERS.forEach(function (l, i) {
      var ds = byLayer[l.id];
      trace.appendChild(el('div', { class: 'layer' + (ds.length ? '' : ' layer-empty') },
        el('div', { class: 'layer-name' }, (i + 1) + '. ' + l.name),
        ds.length ? ds.map(docLink) : el('div', { style: 'font-size:14px;color:#333C48' }, l.empty_text || 'Nothing mapped at this layer')));
    });
    var siblings = o.common_control ? (oblsByCtrl[o.common_control] || []).filter(function (x) { return x.id !== o.id; }) : [];
    var cc = o.common_control ? CTRL[o.common_control] : null;
    return el('div', { class: 'detail', style: 'border-width:1px' },
      el('div', { class: 'spread', style: 'align-items:flex-start' },
        el('div', { class: 'stack-sm', style: 'max-width:900px' },
          el('h3', { style: 'font-size:20px' }, el('span', { class: 'mono', style: 'font-weight:500' }, o.control_id), ' ', o.title),
          wording(o),
          o.plain_summary ? el('p', null, el('strong', null, 'In plain terms: '), plain(o.plain_summary)) : null,
          (m.mapped_against_version || o.version) ? el('div', { class: 'version-note' }, 'Assessed against ' + (m.mapped_against_version || o.version)) : null),
        pill(status(o))),
      el('div', { class: 'kicker' }, 'Documents by layer'),
      trace,
      m.rationale ? el('div', null, el('strong', null, 'Why this status: '), m.rationale) : null,
      m.notes ? el('div', { class: 'muted' }, m.notes) : null,
      el('div', { class: 'row', style: 'font-size:14px;color:#545C68' },
        roleName(o.accountable_role) ? el('span', null, 'Accountable: ' + roleName(o.accountable_role) + '.') : null,
        m.last_reviewed ? el('span', null, 'Mapping last reviewed ' + fmtDate(m.last_reviewed) + '.') : el('span', null, 'No review date recorded.'),
        isOverdue(m) ? el('span', { class: 'overdue' }, 'Review overdue.') : null),
      (siblings.length || cc) ? el('div', { class: 'row' },
        el('span', { class: 'kicker', style: 'margin-right:4px' }, 'Also satisfies'),
        siblings.map(function (s) {
          return el('a', { class: 'tag', href: '#/reg/' + enc(s.regulation_id) + '/' + enc(s.id), style: 'text-decoration:none' },
            REG[s.regulation_id].name + ' ' + s.control_id);
        }),
        cc ? link('topic/' + enc(cc.topic), 'Topic: ' + TOPIC[cc.topic].name) : null) : null);
  }

  function timelineList(items, withReg) {
    var sorted = items.slice().sort(function (a, b) { return (a.k.date || '9999') < (b.k.date || '9999') ? -1 : 1; });
    var wrap = el('div', { class: 'tl' });
    var year = null;
    sorted.forEach(function (it, i) {
      var y = it.k.date ? it.k.date.slice(0, 4) : 'Date not set';
      if (withReg && y !== year) { wrap.appendChild(el('div', { class: 'tl-year' }, y)); year = y; }
      var fut = isFutureDate(it.k);
      var d = it.k.date ? daysUntil(it.k.date) : null;
      wrap.appendChild(el('div', { class: 'tl-item' + (fut ? ' future' : '') },
        el('div', { class: 'tl-date' }, keyDateText(it.k)),
        el('div', { class: 'tl-rail' }, el('span', { class: 'tl-dot' }), i < sorted.length - 1 ? el('span', { class: 'tl-line' }) : null),
        el('div', { class: 'tl-body' },
          el('div', { class: 't' }, it.k.label + (fut && d != null ? ' (' + (d === 0 ? 'today' : 'in ' + d + ' days') + ')' : '')),
          withReg ? el('div', { class: 'd' }, regLink(it.r), it.k.kind === 'internal' ? ', internal milestone' : '') : null,
          it.k.detail ? el('div', { class: 'd' }, it.k.detail) : null)));
    });
    return wrap;
  }

  function pageTimeline() {
    var items = [];
    applicableRegs().forEach(function (r) { (r.key_dates || []).forEach(function (k) { items.push({ r: r, k: k }); }); });
    return [
      el('section', { class: 'stack' }, el('h1', { class: 'page-title' }, 'Timeline'),
        el('p', { class: 'lede' }, 'When each regulation took effect, and what is coming. Future dates are highlighted with a countdown from today.')),
      filterNote(),
      el('section', { class: 'panel' }, items.length ? timelineList(items, true) : el('div', { class: 'empty' }, 'No dates recorded for these regulations.'))
    ];
  }

  function pageCrosswalk() {
    var regs = applicableRegs().filter(function (r) {
      return !isContext(r) && (oblsByReg[r.id] || []).some(function (o) { return o.common_control; });
    });
    var head = el('tr', null, el('th', null, 'Shared control'), regs.map(function (r) {
      return el('th', { class: 'reg' }, el('a', { href: '#/reg/' + enc(r.id) }, r.name));
    }));
    var tbody = el('tbody');
    var usedTotal = 0;
    var ctrlCount = 0;
    D.topics.forEach(function (t) {
      var ccs = D.controls.filter(function (cc) {
        return cc.topic === t.id && (oblsByCtrl[cc.id] || []).some(function (o) { return regs.indexOf(REG[o.regulation_id]) >= 0; });
      });
      if (!ccs.length) return;
      tbody.appendChild(el('tr', { class: 'group' }, el('td', { colspan: regs.length + 1 }, link('topic/' + enc(t.id), t.name))));
      ccs.forEach(function (cc) {
        ctrlCount++;
        var row = el('tr', null, el('td', { style: 'min-width:240px' }, el('strong', null, cc.name),
          cc.summary ? el('span', { class: 'sub' }, cc.summary) : null));
        regs.forEach(function (r) {
          var list = (oblsByCtrl[cc.id] || []).filter(function (o) { return o.regulation_id === r.id; });
          usedTotal += list.length;
          row.appendChild(el('td', { class: 'cell' }, list.length ? list.map(function (o) {
            return el('div', null, el('a', { href: '#/reg/' + enc(r.id) + '/' + enc(o.id), title: o.title + ': ' + LABEL[status(o)], style: 'text-decoration:none' },
              el('span', { class: 'dotmark dm-' + status(o), 'aria-hidden': 'true' }), el('span', { class: 'cell-id' }, o.control_id)),
              el('span', { class: 'visually-hidden' }, ', ' + LABEL[status(o)]));
          }) : el('span', { class: 'muted', 'aria-label': 'Not covered by this regulation' }, '')));
        });
        tbody.appendChild(row);
      });
    });
    return [
      el('section', { class: 'stack' }, el('h1', { class: 'page-title' }, 'Shared controls'),
        el('p', { class: 'lede' }, 'Many regulations ask for the same thing in different words. Each row is one control; each column shows which requirement it satisfies in that regulation. Documenting a control once can cover every requirement in its row.')),
      filterNote(),
      el('div', { class: 'spread', style: 'align-items:center' },
        el('div', null, el('strong', null, ctrlCount + ' shared controls'), el('span', { class: 'muted' }, ' cover ' + usedTotal + ' requirements across ' + regs.length + ' regulations')),
        csvButton('Crosswalk CSV', function () {
          var rows = [];
          D.controls.forEach(function (cc) {
            var r0 = [cc.id, cc.name, TOPIC[cc.topic] ? TOPIC[cc.topic].name : ''];
            regs.forEach(function (r) {
              r0.push((oblsByCtrl[cc.id] || []).filter(function (o) { return o.regulation_id === r.id; })
                .map(function (o) { return o.control_id + ' (' + LABEL[status(o)] + ')'; }).join('; '));
            });
            rows.push(r0);
          });
          downloadCsv('crosswalk-' + fileStamp() + '.csv', ['Control ID', 'Shared control', 'Topic'].concat(regs.map(function (r) { return r.name; })), rows);
        })),
      el('div', { class: 'table-wrap xw' }, el('table', null, el('thead', null, head), tbody)),
      legend()
    ];
  }

  function pageDocuments() {
    var seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Layer' });
    var opts = [['all', 'All']].concat(LAYERS.map(function (l) { return [l.id, l.name]; }));
    if (D.documents.some(function (d) { return !d.layer; })) opts.push(['_ref', 'Reference']);
    opts.forEach(function (g) {
      seg.appendChild(el('button', { type: 'button', 'aria-pressed': state.docLayer === g[0] ? 'true' : 'false',
        onClick: function () { state.docLayer = g[0]; render(true); } }, g[1]));
    });
    var list = D.documents.filter(function (d) {
      return state.docLayer === 'all' || d.layer === state.docLayer || (state.docLayer === '_ref' && !d.layer);
    });
    var tbody = el('tbody');
    list.forEach(function (d) {
      var n = (oblsByDoc[d.id] || []).length;
      tbody.appendChild(el('tr', null,
        el('td', { style: 'min-width:260px' }, docLink(d)),
        el('td', null, LAYER[d.layer] ? LAYER[d.layer].name : 'Reference', d.doc_type ? el('span', { class: 'sub' }, d.doc_type) : null),
        el('td', null, d.revision || ''),
        el('td', null, d.date_filed ? fmtDate(d.date_filed) : el('span', { class: 'muted' }, 'Not filed')),
        el('td', null, n ? link('doc/' + enc(d.id), n + ' requirement' + (n > 1 ? 's' : '')) : el('span', { class: 'muted' }, 'None mapped')),
        el('td', null, d.last_reviewed ? fmtDate(d.last_reviewed) : el('span', { class: 'muted' }, 'Not recorded'),
          isOverdue(d) ? el('span', { class: 'overdue', style: 'display:block' }, 'Review overdue') : null)));
    });
    return [
      el('section', { class: 'stack' }, el('h1', { class: 'page-title' }, 'Documents'),
        el('p', { class: 'lede' }, 'Every document the catalog points to, and how many requirements each one supports. Open a document to see exactly what depends on it before you revise it.')),
      el('div', { class: 'row' }, el('span', { class: 'muted', style: 'font-size:14px' }, 'Layer'), seg),
      el('div', { class: 'table-wrap' }, el('table', null,
        el('thead', null, el('tr', null, ['Document', 'Layer', 'Revision', 'Filed', 'Supports', 'Last reviewed'].map(function (h) { return el('th', null, h); }))),
        tbody))
    ];
  }

  function pageDoc(id) {
    var d = DOC[id];
    if (!d) return notFound('document');
    var obls = oblsByDoc[id] || [];
    var regsFor = D.regulations.filter(function (r) { return r.reg_document === id; });
    return [
      crumbs([['Home', ''], ['Documents', 'documents'], [d.id]]),
      el('section', { class: 'stack', style: 'gap:14px' },
        el('div', { class: 'row', style: 'gap:8px' }, el('span', { class: 'mono' }, d.id),
          el('span', { class: 'tag' }, LAYER[d.layer] ? LAYER[d.layer].name : 'Reference'),
          d.doc_type ? el('span', { class: 'tag tag-quiet' }, d.doc_type) : null,
          d.restricted ? el('span', { class: 'tag tag-restricted' }, 'Restricted access') : null),
        el('h1', { class: 'page-title' }, d.title),
        el('div', { class: 'muted' }, [d.revision, d.date_filed ? 'filed ' + fmtDate(d.date_filed) : null,
          d.last_reviewed ? 'last reviewed ' + fmtDate(d.last_reviewed) : null].filter(Boolean).join(', ')),
        d.status_note ? el('p', null, d.status_note) : null,
        d.url ? el('div', null, el('a', { class: 'btn btn-primary', href: d.url }, 'Open document')) : null,
        isOverdue(d) ? el('span', { class: 'overdue' }, 'Review overdue') : null),
      regsFor.length ? el('div', { class: 'panel' }, 'Reference file for ', regsFor.map(regLink)) : null,
      el('section', { class: 'stack' },
        el('h2', { class: 'section-title' }, 'Requirements that rely on this document'),
        el('p', { class: 'section-intro' }, 'If this document changes, these mappings may need to be reviewed.'),
        obls.length ? el('div', { class: 'table-wrap' }, requirementTable(obls, { docsHeader: 'All mapped documents' })) :
          el('div', { class: 'panel empty' }, 'No requirements are mapped to this document yet.'))
    ];
  }

  function pageReviews() {
    var ms = D.mappings.filter(isOverdue);
    var ds = D.documents.filter(isOverdue);
    var never = D.mappings.filter(function (m) { return !m.last_reviewed; }).length;
    var mb = el('tbody');
    ms.forEach(function (m) {
      var o = OBL[m.obligation_id]; var r = REG[o.regulation_id];
      mb.appendChild(el('tr', null, el('td', null, el('a', { href: '#/reg/' + enc(r.id) + '/' + enc(o.id) }, r.name + ' ' + o.control_id), el('span', { class: 'sub' }, o.title)),
        el('td', null, pill(m.status)), el('td', null, fmtDate(m.last_reviewed)), el('td', null, roleName(o.accountable_role) || '')));
    });
    var db = el('tbody');
    ds.forEach(function (d) {
      db.appendChild(el('tr', null, el('td', null, link('doc/' + enc(d.id), d.id), el('span', { class: 'sub' }, d.title)),
        el('td', null, fmtDate(d.last_reviewed)), el('td', null, (oblsByDoc[d.id] || []).length + ' requirements')));
    });
    return [
      el('section', { class: 'stack' }, el('h1', { class: 'page-title' }, 'Reviews due'),
        el('p', { class: 'lede' }, 'Items whose last review is older than the review interval (' + (C.review_interval_days || 365) +
          ' days unless set per item). Stale mappings are a common audit finding.')),
      el('div', { class: 'row' }, csvButton('Reviews CSV', function () {
        var rows = ms.map(function (m) { var o = OBL[m.obligation_id]; return ['Mapping', o.regulation_id + ' ' + o.control_id, o.title, m.last_reviewed, roleName(o.accountable_role) || '']; })
          .concat(ds.map(function (d) { return ['Document', d.id, d.title, d.last_reviewed, '']; }));
        downloadCsv('reviews-due-' + fileStamp() + '.csv', ['Kind', 'ID', 'Title', 'Last reviewed', 'Accountable'], rows);
      }), never ? el('span', { class: 'muted' }, never + ' mapping' + (never > 1 ? 's have' : ' has') + ' no review date recorded.') : null),
      el('section', { class: 'stack' }, el('h2', { style: 'font-size:22px;font-weight:600' }, 'Requirement mappings'),
        ms.length ? el('div', { class: 'table-wrap' }, el('table', null, el('thead', null, el('tr', null,
          ['Requirement', 'Status', 'Last reviewed', 'Accountable'].map(function (h) { return el('th', null, h); }))), mb)) :
          el('div', { class: 'panel empty' }, 'No mappings are past due.')),
      el('section', { class: 'stack' }, el('h2', { style: 'font-size:22px;font-weight:600' }, 'Documents'),
        ds.length ? el('div', { class: 'table-wrap' }, el('table', null, el('thead', null, el('tr', null,
          ['Document', 'Last reviewed', 'Supports'].map(function (h) { return el('th', null, h); }))), db)) :
          el('div', { class: 'panel empty' }, 'No documents are past due.'))
    ];
  }

  function pageGlossary() {
    var list = (D.glossary || []).slice().sort(function (a, b) { return a.term.localeCompare(b.term); });
    return [
      el('section', { class: 'stack' }, el('h1', { class: 'page-title' }, 'Glossary'),
        el('p', { class: 'lede' }, 'Plain definitions for terms used across the catalog. Underlined terms elsewhere show these definitions when you hover over them.')),
      el('section', { class: 'panel' }, list.length ? el('dl', { class: 'glossary', style: 'margin:0' }, list.map(function (g) {
        return [el('dt', null, g.term + ((g.aliases || []).length ? ' (' + g.aliases.join(', ') + ')' : '')), el('dd', null, g.definition)];
      })) : el('div', { class: 'empty' }, 'No glossary terms yet.'))
    ];
  }

  function pageSearch(q) {
    var needle = q.toLowerCase();
    var hit = function () {
      for (var i = 0; i < arguments.length; i++) if (arguments[i] && String(arguments[i]).toLowerCase().indexOf(needle) >= 0) return true;
      return false;
    };
    var groups = [
      ['Topics', D.topics.filter(function (t) { return hit(t.name, t.blurb, t.summary); }).map(function (t) { return link('topic/' + enc(t.id), t.name); })],
      ['Shared controls', D.controls.filter(function (c) { return hit(c.name, c.summary, c.id); }).map(function (c) { return link('topic/' + enc(c.topic), c.name); })],
      ['Regulations', D.regulations.filter(function (r) { return hit(r.id, r.name, r.full_title, r.summary); }).map(regLink)],
      ['Requirements', D.obligations.filter(function (o) { return hit(o.control_id, o.title, o.text, o.plain_title, o.plain_summary); }).map(function (o) {
        return el('a', { href: '#/reg/' + enc(o.regulation_id) + '/' + enc(o.id) }, REG[o.regulation_id].name + ' ' + o.control_id + ': ' + o.title);
      })],
      ['Documents', D.documents.filter(function (d) { return hit(d.id, d.title); }).map(function (d) { return link('doc/' + enc(d.id), d.id + ': ' + d.title); })],
      ['Glossary', (D.glossary || []).filter(function (g) { return hit(g.term, g.definition); }).map(function (g) { return link('glossary', g.term); })]
    ].filter(function (g) { return g[1].length; });
    var input = el('input', { type: 'search', id: 'q2', value: q });
    return [
      el('section', { class: 'stack' }, el('h1', { class: 'page-title' }, 'Search'),
        el('form', { class: 'search', role: 'search', onSubmit: function (e) { e.preventDefault(); if (input.value.trim()) go('search/' + enc(input.value.trim())); } },
          el('label', { for: 'q2', class: 'visually-hidden' }, 'Search'), input, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Search'))),
      groups.length ? groups.map(function (g) {
        return el('section', { class: 'panel stack-sm' }, el('h2', null, g[0] + ' (' + g[1].length + ')'), g[1]);
      }) : el('div', { class: 'panel empty' }, 'Nothing matched "' + q + '". Try a shorter word, or browse by topic from the home page.')
    ];
  }

  function notFound(kind) {
    return [el('section', { class: 'panel stack' }, el('h1', { class: 'section-title' }, 'That ' + kind + ' is not in this catalog'),
      el('p', null, 'The link may point to an older build. ', link('', 'Go to the home page'), '.'))];
  }

  // ------------------------------------------------------------------
  // Router
  // ------------------------------------------------------------------
  var lastBase = null;
  function go(route, keepScroll) {
    if (keepScroll) keepNext = true;
    location.hash = '#/' + route;
  }
  var keepNext = false;
  function parse() {
    var h = location.hash.replace(/^#\/?/, '');
    return h.split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
  }
  function render(keepScroll) {
    var parts = parse();
    var route = parts[0] || '';
    var content;
    switch (route) {
      case '': content = pageHome(); break;
      case 'topics': content = pageTopics(); break;
      case 'topic': content = pageTopic(parts[1]); break;
      case 'regulations': content = pageRegulations(); break;
      case 'reg': content = pageReg(parts[1], parts[2]); break;
      case 'crosswalk': content = pageCrosswalk(); break;
      case 'documents': content = pageDocuments(); break;
      case 'doc': content = pageDoc(parts[1]); break;
      case 'timeline': content = pageTimeline(); break;
      case 'reviews': content = pageReviews(); break;
      case 'glossary': content = pageGlossary(); break;
      case 'search': content = pageSearch(parts.slice(1).join('/')); break;
      default: content = notFound('page');
    }
    var y = window.scrollY;
    var app = document.getElementById('app');
    app.innerHTML = '';
    append(app, header(route));
    app.appendChild(el('main', { id: 'main' }, content));
    app.appendChild(footer());
    var base = route + '/' + (parts[1] || '');
    if (keepScroll || keepNext || base === lastBase) window.scrollTo(0, y);
    else window.scrollTo(0, 0);
    keepNext = false;
    lastBase = base;
    var titleBits = { topic: TOPIC[parts[1]] && TOPIC[parts[1]].name, reg: REG[parts[1]] && REG[parts[1]].name, doc: parts[1] };
    document.title = (titleBits[route] ? titleBits[route] + ', ' : '') + (C.title || 'Compliance Catalog');
  }

  window.addEventListener('hashchange', function () { render(false); });
  render(false);
})();
