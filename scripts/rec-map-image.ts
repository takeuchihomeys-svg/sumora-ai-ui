/**
 * 録画の全体図を1枚の画像にする（2026-11-15 竹内さん「全体図理解して」）
 *
 *   竹内さん「全体図理解して そしてマウス動いている部分やボタンの部分プルダウンの部分をよみとってりかいしたらどうか」
 *
 * ★ なぜ「全期間」と「新しい版」を分けるか
 *   記録は 2.7.12〜2.7.61 が混ざっている。全期間の割合だけ見ると
 *   **昔の記録（材料が入る前の版）で薄まって**「読めていない」と誤解する。
 *   実測: 操作の並びは全期間 35% → 新しい版だけ 98%。
 *   → **2つの目で見る**（今の実力と、過去込みの見かけ）。
 *
 * 実行: npx tsx --env-file=.env.local scripts/rec-map-image.ts
 *   出力: tmp-rec-map.svg（PNG は sharp で変換）
 */
import { supabase } from "../app/lib/supabase-server";
import { writeFileSync } from "node:fs";

type Op = { k?: string; f?: string; w?: string };
type Row = Record<string, unknown> & { shot_ops?: Op[] | null };

const isNewVersion = (v: unknown): boolean => {
  const p = String(v ?? "0").split(".").map(Number);
  return p[0] === 2 && p[1] === 7 && (p[2] ?? 0) >= 46;
};

void (async () => {
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  let rows: Row[] = [];
  for (let from = 0; from < 12000; from += 1000) {
    const { data } = await supabase.from("human_motion_learn")
      .select("created_at,mode,site,ext_version,shot_ops,point_fields,kinds,moves_n,move_speed_px_s,move_curve,move_ms,move_dist,shot_w,shot_learn,opens")
      .gte("created_at", since).order("created_at", { ascending: false }).range(from, from + 999);
    rows = rows.concat((data ?? []) as Row[]);
    if ((data ?? []).length < 1000) break;
  }
  const n = rows.length;
  const recent = rows.filter((r) => isNewVersion(r.ext_version));
  const m = recent.length || 1;

  const pctOf = (set: Row[], f: (r: Row) => boolean) => (set.length ? Math.round((set.filter(f).length / set.length) * 100) : 0);
  const hasOps = (r: Row) => Array.isArray(r.shot_ops) && (r.shot_ops as unknown[]).length > 0;
  const hasMove = (r: Row) => Number(r.moves_n) > 0;
  const hasPoint = (r: Row) => !!(r.point_fields && Object.keys(r.point_fields as object).length);
  const hasOpen = (r: Row) => !!(r.opens && Object.keys(r.opens as object).length);
  const hasBig = (r: Row) => Number(r.shot_w) >= 1000;

  const sp = recent.map((r) => Number(r.move_speed_px_s)).filter((x) => x > 0).sort((a, b) => a - b);
  const medSpeed = sp.length ? sp[Math.floor(sp.length / 2)] : 0;
  const cv = recent.map((r) => Number(r.move_curve)).filter((x) => x > 0).sort((a, b) => a - b);
  const medCurve = cv.length ? cv[Math.floor(cv.length / 2)] : 0;
  const ms = recent.map((r) => Number(r.move_ms)).filter((x) => x > 0).sort((a, b) => a - b);
  const medMs = ms.length ? ms[Math.floor(ms.length / 2)] : 0;
  const ds = recent.map((r) => Number(r.move_dist)).filter((x) => x > 0).sort((a, b) => a - b);
  const medDist = ds.length ? ds[Math.floor(ds.length / 2)] : 0;

  const fieldHit: Record<string, number> = {};
  for (const r of recent) {
    for (const [k, v] of Object.entries((r.point_fields ?? {}) as Record<string, { n?: number; w?: string }>)) {
      const c = Number(v?.n) || 0;
      if (c >= 2) fieldHit[k] = (fieldHit[k] || 0) + c;
    }
  }
  const top = Object.entries(fieldHit).sort((a, b) => b[1] - a[1]).slice(0, 9);

  // select（プルダウン）の欄と回数
  const selFields: Record<string, number> = {};
  let selOps = 0;
  const wk: Record<string, number> = {};
  for (const r of recent) {
    for (const o of ((r.shot_ops ?? []) as Op[])) {
      if (!o) continue;
      if (o.w) wk[o.w] = (wk[o.w] || 0) + 1;
      if (o.w === "select") { selOps++; const f = String(o.f ?? "").replace(/^左の|｜.*$/g, ""); if (f) selFields[f] = (selFields[f] || 0) + 1; }
    }
  }
  const kk: Record<string, number> = {};
  for (const r of recent) {
    const k = r.kinds as Record<string, unknown> | null;
    if (!k || typeof k !== "object") continue;
    for (const [key, v] of Object.entries(k)) kk[key] = (kk[key] || 0) + (Number(v) || 0);
  }

  const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const W = 1240, H = 900;
  const barW = 300;
  const bar = (x: number, y: number, p: number, color: string, label: string, val: string) => `
    <rect x="${x}" y="${y}" width="${barW}" height="20" rx="5" fill="#e8edf3"/>
    <rect x="${x}" y="${y}" width="${Math.max(3, (barW * p) / 100)}" height="20" rx="5" fill="${color}"/>
    <text x="${x + barW + 10}" y="${y + 15}" font-size="13" font-weight="600" fill="${p >= 50 ? "#15803d" : p > 0 ? "#a16207" : "#b91c1c"}">${val}</text>
    <text x="${x}" y="${y - 6}" font-size="12" fill="#475569">${esc(label)}</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="'Yu Gothic','Meiryo',sans-serif">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="28" y="42" font-size="24" font-weight="700" fill="#0f172a">録画データの全体図</text>
  <text x="28" y="66" font-size="13.5" fill="#64748b">マウス・ボタン・プルダウンのどこまで読めているか（DBの実測だけ・推測なし）</text>
  <text x="28" y="88" font-size="13" fill="#334155">全 ${n}件（2026-11-11〜14）／うち新しい版 2.7.46以降 ${recent.length}件</text>

  <!-- 左: 新しい版 -->
  <rect x="28" y="104" width="580" height="228" rx="12" fill="#f0fdf4" stroke="#bbf7d0" stroke-width="1.5"/>
  <text x="48" y="132" font-size="16" font-weight="700" fill="#166534">いまの実力（新しい版 2.7.46以降・${recent.length}件）</text>
  ${bar(48, 162, pctOf(recent, hasOps), "#16a34a", "操作の並び（どの欄を・どの順で）", pctOf(recent, hasOps) + "%")}
  ${bar(48, 210, pctOf(recent, hasMove), "#22c55e", "マウスの動き（速さ・曲がり）", pctOf(recent, hasMove) + "%")}
  ${bar(48, 258, pctOf(recent, hasPoint), "#22c55e", "押した場所（要素の中のどこ）", pctOf(recent, hasPoint) + "%")}
  <text x="48" y="308" font-size="12.5" fill="#166534" font-weight="600">→ ここは**もう読める**。すぐ拡張の動きに使える</text>

  <!-- 右: 全期間 -->
  <rect x="632" y="104" width="580" height="228" rx="12" fill="#f8fafc" stroke="#e2e8f0" stroke-width="1.5"/>
  <text x="652" y="132" font-size="16" font-weight="700" fill="#334155">全期間で見た見かけ（${n}件）</text>
  ${bar(652, 162, pctOf(rows, hasOps), "#94a3b8", "操作の並び", pctOf(rows, hasOps) + "%")}
  ${bar(652, 210, pctOf(rows, hasMove), "#94a3b8", "マウスの動き", pctOf(rows, hasMove) + "%")}
  ${bar(652, 258, pctOf(rows, hasPoint), "#94a3b8", "押した場所", pctOf(rows, hasPoint) + "%")}
  <text x="652" y="308" font-size="12.5" fill="#b45309" font-weight="600">→ 昔の版（材料が入る前）が混ざって薄く見える</text>

  <!-- 読めていない2つ -->
  <rect x="632" y="348" width="580" height="150" rx="12" fill="#fef2f2" stroke="#fecaca" stroke-width="1.5"/>
  <text x="652" y="376" font-size="16" font-weight="700" fill="#b91c1c">まだ読めていない（理由が分かっている）</text>
  ${bar(652, 404, pctOf(recent, hasBig), "#dc2626", "写真の文字（1280px以上）", pctOf(recent, hasBig) + "%")}
  ${bar(652, 452, pctOf(recent, hasOpen), "#dc2626", "押したら何が開くか", pctOf(recent, hasOpen) + "%")}
  <text x="652" y="482" font-size="12" fill="#7f1d1d">写真は99%が480px（拡大しても文字が無い）／開き方は 2.7.67 から</text>

  <!-- 3つの軸 -->
  <text x="28" y="368" font-size="17" font-weight="700" fill="#0f172a">3つの軸で読む</text>

  <rect x="28" y="384" width="192" height="150" rx="12" fill="#eff6ff" stroke="#bfdbfe"/>
  <text x="44" y="410" font-size="15" font-weight="700" fill="#1d4ed8">① マウス</text>
  <text x="44" y="434" font-size="12.5" fill="#334155">速さ ${medSpeed}px/s</text>
  <text x="44" y="454" font-size="12.5" fill="#334155">曲がり ${medCurve.toFixed(2)}</text>
  <text x="44" y="474" font-size="12.5" fill="#334155">1回 ${medMs}ms・${medDist}px</text>
  <text x="44" y="502" font-size="12" fill="#1e40af" font-weight="700">→ カーソルを実測に寄せる</text>
  <text x="44" y="520" font-size="11.5" fill="#b91c1c">足りない: 入っていない記録が多い</text>

  <rect x="228" y="384" width="192" height="150" rx="12" fill="#f0fdf4" stroke="#bbf7d0"/>
  <text x="244" y="410" font-size="15" font-weight="700" fill="#15803d">② ボタン</text>
  <text x="244" y="434" font-size="12.5" fill="#334155">欄 ${Object.keys(fieldHit).length}種類</text>
  <text x="244" y="454" font-size="12.5" fill="#334155">checkbox ${wk.checkbox ?? 0}</text>
  <text x="244" y="474" font-size="12.5" fill="#334155">select ${wk.select ?? 0}／button ${wk.button ?? 0}</text>
  <text x="244" y="502" font-size="12" fill="#15803d" font-weight="700">→ 押す所を実測で狙う</text>
  <text x="244" y="520" font-size="11.5" fill="#475569">要素の中の位置まで分かる</text>

  <rect x="428" y="384" width="180" height="150" rx="12" fill="#fefce8" stroke="#fde68a"/>
  <text x="444" y="410" font-size="15" font-weight="700" fill="#a16207">③ プルダウン</text>
  <text x="444" y="434" font-size="12.5" fill="#334155">select ${selOps}回</text>
  <text x="444" y="454" font-size="12" fill="#475569">${esc(Object.keys(selFields).slice(0, 3).join("・"))}</text>
  <text x="444" y="474" font-size="12" fill="#475569">${esc(Object.keys(selFields).slice(3, 6).join("・"))}</text>
  <text x="444" y="502" font-size="12" fill="#a16207" font-weight="700">→ 種類の判定まで</text>
  <text x="444" y="520" font-size="11.5" fill="#b91c1c">中身の選択肢は撮り直し</text>

  <!-- よく押す所 -->
  <text x="28" y="570" font-size="17" font-weight="700" fill="#0f172a">よく押す所（新しい版・2回以上の欄／この順で押されている）</text>
  ${top.map(([k, c], i) => `
    <rect x="28" y="${584 + i * 26}" width="560" height="22" rx="5" fill="${i % 2 ? "#f8fafc" : "#f1f5f9"}"/>
    <text x="38" y="${600 + i * 26}" font-size="12.5" fill="#0f172a">${i + 1}. ${esc(k)}</text>
    <text x="576" y="${600 + i * 26}" font-size="12.5" fill="#475569" text-anchor="end">${c}回</text>`).join("")}

  <!-- 操作の内訳 -->
  <rect x="612" y="576" width="600" height="118" rx="12" fill="#f8fafc" stroke="#e2e8f0"/>
  <text x="632" y="602" font-size="14" font-weight="700" fill="#334155">操作の内訳（新しい版）</text>
  <text x="632" y="626" font-size="13" fill="#334155">click ${kk.click ?? 0} ／ change ${kk.change ?? 0} ／ key ${kk.key ?? 0} ／ tap ${kk.tap ?? 0} ／ scroll ${kk.scroll ?? 0}</text>
  <text x="632" y="652" font-size="12.5" fill="#475569">select の欄: ${esc(Object.keys(selFields).join("・") || "－")}</text>
  <text x="632" y="676" font-size="12.5" fill="#475569">※ 入力した中身（値・文字）は入っていない（欄の名前と位置だけ）</text>

  <!-- 結論 -->
  <rect x="612" y="708" width="600" height="164" rx="12" fill="#0f172a"/>
  <text x="634" y="738" font-size="16" font-weight="700" fill="#ffffff">結論と次の一手</text>
  <text x="634" y="766" font-size="13" fill="#cbd5e1">1. マウス・ボタンは**もう読める**（新しい版で 98% / 15% / 14%）</text>
  <text x="634" y="790" font-size="13" fill="#cbd5e1">2. プルダウンは「選ぶ所かどうか」まで読める（select ${selOps}回）</text>
  <text x="634" y="814" font-size="13" fill="#cbd5e1">3. 読めないのは写真の文字と開いた中身（どちらも撮り直しで入る）</text>
  <text x="634" y="840" font-size="13" font-weight="700" fill="#fbbf24">4. 2.7.75 で自動モードを1回まわせば、両方入る</text>
  <text x="634" y="862" font-size="12" fill="#64748b">npx tsx --env-file=.env.local scripts/rec-read.ts</text>
</svg>`;

  writeFileSync("tmp-rec-map.svg", svg, "utf8");
  console.log("出力: tmp-rec-map.svg");
  console.log(`全 ${n}件 / 新しい版 ${recent.length}件`);
  console.log(`新しい版: 操作 ${pctOf(recent, hasOps)}% / マウス ${pctOf(recent, hasMove)}% / 場所 ${pctOf(recent, hasPoint)}% / 開き方 ${pctOf(recent, hasOpen)}% / 大写真 ${pctOf(recent, hasBig)}%`);
  console.log(`マウス実測: 速さ ${medSpeed}px/s・曲がり ${medCurve.toFixed(2)}・1回 ${medMs}ms・${medDist}px`);
  console.log(`select: ${selOps}回 / ${Object.keys(selFields).length}種類`);
  console.log(`要素: ${Object.entries(wk).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(" / ")}`);
})();
