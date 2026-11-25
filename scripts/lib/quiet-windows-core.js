/**
 * 邪魔しない窓（2.8.295・axlx_quiet）の点検の解析（純関数・DB に触らない）。
 * scripts/check-quiet-windows.ts が使う。tests/chrome-extension/quiet-windows-core-v2295.test.js が試す。
 *
 * 入力: search_audits.steps の配列（{at, k, d}）と、拡張のバージョン。
 * 出力: 窓・窓の中の割り込み・見送り・引き継ぎ・リセット→次の入力の秒数・反映の抜け。
 */
"use strict";

/** 窓の中に入ったら「割り込みの疑い」として出す段（窓の外では普通の動き） */
const INTERRUPT = /^(tab_reload|tab_front|bulk_kick|kick_clamp|autofill_dead_kick|dl:estate_stuck_recover|page_fresh|result_mismatch|pipeline_silence|switch_timeout|switch_fail|superseded|busy_other|leftover_stuck|webapp_search|poll_batch|poll_now|handoff_.*fail|dl:sort_wait_stale_reset)/;

function verGte(a, b) {
  if (!a) return false;
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

function ms(at) {
  if (typeof at === "number") return at;
  const t = Date.parse(String(at || ""));
  return Number.isFinite(t) ? t : 0;
}

/** 窓を組み立てる（裏 bg と ページ dl: は別々に開け閉めする） */
function windowsOf(steps) {
  const out = [];
  const open = {};
  for (const s of steps || []) {
    const k = String((s && s.k) || "");
    const d = String((s && s.d) || "");
    const t = ms(s && s.at);
    const src = k.startsWith("dl:") ? "page" : "bg";
    if (k === "quiet_on" || k === "dl:quiet_on") {
      const kind = d.split(/\s+/)[0] || "?";
      const m = d.match(/上限(\d+)秒/);
      const lim = m ? Number(m[1]) * 1000 : 0;
      const prev = open[src];
      if (prev && prev.to > t) { prev.to = t; prev.why = "次の窓"; }
      const w = { kind, src, from: t, to: lim ? t + lim : t + 300000, why: lim ? "上限" : "上限不明(300秒)" };
      out.push(w);
      open[src] = w;
    } else if (k === "quiet_off" || k === "dl:quiet_off") {
      const w = open[src];
      if (w && w.to > t) { w.to = t; w.why = "外した:" + d.slice(0, 30); }
      open[src] = undefined;
    }
  }
  return out;
}

/**
 * 1回の記録を調べる。
 * @returns {{ wins, interrupts:[{k,d,at,kind}], defers:[{who,d}], inherits:[d], resetGaps:[{ms,short}], notReflected:boolean, isNew:boolean }}
 */
function analyzeSteps(steps, extVersion, needVer) {
  const st = Array.isArray(steps) ? steps : [];
  const keys = st.map((s) => String((s && s.k) || ""));
  const wins = windowsOf(st);
  const isNew = verGte(extVersion, needVer);
  const interrupts = [];
  const defers = [];
  const inherits = [];
  const resetGaps = [];

  st.forEach((s, i) => {
    const k = keys[i];
    const t = ms(s && s.at);
    if (INTERRUPT.test(k)) {
      // 重なった窓（裏の gap とページの sort など）は全部書く（先に見つかった1つだけにしない）
      const covering = wins.filter((x) => t >= x.from && t < x.to);
      if (covering.length) interrupts.push({ k, d: String((s && s.d) || "").slice(0, 60), at: t, kind: covering.map((w) => w.kind + "/" + w.src).join("+") });
    }
    if (k === "quiet_defer" || k === "dl:quiet_defer") {
      defers.push({ who: String((s && s.d) || "").split(/\s+/)[0] || "?", d: String((s && s.d) || "").slice(0, 70) });
    } else if (k === "quiet_inherit") {
      inherits.push(String((s && s.d) || "").slice(0, 70));
    }
  });

  for (let i = 0; i < st.length; i++) {
    if (!/^reset_press/.test(keys[i])) continue;
    const t0 = ms(st[i].at);
    const j = st.findIndex((s, jj) => jj > i && /^bulk_phase/.test(keys[jj]) && /^autofill /.test(String((s && s.d) || "")));
    if (j < 0) continue;
    const gap = ms(st[j].at) - t0;
    resetGaps.push({ ms: gap, short: gap < 30000 });
  }

  const hasReset = keys.some((k) => /^reset_press/.test(k));
  const hasQuiet = keys.some((k) => k === "quiet_on" || k === "dl:quiet_on");
  const notReflected = isNew && hasReset && !hasQuiet;
  return { wins, interrupts, defers, inherits, resetGaps, notReflected, isNew };
}

module.exports = { INTERRUPT, verGte, ms, windowsOf, analyzeSteps };
