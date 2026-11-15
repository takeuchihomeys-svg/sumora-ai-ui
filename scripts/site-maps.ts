/**
 * サイト別の全体図（リアプロ／itandi／レインズ）を1枚ずつ作る（2026-11-15 竹内さん）
 *
 *   竹内さん「リアプロitandiそれぞれ全体図つくっていくのと 補強して細かくきょうかしていく
 *     全体図があればわかりやすい どこを強化する部分があるのかもすぐにわかるし かいぜんできうようになる」
 *
 * ★ 考え方
 *   **サイトごとに分ける**。リアプロと itandi は欄の名前も手順も別物なので、
 *   混ぜて数えると「どこが弱いか」が見えなくなる。
 *   1サイト = 1枚の図にして、**読めている所と読めていない所**を並べる。
 *
 * ★ 図に必ず入れる物
 *   ① 材料の在庫（記録・操作・マウス・押した場所・開き方・写真の大きさ）
 *   ② よく押す欄（＝強い所）
 *   ③ 読めていない物と**その理由**（＝強化する所）
 *   ④ 画面の段（form/modal/result）ごとの手順
 *
 * ⚠ 扱うのは**欄の名前・位置・回数だけ**。入力した中身（値・文字）は扱わない。
 *
 * 実行: npx tsx --env-file=.env.local scripts/site-maps.ts
 *   出力: tmp-map-realpro.svg / tmp-map-itandi.svg / tmp-map-reins.svg
 */
import { supabase } from "../app/lib/supabase-server";
import { writeFileSync } from "node:fs";

type Op = { k?: string; f?: string; w?: string; by?: string };
type Row = Record<string, unknown> & { shot_ops?: Op[] | null };

const SITES: Array<{ key: string; ja: string; color: string; light: string; border: string; hint: string }> = [
  { key: "realpro", ja: "リアプロ", color: "#1d4ed8", light: "#eff6ff", border: "#bfdbfe", hint: "realnetpro.com" },
  { key: "itandi", ja: "ITANDI BB", color: "#15803d", light: "#f0fdf4", border: "#bbf7d0", hint: "itandibb.com" },
  { key: "reins", ja: "レインズ", color: "#a16207", light: "#fefce8", border: "#fde68a", hint: "system.reins.jp" },
];

const pctOf = (set: Row[], f: (r: Row) => boolean) => (set.length ? Math.round((set.filter(f).length / set.length) * 100) : 0);
const hasOps = (r: Row) => Array.isArray(r.shot_ops) && (r.shot_ops as unknown[]).length > 0;
const hasMove = (r: Row) => Number(r.moves_n) > 0;
const hasPoint = (r: Row) => !!(r.point_fields && Object.keys(r.point_fields as object).length);
const hasOpen = (r: Row) => !!(r.opens && Object.keys(r.opens as object).length);
const hasBig = (r: Row) => Number(r.shot_w) >= 1000;
const hasLearn = (r: Row) => !!r.shot_learn;
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

void (async () => {
  const since = new Date(Date.now() - 180 * 86400_000).toISOString();
  const summary: Array<{ key: string; ja: string; color: string; light: string; border: string; hint: string; n: number; rn: number; ops: number | null; opsAll: number; mv: number | null; pt: number | null; open: number | null; big: number | null; fields: number; gaps: number; first: string | null }> = [];
  let all: Row[] = [];
  for (let from = 0; from < 12000; from += 1000) {
    const { data } = await supabase.from("human_motion_learn")
      .select("created_at,site,mode,ext_version,shot_ops,point_fields,kinds,moves_n,move_speed_px_s,move_curve,move_ms,move_dist,shot_w,shot_learn,opens,fields")
      .gte("created_at", since).order("created_at", { ascending: false }).range(from, from + 999);
    all = all.concat((data ?? []) as Row[]);
    if ((data ?? []).length < 1000) break;
  }

  for (const s of SITES) {
    const rows = all.filter((r) => String(r.site ?? "") === s.key);
    const n = rows.length;
    /**
     * ⚠ 2026-11-15 重要: 記録は 2.7.12〜2.7.61 が混ざっている。
     *   全期間で数えると**昔の版（材料が入る前）で薄まって**「弱い」と誤解する。
     *   実測: リアプロの操作の並びは全期間 49% → 新しい版だけ 98%。
     *   → **両方を出す**（今の実力＝新しい版／見かけ＝全期間）。
     *   ⚠ 強化する所は**新しい版の数字で決める**（古い版の欠けは撮り直せば直る）。
     */
    const recent = rows.filter((r) => {
      const p = String(r.ext_version ?? "0").split(".").map(Number);
      return p[0] === 2 && p[1] === 7 && (p[2] ?? 0) >= 46;
    });
    const rn = recent.length;
    const rate = (set: Row[], f: (r: Row) => boolean) => (set.length ? Math.round((set.filter(f).length / set.length) * 100) : 0);
    /** 件数が0の時は「0%」ではなく「－」と出す（0%＝測って悪い、と誤解されるため） */
    const rateTxt = (set: Row[], f: (r: Row) => boolean) => (set.length ? rate(set, f) + "%" : "－");
    /** バーの長さ（件数0なら0） */
    const ratePct = (set: Row[], f: (r: Row) => boolean) => (set.length ? rate(set, f) : 0);
    const W = 1120, H = 900;

    // ── 集計 ──
    const fieldHit: Record<string, number> = {};
    const fieldW: Record<string, string> = {};
    for (const r of rows) {
      for (const [k, v] of Object.entries((r.point_fields ?? {}) as Record<string, { n?: number; w?: string }>)) {
        const c = Number(v?.n) || 0;
        if (c < 2) continue;
        fieldHit[k] = (fieldHit[k] || 0) + c;
        if (v.w && !fieldW[k]) fieldW[k] = v.w;
      }
    }
    const top = Object.entries(fieldHit).sort((a, b) => b[1] - a[1]).slice(0, 8);

    const wk: Record<string, number> = {};
    let selOps = 0;
    const selFields = new Set<string>();
    const stageOps: Record<string, number> = {};
    for (const r of rows) {
      for (const o of ((r.shot_ops ?? []) as Op[])) {
        if (!o) continue;
        if (o.w) wk[o.w] = (wk[o.w] || 0) + 1;
        if (o.w === "select") { selOps++; const f = String(o.f ?? "").replace(/^左の|｜.*$/g, ""); if (f) selFields.add(f); }
        if (String(o.k) === "step" && o.f) stageOps[String(o.f)] = (stageOps[String(o.f)] || 0) + 1;
      }
    }
    const sp = rows.map((r) => Number(r.move_speed_px_s)).filter((x) => x > 0).sort((a, b) => a - b);
    const medSpeed = sp.length ? sp[Math.floor(sp.length / 2)] : 0;
    const cv = rows.map((r) => Number(r.move_curve)).filter((x) => x > 0).sort((a, b) => a - b);
    const medCurve = cv.length ? cv[Math.floor(cv.length / 2)] : 0;
    const mss = rows.map((r) => Number(r.move_ms)).filter((x) => x > 0).sort((a, b) => a - b);
    const medMs = mss.length ? mss[Math.floor(mss.length / 2)] : 0;

    // 読めていない物と理由（⚠ **新しい版の数字**で決める。古い版の欠けは撮り直せば直る）
    const base = rn > 0 ? recent : rows;
    const bn = base.length;
    const gaps: string[] = [];
    if (!n) gaps.push("記録がありません → このサイトで1回検索して録画する");
    if (n && rn === 0) gaps.push(`新しい版（2.7.46以降）の記録が0件 → 今の版で1回録画する（古い版の数字では判断できない）`);
    if (bn && rate(base, hasOps) < 50) gaps.push(`操作の並びが ${rate(base, hasOps)}% だけ → 記録の経路を確かめる`);
    if (bn && rate(base, hasMove) < 30) gaps.push(`マウスの動きが ${rate(base, hasMove)}% だけ → カーソルの記録を足す`);
    if (bn && rate(base, hasBig) === 0) gaps.push("文字が読める写真が0% → 撮り直す（480pxでは拡大しても読めない）");
    if (bn && rate(base, hasOpen) === 0) gaps.push("押したら何が開くかが0% → 2.7.67以降で撮り直す");
    if (bn && !Object.keys(fieldHit).length) gaps.push("押した場所が無い → 位置の記録を確かめる");

    const bar = (x: number, y: number, p: number, label: string, val: string) => `
    <text x="${x}" y="${y - 6}" font-size="11.5" fill="#475569">${esc(label)}</text>
    <rect x="${x}" y="${y}" width="240" height="16" rx="4" fill="#e8edf3"/>
    <rect x="${x}" y="${y}" width="${Math.max(3, (240 * p) / 100)}" height="16" rx="4" fill="${p >= 60 ? s.color : p > 0 ? "#f59e0b" : "#dc2626"}"/>
    <text x="${x + 250}" y="${y + 13}" font-size="12" font-weight="600" fill="${p >= 60 ? s.color : p > 0 ? "#b45309" : "#b91c1c"}">${val}</text>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Yu Gothic','Meiryo',sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <rect x="0" y="0" width="${W}" height="76" fill="${s.light}"/>
  <text x="28" y="40" font-size="24" font-weight="700" fill="${s.color}">${esc(s.ja)} の全体図</text>
  <text x="28" y="64" font-size="13" fill="#475569">${esc(s.hint)} ／ 記録 ${n}件（180日）／ 実測だけ・推測なし${n > 0 && n < 10 ? ` ／ ⚠ ${n}件だけなので**まだ傾向とは言えません**` : ""}</text>

  ${n === 0 ? `
  <rect x="28" y="100" width="${W - 56}" height="180" rx="12" fill="#fef2f2" stroke="#fecaca" stroke-width="1.5"/>
  <text x="52" y="136" font-size="17" font-weight="700" fill="#b91c1c">このサイトの記録がまだありません</text>
  <text x="52" y="166" font-size="13.5" fill="#7f1d1d">→ ${esc(s.ja)} で1回検索して録画すれば、この図が埋まります</text>
  <text x="52" y="192" font-size="13" fill="#334155">（リアプロの記録は ${all.filter((r) => String(r.site) === "realpro").length}件あります。サイトごとに欄の名前が違うので混ぜません）</text>
  <text x="52" y="240" font-size="13" fill="#475569">強化する所（記録が入ったら自動で出ます）: 欄の名前・押す位置・開き方・手順の順番</text>
  ` : `
  <!-- 材料（新しい版＝いまの実力） -->
  <rect x="28" y="96" width="520" height="212" rx="12" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1.5"/>
  <text x="48" y="124" font-size="15" font-weight="700" fill="#334155">読めている量（新しい版 2.7.46以降・${rn}件${rn === 0 ? "・まだ測れていません" : ""}）</text>
  ${bar(48, 150, ratePct(recent, hasOps), "操作の並び（どの欄を・どの順で）", rateTxt(recent, hasOps))}
  ${bar(48, 192, ratePct(recent, hasMove), "マウスの動き（速さ・曲がり）", rateTxt(recent, hasMove))}
  ${bar(48, 234, ratePct(recent, hasPoint), "押した場所（要素の中のどこ）", rateTxt(recent, hasPoint))}
  ${bar(48, 276, ratePct(recent, hasLearn), "写真から欄を読めた", rateTxt(recent, hasLearn))}
  <text x="48" y="300" font-size="11" fill="#64748b">全期間（${n}件）で見ると: 操作 ${pctOf(rows, hasOps)}%・マウス ${pctOf(rows, hasMove)}%・場所 ${pctOf(rows, hasPoint)}%</text>

  <!-- 読めていない -->
  <rect x="572" y="96" width="520" height="212" rx="12" fill="#fef2f2" stroke="#fecaca" stroke-width="1.5"/>
  <text x="592" y="124" font-size="15" font-weight="700" fill="#b91c1c">強化する所（読めていない・理由つき）</text>
  ${gaps.length ? gaps.map((g, i) => `<text x="592" y="${150 + i * 26}" font-size="12.5" fill="#7f1d1d">${i + 1}. ${esc(g)}</text>`).join("") : `<text x="592" y="152" font-size="13" fill="#15803d">✓ 大きな欠けはありません</text>`}

  <!-- マウス実測 -->
  <rect x="28" y="328" width="330" height="132" rx="12" fill="${s.light}" stroke="${s.border}"/>
  <text x="46" y="354" font-size="14.5" font-weight="700" fill="${s.color}">① マウスの実測</text>
  <text x="46" y="380" font-size="12.5" fill="#334155">速さ ${medSpeed || "－"}px/s ／ 曲がり ${medCurve ? medCurve.toFixed(2) : "－"}</text>
  <text x="46" y="402" font-size="12.5" fill="#334155">1回 ${medMs || "－"}ms</text>
  <text x="46" y="428" font-size="12" fill="#475569">→ 見えるカーソルをこの速さに寄せる</text>
  <text x="46" y="448" font-size="11.5" fill="#b45309">記録 ${pctOf(rows, hasMove)}% の実測</text>

  <!-- ボタン -->
  <rect x="374" y="328" width="330" height="132" rx="12" fill="${s.light}" stroke="${s.border}"/>
  <text x="392" y="354" font-size="14.5" font-weight="700" fill="${s.color}">② ボタン</text>
  <text x="392" y="380" font-size="12.5" fill="#334155">欄 ${Object.keys(fieldHit).length}種類・${Object.keys(rows).length ? rows.filter(hasPoint).length : 0}件で記録</text>
  <text x="392" y="402" font-size="12" fill="#475569">checkbox ${wk.checkbox ?? 0}／select ${wk.select ?? 0}</text>
  <text x="392" y="422" font-size="12" fill="#475569">link ${wk.link ?? 0}／button ${wk.button ?? 0}／text ${wk.text ?? 0}</text>
  <text x="392" y="448" font-size="12" fill="#475569">→ 要素の中の位置まで分かる</text>

  <!-- プルダウン -->
  <rect x="720" y="328" width="372" height="132" rx="12" fill="#fefce8" stroke="#fde68a"/>
  <text x="738" y="354" font-size="14.5" font-weight="700" fill="#a16207">③ プルダウン</text>
  <text x="738" y="380" font-size="12.5" fill="#334155">select ${selOps}回・${selFields.size}種類</text>
  <text x="738" y="400" font-size="11.5" fill="#475569">${esc([...selFields].slice(0, 3).join("・") || "－")}</text>
  <text x="738" y="418" font-size="11.5" fill="#475569">${esc([...selFields].slice(3, 6).join("・") || "")}</text>
  <text x="738" y="442" font-size="12" fill="${pctOf(rows, hasOpen) > 0 ? "#15803d" : "#b91c1c"}">開いた中身: ${pctOf(rows, hasOpen)}%</text>

  <!-- よく押す欄 -->
  <text x="28" y="494" font-size="16" font-weight="700" fill="#0f172a">よく押す欄（＝このサイトの中心・この順で押されている）</text>
  ${top.length ? top.map(([k, c], i) => `
    <rect x="28" y="${508 + i * 27}" width="530" height="23" rx="5" fill="${i % 2 ? "#f8fafc" : "#f1f5f9"}"/>
    <text x="38" y="${525 + i * 27}" font-size="12.5" fill="#0f172a">${i + 1}. ${esc(k)}</text>
    ${fieldW[k] ? `<text x="380" y="${525 + i * 27}" font-size="11" fill="#64748b">[${esc(fieldW[k])}]</text>` : ""}
    <text x="548" y="${525 + i * 27}" font-size="12.5" fill="#475569" text-anchor="end">${c}回</text>`).join("")
    : `<text x="28" y="530" font-size="13" fill="#64748b">（押した場所の記録がまだありません）</text>`}

  <!-- 段（step）ごとの手順 -->
  <rect x="580" y="508" width="512" height="128" rx="12" fill="#f8fafc" stroke="#e2e8f0"/>
  <text x="600" y="534" font-size="14" font-weight="700" fill="#334155">画面の段ごとの手順</text>
  ${Object.keys(stageOps).length
    ? Object.entries(stageOps).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c], i) => `<text x="600" y="${558 + i * 22}" font-size="12.5" fill="#334155">${esc(k)}: ${c}回</text>`).join("")
    : `<text x="600" y="560" font-size="12.5" fill="#64748b">（段の記録がまだありません）</text>`}
  <text x="600" y="626" font-size="11.5" fill="#64748b">段: form（条件）／modal（小窓）／result（一覧）</text>

  <!-- 次の一手 -->
  <rect x="28" y="742" width="1064" height="62" rx="12" fill="#0f172a"/>
  <text x="48" y="768" font-size="13.5" font-weight="700" fill="#ffffff">次の一手</text>
  <text x="48" y="790" font-size="12.5" fill="#cbd5e1">${gaps.length ? esc(gaps[0]) : "大きな欠けはありません → 実測を拡張の動きに反映する"}</text>
  `}
</svg>`;

    const file = `tmp-map-${s.key}.svg`;
    writeFileSync(file, svg, "utf8");
    console.log(`\n■ ${s.ja}（${n}件）→ ${file}`);
    if (n) {
      console.log(`  操作 ${rateTxt(recent, hasOps)}（全期間 ${pctOf(rows, hasOps)}%） / マウス ${rateTxt(recent, hasMove)}（全期間 ${pctOf(rows, hasMove)}%） / 場所 ${rateTxt(recent, hasPoint)} / 学習 ${rateTxt(recent, hasLearn)} / 大写真 ${rateTxt(recent, hasBig)} / 開き方 ${rateTxt(recent, hasOpen)}  ← 新しい版 ${rn}件`);
      console.log(`  欄 ${Object.keys(fieldHit).length}種類・select ${selOps}回・要素 ${Object.entries(wk).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c]) => k + " " + c).join("/")}`);
      console.log(`  マウス: ${medSpeed}px/s・曲がり ${medCurve.toFixed(2)}・${medMs}ms`);
      if (top.length) console.log(`  よく押す: ${top.map(([k, c]) => `${k}(${c})`).join("・")}`);
    }
    if (gaps.length) console.log(`  強化する所: ${gaps.length}件`);
    summary.push({ ...s, n, rn, ops: rn ? rate(recent, hasOps) : null, opsAll: n ? pctOf(rows, hasOps) : 0, mv: rn ? rate(recent, hasMove) : null, pt: rn ? rate(recent, hasPoint) : null, open: rn ? rate(recent, hasOpen) : null, big: rn ? rate(recent, hasBig) : null, fields: Object.keys(fieldHit).length, gaps: gaps.length, first: gaps[0] ?? null });
  }

  // ══ 索引（3サイトを1枚に）══
  {
    const W = 1120, H = 560;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Yu Gothic','Meiryo',sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="28" y="42" font-size="24" font-weight="700" fill="#0f172a">サイト別 全体図（索引）</text>
  <text x="28" y="66" font-size="13" fill="#64748b">サイトごとに分けて持つ。欄の名前も手順も別物なので混ぜない（実測だけ）</text>
  ${summary.map((x, i) => {
    const y = 96 + i * 146;
    return `
  <rect x="28" y="${y}" width="1064" height="130" rx="12" fill="${x.light}" stroke="${x.border}" stroke-width="1.5"/>
  <text x="48" y="${y + 30}" font-size="18" font-weight="700" fill="${x.color}">${esc(x.ja)}</text>
  <text x="200" y="${y + 30}" font-size="13" fill="#475569">${esc(x.hint)} ／ 記録 ${x.n}件${x.n > 0 && x.n < 10 ? "（少ない・傾向とは言えない）" : ""}／ 新しい版 ${x.rn}件</text>
  <text x="48" y="${y + 58}" font-size="13" fill="#334155">操作の並び <tspan font-weight="700" fill="${(x.ops ?? 0) >= 60 ? x.color : "#b45309"}">${x.ops == null ? "－" : x.ops + "%"}</tspan><tspan font-size="11" fill="#94a3b8">（全期間 ${x.opsAll}%）</tspan> ／ マウス <tspan font-weight="700" fill="${(x.mv ?? 0) >= 30 ? x.color : "#b45309"}">${x.mv == null ? "－" : x.mv + "%"}</tspan> ／ 押した場所 <tspan font-weight="700" fill="${(x.pt ?? 0) >= 30 ? x.color : "#b45309"}">${x.pt == null ? "－" : x.pt + "%"}</tspan> ／ 開き方 <tspan font-weight="700" fill="${(x.open ?? 0) > 0 ? x.color : "#b91c1c"}">${x.open == null ? "－" : x.open + "%"}</tspan> ／ 読める写真 <tspan font-weight="700" fill="${(x.big ?? 0) > 0 ? x.color : "#b91c1c"}">${x.big == null ? "－" : x.big + "%"}</tspan></text>
  <text x="48" y="${y + 84}" font-size="13" fill="#334155">分かっている欄: ${x.fields}種類 ／ 強化する所: ${x.gaps}件</text>
  <text x="48" y="${y + 110}" font-size="12.5" fill="${x.gaps ? "#b91c1c" : "#15803d"}">${x.first ? "→ " + esc(x.first) : "→ 大きな欠けはありません"}</text>`;
  }).join("")}
  <text x="28" y="${96 + 3 * 146 + 20}" font-size="12" fill="#64748b">図: tmp-map-realpro.png ／ tmp-map-itandi.png ／ tmp-map-reins.png　（作り直す: npx tsx --env-file=.env.local scripts/site-maps.ts）</text>
</svg>`;
    writeFileSync("tmp-map-index.svg", svg, "utf8");
    console.log("\n■ 索引 → tmp-map-index.svg");
  }
})();
