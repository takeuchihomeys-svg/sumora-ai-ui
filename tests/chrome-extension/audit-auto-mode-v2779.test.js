/**
 * 自動モードの録画を「1回の検索」に畳む所のテスト（2026-11-15 竹内さん）
 *
 *   竹内さん「自動モードの録画で弱い部分や抜けている部分、機械的な部分、
 *     直接入力されてしまっている部分も見つけられるようにする」
 *
 * ★ このテストが守る物（実測で踏んだ罠）
 *   ① 1行＝1回の検索ではない（写真1枚＝1行・`shot_ops` は run の中で累積）
 *      → 畳まないと「54回の検索で40回押し直し」と**誤読**する（実際は1回の検索）
 *   ② 1回の押下が `tap` と `click` の2件で記録される（実測 差 121〜152ms）
 *      → 畳まないと押した回数が2倍になる
 *   ③ 「押さずに値だけ変わった欄」＝選ばずに入れた疑いを見つける
 *
 * 実行: node tests/chrome-extension/audit-auto-mode-v2779.test.js
 */
const path = require("path");
const fs = require("fs");

const ROOT = path.resolve(__dirname, "../..");
let pass = 0, fail = 0;
const t = (name, cond) => {
  if (cond) { pass++; }
  else { fail++; console.log("  ✗ " + name); }
};

// ── ① 実装が在るか（文字で確かめる）────────────
const libPath = path.join(ROOT, "app/lib/learn-auto-audit.ts");
const scrPath = path.join(ROOT, "scripts/audit-auto-mode.ts");
const lib = fs.readFileSync(libPath, "utf8");
const scr = fs.readFileSync(scrPath, "utf8");

t("純関数の置き場所が在る", fs.existsSync(libPath));
t("分析スクリプトが在る", fs.existsSync(scrPath));

// 畳む関数がそろっている
for (const fn of ["runOfRow", "foldRuns", "foldTapClick", "fieldName", "countRetries",
  "countChangedWithoutClick", "countDirectTyping", "collectGaps", "judgeMechanical",
  "isPerRowField", "countAdjacentRepresses", "countPerRowPresses"]) {
  t(`純関数 ${fn} が書き出されている`, new RegExp(`export function ${fn}\\b`).test(lib));
}

// ⚠ 実際に動かして確かめる（TypeScript を素で読めないので、同じ規則を写して検算する）
/** run を取り出す（実装と同じ規則） */
function runOfRow(r) {
  const m = String(r && r.shot_key != null ? r.shot_key : "").match(/run_([a-z0-9]+)/i);
  if (m) return m[1];
  return "single:" + String((r && r.shot_key) || (r && r.created_at) || Math.random());
}
function fieldName(f) {
  return String(f == null ? "" : f).replace(/^(左の|右の|上の|下の|中央の)/, "").replace(/｜[^｜]*$/, "").trim();
}
/** 一覧の行ごとに押す物（押し直しではない）＝ 実装と同じ規則 */
const PER_ROW_FIELD = /^(印刷用PDF|印刷|PDF|次へ|次のページ|ページ送り|詳細|資料|チェック|選択)$/;
const isPerRowField = (f) => PER_ROW_FIELD.test(fieldName(f));
function foldRuns(rows) {
  const byRun = new Map();
  for (const r of rows) {
    const k = runOfRow(r);
    if (!byRun.has(k)) byRun.set(k, []);
    byRun.get(k).push(r);
  }
  const out = [];
  for (const [run, list] of byRun) {
    const sorted = list.slice().sort((a, b) => {
      const d = ((b.shot_ops || []).length) - ((a.shot_ops || []).length);
      if (d !== 0) return d;
      return String(b.created_at || "").localeCompare(String(a.created_at || ""));
    });
    const best = sorted[0];
    out.push({ run, row: best, ops: (best.shot_ops || []).filter((o) => o && (o.k || o.f)), shots: list.length });
  }
  return out.sort((a, b) => String(b.row.created_at || "").localeCompare(String(a.row.created_at || "")));
}
function foldTapClick(ops, within = 300) {
  const out = [];
  for (const o of ops) {
    if (!o) continue;
    const prev = out.length ? out[out.length - 1] : null;
    if (prev) {
      const dt = Math.abs((Number(o.t) || 0) - (Number(prev.t) || 0));
      const sameField = fieldName(prev.f) === fieldName(o.f) && fieldName(o.f) !== "";
      const isPair = sameField && dt <= within &&
        ((prev.k === "tap" && o.k === "click") || (prev.k === "click" && o.k === "tap"));
      if (isPair) {
        if (!prev.by && o.by) prev.by = o.by;
        prev.t = o.t;
        continue;
      }
    }
    out.push(Object.assign({}, o));
  }
  return out;
}

// ── ② 実測の形（2026-11-14 自動モード run mwgf1gx3）────────────
//   同じ run の写真が 1手 → 3手 → 5手 と増えていく（累積）
const shot = (seq, ops, at) => ({
  created_at: at,
  shot_key: `2026-11-14/aix/run_mwgf1gx3_n1k5/588ff8d3-179466${String(seq).padStart(6, "0")}.jpg`,
  ext_version: "2.7.61",
  shot_ops: ops,
});
const T0 = 1794661400000;
const rows = [
  shot(1, [{ t: T0, k: "tap", f: "印刷用PDF｜a.print" }], "2026-11-14T13:03:11Z"),
  shot(2, [{ t: T0, k: "tap", f: "印刷用PDF｜a.print" }, { t: T0 + 152, k: "click", f: "印刷用PDF｜a.print", by: "auto" }], "2026-11-14T13:03:20Z"),
  shot(3, [
    { t: T0, k: "tap", f: "印刷用PDF｜a.print" },
    { t: T0 + 152, k: "click", f: "印刷用PDF｜a.print", by: "auto" },
    { t: T0 + 5000, k: "tap", f: "印刷用PDF｜a.print" },
    { t: T0 + 5150, k: "click", f: "印刷用PDF｜a.print", by: "auto" },
    { t: T0 + 9000, k: "click", f: "transportation_id", by: "human" },
  ], "2026-11-14T13:07:08Z"),
];

const folded = foldRuns(rows);
t("同じ run の写真は1回の検索に畳まれる", folded.length === 1);
t("畳んだら写真の枚数が分かる", folded[0].shots === 3);
t("一番進んだ写真（操作が一番多い）を採る", folded[0].ops.length === 5);

const ops = foldTapClick(folded[0].ops);
t("tap→click の対は1回に畳まれる（5手 → 3手）", ops.length === 3);
t("畳んでも押した欄の名前は残る", ops.every((o) => o.f));
t("畳んだ後に by=auto が残る", ops.filter((o) => o.by === "auto").length === 2);
t("人が押した記録は消えない", ops.some((o) => o.by === "human"));

// ⚠ 畳まないと水増しされる（この差が「40回押し直し」の誤読の正体）
const raw = rows.reduce((a, r) => a + (r.shot_ops || []).filter((o) => String(o.f || "").includes("PDF")).length, 0);
const real = ops.filter((o) => String(o.f || "").includes("PDF")).length;
t("畳まない数は水増しされる（1回の押下が2件×写真の枚数）", raw === 7 && real === 2);
t("畳むと押した回数が実際の回数になる", real < raw);

// ── ⑧b 行ごとの押下は押し直しではない（実測の誤読の本体）────────────
t("印刷用PDF は「行ごとに押す物」", isPerRowField("印刷用PDF"));
t("次のページも行ごと（ページ送り）", isPerRowField("次のページ"));
t("transportation_id は行ごとではない（欄）", !isPerRowField("transportation_id"));
const perRow = ops.filter((o) => isPerRowField(o.f)).length;
t("行ごとの押下を数えられる（物件の件数）", perRow === 2);

// ── ③ 離れた同じ欄は「押し直し」として残す ────────────
const retry = foldTapClick([
  { t: 1000, k: "click", f: "transportation_id" },
  { t: 2000, k: "click", f: "transportation_id" },
]);
t("離れた同じ欄（1000ms）は押し直しとして残す", retry.length === 2);

// ── ④ run が分からない写真は混ぜない ────────────
const noRun = foldRuns([
  { created_at: "2026-11-14T10:00:00Z", shot_key: null, shot_ops: [{ t: 1, k: "click", f: "a" }] },
  { created_at: "2026-11-14T10:00:05Z", shot_key: null, shot_ops: [{ t: 1, k: "click", f: "b" }] },
]);
t("run が分からない写真は1枚ずつ別の検索として扱う", noRun.length === 2);

// ── ⑤ 欄の名前をそろえる ────────────
t("接頭辞と｜タグ名を落とす", fieldName("左の検索｜span") === "検索");
t("名前が無ければ空", fieldName(null) === "");
t("PDF の名前も読める", fieldName("印刷用PDF｜a.print") === "印刷用PDF");

// ── ⑥ 押さずに値だけ変わった欄（選ばずに入れた疑い）────────────
function countChangedWithoutClick(list) {
  const clicked = new Set();
  for (const o of list) if (o && (o.k === "click" || o.k === "tap")) { const f = fieldName(o.f); if (f) clicked.add(f); }
  const out = {};
  for (const o of list) {
    if (!o || o.k !== "change") continue;
    const f = fieldName(o.f);
    if (!f || clicked.has(f)) continue;
    out[f] = (out[f] || 0) + 1;
  }
  return out;
}
const cnc = countChangedWithoutClick([
  { k: "click", f: "rental_cost" }, { k: "change", f: "rental_cost" },   // 人が選んだ形
  { k: "change", f: "room_layout_id" },                                   // ⚠ 押さずに変わった
]);
t("人が選んだ欄（click→change）は疑いに入れない", !cnc.rental_cost);
t("押さずに値が変わった欄は疑いに入れる", cnc.room_layout_id === 1);

// ── ⑦ 機械的な間の見方 ────────────
function judgeMechanical(gaps) {
  const g = gaps.filter((x) => typeof x === "number" && x > 0);
  if (!g.length) return { n: 0, median: 0, tooFast: 0, kinds: 0, flat: false };
  const s = g.slice().sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)];
  const tooFast = g.filter((x) => x < 200).length;
  const kinds = new Set(g).size;
  const flat = g.length >= 6 && kinds / g.length < 0.3;
  return { n: g.length, median, tooFast, kinds, flat };
}
const humanGaps = [4100, 3200, 5600, 2800, 7300, 3900];   // 実測の手本に近い揺れ
const mechGaps = [100, 100, 100, 100, 100, 100];          // 機械（一定・速い）
t("人の間は「機械的」と判定しない", judgeMechanical(humanGaps).flat === false);
t("一定の間は「機械的」と判定する", judgeMechanical(mechGaps).flat === true);
t("200ms 未満は速すぎると数える", judgeMechanical(mechGaps).tooFast === 6);
t("間が無ければ判定しない", judgeMechanical([]).n === 0);

// ── ⑧ 押し直しの数え方 ────────────
function countRetries(runs) {
  const out = {};
  for (const list of runs) {
    const c = {};
    for (const o of list) { const f = fieldName(o && o.f); if (!f || isPerRowField(f)) continue; c[f] = (c[f] || 0) + 1; }
    for (const [f, k] of Object.entries(c)) if (k >= 2) out[f] = (out[f] || 0) + 1;
  }
  return out;
}
const rt = countRetries([ops, [{ k: "click", f: "transportation_id" }, { k: "click", f: "transportation_id" }]]);
t("同じ欄を2回押した回を数える", rt.transportation_id === 1);
t("一覧の行ごとに押す物（PDF）は押し直しに数えない", !rt["印刷用PDF"]);

// ── ⑨ スクリプトが畳む関数を使っているか（実装の結線）────────────
t("スクリプトが foldRuns を使う", /foldRuns\(/.test(scr));
t("スクリプトが foldTapClick を使う", /foldTapClick\(/.test(scr));
t("スクリプトが run を畳んだ数を出す", /同じ run を畳むと/.test(scr));
t("スクリプトが直接入力を見る", /直接入力/.test(scr));
t("スクリプトが押さずに値が変わる欄を見る", /押さずに値だけ変わった欄/.test(scr));
t("スクリプトが機械的な所を見る", /機械的な所/.test(scr));
t("スクリプトが抜けを見る", /抜け（学べない理由）/.test(scr));
t("スクリプトが弱い所を見る", /弱い所/.test(scr));
t("スクリプトが読むだけ（既定で保存しない）", /args\.includes\("--save"\)/.test(scr));
t("入力した中身を扱わないと明記", /入力した中身は扱わない/.test(scr));
t("累積の罠をコメントで残している", /累積/.test(lib) && /累積/.test(scr));
t("tap/click の罠をコメントで残している", /121〜152ms|121〜15/.test(lib) || /121〜152ms/.test(scr));

console.log(`\n${pass} 合格 / ${fail} 不備`);
if (fail) process.exit(1);
