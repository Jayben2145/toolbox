// Compare tool: line-by-line diff of two texts (left = base, right = compared).
// Everything runs client-side. The diff engine is a Myers O(ND) diff, used for
// lines and again on word tokens to highlight what changed inside edited lines.
(function () {
  'use strict';

  // ---------- diff engine ----------

  // Returns ops in order: { t: 'eq'|'del'|'ins', i: index in a, j: index in b }
  function diffSeq(a, b) {
    const n0 = a.length, m0 = b.length;
    let pre = 0;
    while (pre < n0 && pre < m0 && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < n0 - pre && suf < m0 - pre && a[n0 - 1 - suf] === b[m0 - 1 - suf]) suf++;

    const n = n0 - pre - suf, m = m0 - pre - suf;
    const A = (x) => a[pre + x], B = (y) => b[pre + y];
    const max = n + m, off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace = [];
    let found = 0;

    outer: for (let d = 0; d <= max; d++) {
      trace.push(v.slice(off - d, off + d + 1)); // state after step d-1, k in [-d, d]
      for (let k = -d; k <= d; k += 2) {
        let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]))
          ? v[off + k + 1]
          : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && A(x) === B(y)) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { found = d; break outer; }
      }
    }

    const ops = [];
    let x = n, y = m;
    for (let d = found; d > 0; d--) {
      const V = trace[d];
      const get = (kk) => V[kk + d];
      const k = x - y;
      const down = (k === -d || (k !== d && get(k - 1) < get(k + 1)));
      const prevK = down ? k + 1 : k - 1;
      const prevX = get(prevK), prevY = prevX - prevK;
      while (x > prevX && y > prevY) { x--; y--; ops.push({ t: 'eq', i: pre + x, j: pre + y }); }
      if (down) ops.push({ t: 'ins', i: -1, j: pre + prevY });
      else ops.push({ t: 'del', i: pre + prevX, j: -1 });
      x = prevX; y = prevY;
    }
    while (x > 0 && y > 0) { x--; y--; ops.push({ t: 'eq', i: pre + x, j: pre + y }); }
    ops.reverse();

    const head = [], tail = [];
    for (let i = 0; i < pre; i++) head.push({ t: 'eq', i, j: i });
    for (let s = suf; s > 0; s--) tail.push({ t: 'eq', i: n0 - s, j: m0 - s });
    return head.concat(ops, tail);
  }

  function splitLines(text) {
    if (text === '') return [];
    const lines = String(text).split(/\r\n|\r|\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // ignore final newline
    return lines;
  }

  function tokenize(s) {
    return s.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || [];
  }

  // Word-level diff of two lines -> segments for each side + similarity 0..1
  function inlineDiff(a, b) {
    const ta = tokenize(a), tb = tokenize(b);
    const ops = diffSeq(ta, tb);
    const left = [], right = [];
    let same = 0;
    const push = (arr, text, changed) => {
      const last = arr[arr.length - 1];
      if (last && last.changed === changed) last.text += text;
      else arr.push({ text, changed });
    };
    for (const op of ops) {
      if (op.t === 'eq') { push(left, ta[op.i], false); push(right, tb[op.j], false); same += ta[op.i].length; }
      else if (op.t === 'del') push(left, ta[op.i], true);
      else push(right, tb[op.j], true);
    }
    const total = a.length + b.length;
    return { left, right, similarity: total ? (2 * same) / total : 1 };
  }

  const EDIT_THRESHOLD = 0.4; // below this a removed+added pair is shown as separate lines

  // Builds display rows: { type: 'same'|'del'|'ins'|'edit', l, r, ln, rn, inline? }
  function compareTexts(baseText, otherText, opts) {
    opts = opts || {};
    const L = splitLines(baseText), R = splitLines(otherText);
    const norm = (s) => {
      if (opts.trim) s = s.trim();
      if (opts.ignoreCase) s = s.toLowerCase();
      return s;
    };
    const ops = diffSeq(L.map(norm), R.map(norm));
    const rows = [];

    let k = 0;
    while (k < ops.length) {
      if (ops[k].t === 'eq') {
        rows.push({ type: 'same', ln: ops[k].i + 1, rn: ops[k].j + 1, l: L[ops[k].i], r: R[ops[k].j] });
        k++;
        continue;
      }
      // a hunk: a run of deletions/insertions between equal lines
      const dels = [], ins = [];
      while (k < ops.length && ops[k].t !== 'eq') {
        if (ops[k].t === 'del') dels.push(ops[k].i); else ins.push(ops[k].j);
        k++;
      }
      // pair removed lines with added lines (in order) when they look like edits
      const pairs = [];
      let from = 0;
      for (let di = 0; di < dels.length && from < ins.length; di++) {
        let best = -1, bestSim = EDIT_THRESHOLD, bestInline = null;
        const limit = Math.min(ins.length, from + 50);
        for (let ij = from; ij < limit; ij++) {
          const d = inlineDiff(L[dels[di]], R[ins[ij]]);
          if (d.similarity >= bestSim) {
            if (d.similarity > bestSim || best === -1) { best = ij; bestSim = d.similarity; bestInline = d; }
          }
          if (bestSim === 1) break;
        }
        if (best !== -1) { pairs.push({ di, ij: best, inline: bestInline }); from = best + 1; }
      }
      let dp = 0, ip = 0;
      const flushTo = (dEnd, iEnd) => {
        for (; dp < dEnd; dp++) rows.push({ type: 'del', ln: dels[dp] + 1, l: L[dels[dp]] });
        for (; ip < iEnd; ip++) rows.push({ type: 'ins', rn: ins[ip] + 1, r: R[ins[ip]] });
      };
      for (const p of pairs) {
        flushTo(p.di, p.ij);
        rows.push({
          type: 'edit',
          ln: dels[p.di] + 1, rn: ins[p.ij] + 1,
          l: L[dels[p.di]], r: R[ins[p.ij]],
          inline: p.inline
        });
        dp = p.di + 1; ip = p.ij + 1;
      }
      flushTo(dels.length, ins.length);
    }
    return rows;
  }

  // Node export so the engine can be unit-tested without a browser
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { diffSeq, compareTexts, splitLines, inlineDiff };
    return;
  }

  // ---------- UI ----------

  const $ = (id) => document.getElementById(id);
  const base = $('cmpBase'), other = $('cmpOther');
  if (!base || !other) return;
  const body = $('cmpBody'), result = $('cmpResult'), summary = $('cmpSummary');
  const optTrim = $('cmpTrim'), optCase = $('cmpCase'), optOnly = $('cmpOnly');
  let lastRows = null;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function textCell(cls, text, segments) {
    const td = el('td', 'code ' + cls);
    if (segments) {
      for (const s of segments) {
        if (s.changed) td.appendChild(el('span', 'hl', s.text));
        else td.appendChild(document.createTextNode(s.text));
      }
    } else if (text != null) {
      td.textContent = text;
    }
    if (!td.textContent) td.appendChild(document.createTextNode('​')); // keep row height
    return td;
  }

  const CONTEXT = 3; // lines of unchanged context kept around changes in "only differences" mode

  function render(rows) {
    body.textContent = '';
    const frag = document.createDocumentFragment();
    if (optOnly.checked && !rows.some((r) => r.type !== 'same')) {
      const tr = el('tr', 'row-skip');
      const td = el('td', null, 'No differences.');
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    let show = rows.map(() => true);
    if (optOnly.checked) {
      show = rows.map(() => false);
      rows.forEach((r, i) => {
        if (r.type === 'same') return;
        for (let c = Math.max(0, i - CONTEXT); c <= Math.min(rows.length - 1, i + CONTEXT); c++) show[c] = true;
      });
    }

    let skipped = 0;
    const flushSkip = () => {
      if (!skipped) return;
      const tr = el('tr', 'row-skip');
      const td = el('td', null, `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`);
      td.colSpan = 4;
      tr.appendChild(td);
      frag.appendChild(tr);
      skipped = 0;
    };

    rows.forEach((r, i) => {
      if (!show[i]) { skipped++; return; }
      flushSkip();
      const tr = el('tr', 'row-' + r.type);
      const leftCls = r.type === 'ins' ? 'empty' : r.type;
      const rightCls = r.type === 'del' ? 'empty' : r.type;
      tr.appendChild(el('td', 'num ' + leftCls, r.ln != null ? String(r.ln) : ''));
      tr.appendChild(textCell(leftCls, r.l, r.inline && r.inline.left));
      tr.appendChild(el('td', 'num ' + rightCls, r.rn != null ? String(r.rn) : ''));
      tr.appendChild(textCell(rightCls, r.r, r.inline && r.inline.right));
      frag.appendChild(tr);
    });
    flushSkip();
    body.appendChild(frag);
  }

  function summarize(rows) {
    const c = { same: 0, del: 0, ins: 0, edit: 0 };
    for (const r of rows) c[r.type]++;
    summary.textContent = '';
    if (!c.del && !c.ins && !c.edit) {
      summary.appendChild(el('strong', 'ok', 'Identical'));
      summary.appendChild(document.createTextNode(` · ${c.same} line${c.same === 1 ? '' : 's'}`));
      return;
    }
    summary.appendChild(el('span', 'chip chip-del', `${c.del} removed`));
    summary.appendChild(el('span', 'chip chip-edit', `${c.edit} edited`));
    summary.appendChild(el('span', 'chip chip-ins', `${c.ins} added`));
    summary.appendChild(el('span', 'text-muted', `${c.same} unchanged`));
  }

  function run() {
    lastRows = compareTexts(base.value, other.value, { trim: optTrim.checked, ignoreCase: optCase.checked });
    summarize(lastRows);
    render(lastRows);
    result.classList.remove('hidden');
  }

  function asText(rows) {
    const out = [];
    for (const r of rows) {
      if (r.type === 'same') { if (!optOnly.checked) out.push('  ' + r.l); }
      else if (r.type === 'del') out.push(`- [${r.ln}] ${r.l}`);
      else if (r.type === 'ins') out.push(`+ [${r.rn}] ${r.r}`);
      else { out.push(`~ [${r.ln}] ${r.l}`); out.push(`~ [${r.rn}] ${r.r}`); }
    }
    return out.join('\n');
  }

  $('cmpRun').addEventListener('click', run);
  $('cmpSwap').addEventListener('click', () => {
    const t = base.value; base.value = other.value; other.value = t;
    if (lastRows) run();
  });
  $('cmpClear').addEventListener('click', () => {
    base.value = ''; other.value = '';
    lastRows = null;
    body.textContent = '';
    result.classList.add('hidden');
    base.focus();
  });
  $('cmpCopy').addEventListener('click', async (e) => {
    if (!lastRows) return;
    const btn = e.currentTarget;
    const text = asText(lastRows);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        // plain-HTTP fallback (clipboard API needs HTTPS or localhost)
        const ta = el('textarea');
        ta.value = text;
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        if (!ok) throw new Error('copy failed');
      }
      btn.textContent = 'Copied!';
    } catch {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => { btn.textContent = 'Copy as text'; }, 1500);
  });
  [optTrim, optCase].forEach((o) => o.addEventListener('change', () => { if (lastRows) run(); }));
  optOnly.addEventListener('change', () => { if (lastRows) render(lastRows); });
  [base, other].forEach((t) => t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
  }));
})();
