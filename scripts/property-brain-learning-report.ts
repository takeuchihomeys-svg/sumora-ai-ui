// scripts/property-brain-learning-report.ts — 物件検索ブレインの「知識が積み重なっているか」の報告（読むだけ・LLM なし・DB に書かない）
// 実行: npx tsx --env-file=.env.local scripts/property-brain-learning-report.ts [--days=7]
//
// 2026-10-02 竹内「物件検索のところちゃんと知識積み重なるようになっているのか」。
//   見る物: ①経路ごとに「書いた（今週・全部・最後）」と「読む所（コード）」 ②部屋の条件の項目の埋まり方 ③相場のセル（言える数字＝10件以上）
//           ④スタッフの選択とブレインの並べ方の一致（正解＝スタッフが選んで送った事実・feedback_property_selection_label）
//           ⑤週1回の学習（scoring_learning_runs・scoring_pref_learning_runs）の結果 ⑥整理（統合・退役・食い違い）
//   「読む所」はコードの中の参照（grep）で数える＝書いているのに誰も読まない（静かに壊れる）を見つけるため。
import { createClient } from "@supabase/supabase-js";
import { execSync } from "child_process";
import { RENT_EXPLAIN_RULE } from "../app/lib/area-rent-explain";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=7").split("=")[1]) || 7;
const since = new Date(Date.now() - days * 86400_000).toISOString();
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");

/** コードの中でこの表を読んでいる所（scripts・テスト・migrate-schema は数えない） */
function readers(table: string): string[] {
  try {
    const out = execSync(`git grep -l "from(\\"${table}\\")" -- app chrome-extension`, { encoding: "utf8" });
    return out.split("\n").filter((f) => f && !/__tests__|migrate-schema/.test(f));
  } catch { return []; }
}

async function count(table: string, filter?: (q: any) => any): Promise<number | null> {
  let q = db.from(table).select("*", { count: "exact", head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  return error ? null : n ?? 0;
}
async function last(table: string, col = "created_at"): Promise<string | null> {
  const { data, error } = await db.from(table).select(col).order(col, { ascending: false }).limit(1);
  if (error || !data?.length) return null;
  return String((data[0] as unknown as Record<string, unknown>)[col] ?? "").slice(0, 16);
}

/** 経路の一覧（表・何の知識か・日付の列） */
const PATHS: Array<{ table: string; what: string; col?: string }> = [
  { table: "rent_observations", what: "相場の材料（検索で見つかった部屋・届けた部屋）", col: "last_seen_at" },
  { table: "property_candidate_pools", what: "検索で見つかった候補の束", col: "sent_at" },
  { table: "property_pickups", what: "売上サポの判定とスタッフの選択（status=sent）" },
  { table: "property_brain_judgments", what: "ブレインの判定（点・札）" },
  { table: "recommendation_snapshots", what: "🌟を送った時点の候補" },
  { table: "property_selection_patterns", what: "物件オススメで選んだ物・選ばなかった物" },
  { table: "property_condition_history", what: "条件の言い直し（エリア・間取り・家賃…）" },
  { table: "station_map", what: "地名→駅の学習（拡張が読む）" },
  { table: "region_map", what: "地名→区の学習" },
  { table: "property_search_knowledge", what: "整理済みの物件検索の知識" },
  { table: "scoring_learning_runs", what: "週1回の点の学習の記録" },
  { table: "scoring_weights", what: "採用された点の表" },
  { table: "scoring_pref_learning_runs", what: "お客様ごとのこだわりの学習の記録" },
  { table: "scoring_pref_weights", what: "採用されたこだわりの倍率" },
];

(async () => {
  console.log(`=== 物件検索ブレインの知識の積み重なり（直近${days}日・${new Date().toISOString().slice(0, 16)}）===\n`);
  console.log("■ ① 経路（書いた件数・最後・コードの参照）");
  for (const p of PATHS) {
    const col = p.col ?? "created_at";
    const all = await count(p.table);
    const week = all == null ? null : await count(p.table, (q) => q.gte(col, since));
    const lastAt = all ? await last(p.table, col) : null;
    const rd = readers(p.table);
    const flag = all == null ? "（表が読めない）" : all === 0 ? "【空】" : week === 0 ? "【今週増えていない】" : "";
    const rflag = rd.length === 0 ? "【どこからも使われていない】" : "";
    console.log(`  ${p.table}（${p.what}）: 全 ${all ?? "?"}・今週 +${week ?? "?"}・最後 ${lastAt ?? "-"}・コードの参照 ${rd.length}（書く所も含む）${flag}${rflag}`);
  }

  console.log("\n■ ② 部屋の条件の項目の埋まり方（property_pickups＝資料から読んだ物）");
  {
    const rows: any[] = [];
    for (let from = 0; from < 50000; from += 1000) {
      const { data } = await db.from("property_pickups").select("created_at, status, terms, equipment, ad_yen, location, summary_text").range(from, from + 999);
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const week = rows.filter((r) => r.created_at >= since);
    const fields: Array<[string, (r: any) => boolean]> = [
      ["区", (r) => !!r.location?.ward], ["駅・徒歩", (r) => !!r.location?.stations?.length], ["面積", (r) => /㎡/.test(r.summary_text ?? "")],
      ["築年", (r) => r.terms?.buildingAge != null], ["敷金", (r) => r.terms?.deposit != null], ["礼金", (r) => r.terms?.keyMoney != null],
      ["所在階", (r) => r.equipment?.floor != null], ["構造", (r) => !!r.equipment?.facts?.structure], ["オートロック", (r) => !!r.equipment?.facts?.autolock],
      ["バストイレ別", (r) => !!r.equipment?.facts?.bath_toilet], ["独立洗面", (r) => !!r.equipment?.facts?.washbasin], ["宅配BOX", (r) => !!r.equipment?.facts?.delivery_box],
      ["ペット", (r) => !!r.equipment?.facts?.pet], ["AD（社内）", (r) => r.ad_yen != null],
    ];
    console.log(`  行: 全 ${rows.length}（スタッフが送った ${rows.filter((r) => r.status === "sent").length}）・今週 ${week.length}`);
    console.log("  " + fields.map(([k, f]) => `${k} ${pct(rows.filter(f).length, rows.length)}`).join("・"));
  }

  console.log("\n■ ③ 相場のセル（区×間取り・管理費込み・期間で切らない）");
  {
    const { data } = await db.rpc("area_rent_stats", { p_branch: "osaka" });
    const cells = (data ?? []) as Array<{ ward: string; plan_group: string; n: number; n_sent: number }>;
    const sayable = cells.filter((c) => c.n >= RENT_EXPLAIN_RULE.minCount);
    const nObs = await count("rent_observations");
    const nWeek = await count("rent_observations", (q) => q.gte("first_seen_at", since));
    const nSent = await count("rent_observations", (q) => q.eq("sent_to_customer", true));
    const nPet = await count("rent_observations", (q) => q.not("pet", "is", null));
    console.log(`  部屋 ${nObs}（今週の新しい部屋 +${nWeek}・届けた ${nSent}・ペット可否が分かる ${nPet}）・セル ${cells.length}・言える（${RENT_EXPLAIN_RULE.minCount}件以上）${sayable.length}`);
    const top = sayable.sort((a, b) => b.n - a.n).slice(0, 8).map((c) => `${c.ward.replace(/^大阪市/, "")}${c.plan_group}:${c.n}`);
    if (top.length) console.log(`  多いセル: ${top.join("・")}`);
  }

  console.log("\n■ ④ スタッフの選択とブレインの並べ方（売上サポの1回＝batch・選んだ物＝status sent）");
  {
    const rows: any[] = [];
    for (let from = 0; from < 50000; from += 1000) {
      const { data } = await db.from("property_pickups").select("batch_id, status, score, recommended, created_at").not("batch_id", "is", null).range(from, from + 999);
      if (!data?.length) break;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const by = new Map<string, any[]>();
    for (const r of rows) { const a = by.get(r.batch_id) ?? []; a.push(r); by.set(r.batch_id, a); }
    let batches = 0, top1 = 0, top3 = 0, rand1 = 0, rand3 = 0, star = 0, chosen = 0, weekBatches = 0;
    for (const [, rs] of by) {
      const sent = rs.filter((r) => r.status === "sent");
      if (!sent.length || rs.length < 2) continue;
      batches++;
      if (rs.some((r) => r.created_at >= since)) weekBatches++;
      const sorted = [...rs].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const rankOf = (r: any) => 1 + sorted.filter((x) => (x.score ?? 0) > (r.score ?? 0)).length;
      for (const s of sent) {
        chosen++;
        const rk = rankOf(s);
        if (rk === 1) top1++;
        if (rk <= 3) top3++;
        if ((s.recommended ?? 0) > 0) star++;
      }
      rand1 += sent.length * (1 / rs.length);
      rand3 += sent.length * Math.min(1, 3 / rs.length);
    }
    console.log(`  比べられる回 ${batches}（今週 ${weekBatches}）・選んだ物 ${chosen}`);
    console.log(`  点の1位に入った ${pct(top1, chosen)}（ランダムなら ${pct(rand1, chosen)}）・3位以内 ${pct(top3, chosen)}（ランダム ${pct(rand3, chosen)}）・ブレインの🌟と一致 ${pct(star, chosen)}`);
  }

  console.log("\n■ ⑤ 週1回の学習");
  {
    const { data: runs } = await db.from("scoring_learning_runs").select("created_at, episodes_total, counts, metrics, active_version").order("created_at", { ascending: false }).limit(1);
    const r = runs?.[0] as any;
    if (r) {
      const m = r.metrics?.holdout ?? r.metrics?.all ?? {};
      console.log(`  点の学習: 最後 ${String(r.created_at).slice(0, 16)}・回 ${r.episodes_total}（売上サポ ${r.counts?.episodes_pickup ?? "?"}・🌟 ${r.counts?.episodes_snapshot ?? "?"}・拡張 ${r.counts?.episodes_pool ?? "?"}）・採用の版 ${r.active_version}・holdout 1位 ${m.top1 ?? "?"}（ランダム ${m.randTop1 ?? "?"}）`);
      if ((r.counts?.episodes_pickup ?? 0) === 0 && (r.counts?.pickup_rows ?? 0) > 0) console.log(`  【売上サポの行 ${r.counts.pickup_rows} から回が0】`);
    } else console.log("  点の学習: 記録なし【空】");
    const pr = await count("scoring_pref_learning_runs");
    console.log(`  こだわりの学習: 記録 ${pr ?? "?"}回${pr === 0 ? "【一度も動いていない】" : ""}`);
  }

  console.log("\n■ ⑥ 整理（統合・退役・食い違い）");
  {
    const all = await count("property_search_knowledge");
    console.log(`  property_search_knowledge: ${all ?? "?"}行（整理の流れは手順5で作る。今は数だけ）`);
  }
})();
