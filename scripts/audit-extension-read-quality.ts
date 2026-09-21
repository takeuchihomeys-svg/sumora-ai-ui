// 拡張ツールが検索結果から物件をちゃんと読み取れているか（読み取りのみ）
//
// 2026-09-21 竹内「あとちゃんと物件を読み取ることできてるんかな？拡張ツールで物件検索するさい」
//
// 見るのは property_candidate_pools（拡張が LINE 送信と同時に記録している候補）。
// ここに入る name / rent / floor_plan / walk_minutes / ad_months は
// chrome-extension/bulk-dl.js の buildPropertyData が検索結果の DOM から作っている。
//
// 判定の軸:
//   ① 取れているか（列ごとの埋まり具合）
//   ② 名前が物件名として使える形か（UI の文字・断片・「物件」等の既定値が混ざっていないか）
//   ③ 同じ建物の表記が安定しているか（ゆれが多い＝抽出が不安定）
//   ④ 値が正しそうか（家賃の桁・徒歩分数の範囲）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-extension-read-quality.ts
import { createClient } from "@supabase/supabase-js";
import { normalizePropertyName } from "../app/lib/property-name-match";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 60);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

type Cand = {
  rank?: number; name?: string; rent?: number | null;
  floor_plan?: string | null; walk_minutes?: number | null; ad_months?: number | null;
};

/** 物件名ではない疑いがある形 */
const UI_WORDS = ["詳細", "お気に入り", "印刷", "PDF", "選択", "チェック", "検索", "一覧", "次へ", "前へ", "並び替え", "図面", "地図", "問合", "問い合わせ"];

async function main() {
  const rows: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 40; p++) {
    const { data, error } = await sb.from("property_candidate_pools")
      .select("site, property_customer_id, candidates, sent_at")
      .gte("sent_at", new Date(Date.now() - DAYS * 86400_000).toISOString())
      .order("sent_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; rows.push(...r); if (r.length < 1000) break;
  }
  const all: Array<Cand & { site: string }> = [];
  for (const row of rows) {
    const site = String(row.site ?? "(なし)");
    for (const c of ((row.candidates ?? []) as Cand[])) all.push({ ...c, site });
  }
  console.log(`=== 直近${DAYS}日 送信${rows.length}回 / 物件 ${all.length}件 ===\n`);

  // ① 列ごとの埋まり具合（サイト別）
  console.log(`=== ① 何が取れているか（サイト別）===`);
  const sites = [...new Set(all.map((c) => c.site))];
  const filled = (list: Cand[], f: (c: Cand) => unknown) => list.filter((c) => {
    const v = f(c); return v !== null && v !== undefined && String(v).trim() !== "";
  }).length;
  console.log(`   サイト        件数   物件名    家賃    間取り   徒歩    AD`);
  for (const s of sites) {
    const list = all.filter((c) => c.site === s);
    console.log(`   ${s.padEnd(12)} ${String(list.length).padStart(6)}  `
      + `${pct(filled(list, (c) => c.name), list.length).padStart(6)}  `
      + `${pct(filled(list, (c) => c.rent), list.length).padStart(6)}  `
      + `${pct(filled(list, (c) => c.floor_plan), list.length).padStart(6)}  `
      + `${pct(filled(list, (c) => c.walk_minutes), list.length).padStart(6)}  `
      + `${pct(filled(list, (c) => c.ad_months), list.length).padStart(6)}`);
  }

  // ② 名前が物件名として使える形か
  console.log(`\n=== ② 物件名の質 ===`);
  const names = all.map((c) => String(c.name ?? "").trim());
  const empty = names.filter((n) => !n).length;
  const placeholder = names.filter((n) => n === "物件").length;
  const numeric = names.filter((n) => n && /^[\d\s,，.円万]+$/.test(n)).length;
  const uiLike = names.filter((n) => n && UI_WORDS.some((w) => n.includes(w))).length;
  const tooShort = names.filter((n) => n && n.length <= 2 && n !== "物件").length;
  const tooLong = names.filter((n) => n.length >= 40).length;
  const hasNo = names.filter((n) => /^【\s*\d+/.test(n)).length;
  const ok = names.length - empty - placeholder - numeric - uiLike - tooLong - hasNo;
  console.log(`   物件名として問題なさそう  ${String(ok).padStart(6)}件（${pct(ok, names.length)}）`);
  console.log(`   ─ 怪しい分 ─`);
  console.log(`     空                      ${String(empty).padStart(6)}件（${pct(empty, names.length)}）`);
  console.log(`     「物件」（既定値）       ${String(placeholder).padStart(6)}件（${pct(placeholder, names.length)}）← 名前を取れなかった`);
  console.log(`     数字・金額だけ           ${String(numeric).padStart(6)}件（${pct(numeric, names.length)}）`);
  console.log(`     画面の文字が混ざる       ${String(uiLike).padStart(6)}件（${pct(uiLike, names.length)}）`);
  console.log(`     40字以上                 ${String(tooLong).padStart(6)}件（${pct(tooLong, names.length)}）`);
  console.log(`     先頭に【N】が残る        ${String(hasNo).padStart(6)}件（${pct(hasNo, names.length)}）`);
  console.log(`     2文字以下（参考）        ${String(tooShort).padStart(6)}件（${pct(tooShort, names.length)}）`);

  const weird = names.filter((n) => n && (n === "物件" || /^[\d\s,，.円万]+$/.test(n) || UI_WORDS.some((w) => n.includes(w)) || n.length >= 40));
  if (weird.length) {
    console.log(`\n   ─ 怪しい名前の実物（目で読む）─`);
    for (const n of [...new Set(weird)].slice(0, 15)) console.log(`     「${n}」`);
  }

  // ③ 同じ建物の表記が安定しているか
  console.log(`\n=== ③ 同じ建物の書き方がぶれていないか ===`);
  const byNorm = new Map<string, Set<string>>();
  for (const n of names) {
    if (!n || n === "物件") continue;
    const k = normalizePropertyName(n);
    if (!k) continue;
    byNorm.set(k, (byNorm.get(k) ?? new Set()).add(n));
  }
  const varied = [...byNorm.entries()].filter(([, s]) => s.size >= 2);
  console.log(`   建物 ${byNorm.size}種類 ／ 書き方が2通り以上ある建物 ${varied.length}種類（${pct(varied.length, byNorm.size)}）`);
  console.log(`   ※ 空白・記号だけの違いは正規化で吸収されるので、除外の判定には影響しない`);
  for (const [, s] of varied.slice(0, 6)) console.log(`     ${[...s].map((x) => `「${x}」`).join(" / ")}`);

  // ④ 値が正しそうか
  console.log(`\n=== ④ 取れている値が正しそうか ===`);
  const rents = all.map((c) => c.rent).filter((r): r is number => typeof r === "number" && r > 0);
  if (rents.length === 0) console.log(`   家賃: **1件も取れていない**`);
  else {
    rents.sort((a, b) => a - b);
    const bad = rents.filter((r) => r < 20000 || r > 500000);
    console.log(`   家賃 ${rents.length}件: 最小 ${rents[0].toLocaleString()}円 / 中央 ${rents[Math.floor(rents.length / 2)].toLocaleString()}円 / 最大 ${rents[rents.length - 1].toLocaleString()}円`);
    console.log(`     2万円未満・50万円超（ありえない値） ${bad.length}件（${pct(bad.length, rents.length)}）`);
    if (bad.length) console.log(`     例: ${bad.slice(0, 8).map((r) => r.toLocaleString() + "円").join(" / ")}`);
  }
  const walks = all.map((c) => c.walk_minutes).filter((w): w is number => typeof w === "number");
  console.log(`   徒歩分数 ${walks.length}件` + (walks.length ? `: 最小 ${Math.min(...walks)} / 最大 ${Math.max(...walks)}` : "  ← **1件も取れていない**"));
  const ads = all.map((c) => c.ad_months).filter((a): a is number => typeof a === "number");
  if (ads.length) {
    const badAd = ads.filter((a) => a < 0 || a > 6);
    console.log(`   AD ${ads.length}件: ${[...new Set(ads)].sort((a, b) => a - b).join(" / ")}ヶ月`
      + (badAd.length ? `  ⚠ ありえない値 ${badAd.length}件` : ""));
  }
  const plans = all.map((c) => String(c.floor_plan ?? "").trim()).filter(Boolean);
  const planCount = new Map<string, number>();
  for (const p of plans) planCount.set(p, (planCount.get(p) ?? 0) + 1);
  console.log(`   間取り ${plans.length}件: ${[...planCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([p, c]) => `${p}(${c})`).join(" / ")}`);
  const badPlan = [...planCount.entries()].filter(([p]) => !/^[1-9](R|K|DK|LDK|SK|SDK|SLDK)$/.test(p));
  if (badPlan.length) {
    console.log(`   ⚠ 間取りらしくない値 ${badPlan.length}種類: ${badPlan.slice(0, 8).map(([p, c]) => `「${p}」(${c})`).join(" / ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
