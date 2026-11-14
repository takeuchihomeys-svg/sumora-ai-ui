/**
 * 竹内さんが指摘した5つの動きが、録画から学べているかを1件ずつ確かめる（2026-11-14）
 *
 *   竹内さん「今最新の録画とったので
 *     家賃のプルダウンの部分のマウスのうごきとクリックして選択する動き
 *     徒歩の部分プルダウンで選択してそのままにしているうごき
 *     更新日のプルダウンをマウスで動かしてクリックするうごき
 *     次へを押す場所もちゃんと把握するようにする
 *     送付済みの物件は通常モードのように送付済みと把握するようにする
 *     そうして自動モードでも送付済みは送らなくても大丈夫なように理解しておく」
 *
 * ⚠ 「仕組みがある」と「実際に学べている」は別。**実データで確かめる**。
 *
 * 実行: npx tsx --env-file=.env.local scripts/audit-5-moves.ts
 *       npx tsx --env-file=.env.local scripts/audit-5-moves.ts --days=1
 */
import { supabase } from "../app/lib/supabase-server";

const args = process.argv.slice(2);
const days = Number((args.find((a) => a.startsWith("--days=")) || "").replace("--days=", "")) || 1;

type Row = {
  created_at?: string;
  ext_version?: string | null;
  mode?: string | null;
  ops?: number | null;
  points_n?: number | null;
  point_fields?: Record<string, unknown> | null;
  field_order?: unknown;
  shot_ops?: unknown;
  shot_w?: number | null;
};

const MARKS = {
  "1. 家賃のプルダウン（マウス移動→クリック選択）": ["rental_cost1", "rental_cost2"],
  "2. 徒歩のプルダウン（選択して保持）": ["transportation_id", "required_time"],
  "3. 更新日のプルダウン（マウス→クリック）": ["update_date"],
  "4. 次へ（押す場所）": ["左の次", "pager", "次のページ", "next"],
  "5. 送付済みの把握": [],   // 別の表で確かめる
};

void (async () => {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const { data, error } = await supabase
    .from("human_motion_learn")
    .select("created_at, ext_version, mode, ops, points_n, point_fields, field_order, shot_ops, shot_w")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) { console.log("読めません:", error.message); process.exitCode = 1; return; }
  const rows = (data ?? []) as Row[];

  // 押した欄の名前を全部集める（point_fields と field_order の両方から）
  const names: Record<string, number> = {};
  const orders: string[][] = [];
  for (const r of rows) {
    const pf = r.point_fields && typeof r.point_fields === "object" ? Object.keys(r.point_fields) : [];
    for (const n of pf) names[n] = (names[n] ?? 0) + 1;
    const fo = Array.isArray(r.field_order) ? (r.field_order as unknown[]).map(String).filter(Boolean) : [];
    if (fo.length) orders.push(fo);
    for (const n of fo) names[n] = (names[n] ?? 0) + 1;
  }

  const byVer: Record<string, number> = {};
  for (const r of rows) byVer[String(r.ext_version ?? "(空)")] = (byVer[String(r.ext_version ?? "(空)")] ?? 0) + 1;
  const withRealOps = rows.filter((r) => Array.isArray(r.shot_ops) && (r.shot_ops as unknown[]).some((o) => {
    const k = String((o as Record<string, unknown>)?.k ?? "");
    return k !== "diag" && k !== "same";
  })).length;
  const widths: Record<string, number> = {};
  for (const r of rows) if (r.shot_w) widths[String(r.shot_w)] = (widths[String(r.shot_w)] ?? 0) + 1;

  console.log(`録画の記録（直近 ${days}日）: ${rows.length}件`);
  console.log(`  版: ${JSON.stringify(byVer)}`);
  console.log(`  写真の幅: ${JSON.stringify(widths)}`);
  console.log(`  本物の操作あり: ${withRealOps}件`);
  console.log(`  押した欄の種類: ${Object.keys(names).length}種類`);

  console.log("\n■ 5つの動き（実データで確かめる）");
  const label = { ok: "✅", part: "🔶", ng: "❌" } as const;
  const results: Array<{ t: string; m: "ok" | "part" | "ng"; p: string }> = [];
  for (const [title, keys] of Object.entries(MARKS)) {
    if (!keys.length) continue;
    const hit = keys.filter((k) => Object.keys(names).some((n) => n.includes(k)));
    const cnt = hit.reduce((a, k) => a + Object.entries(names).filter(([n]) => n.includes(k)).reduce((b, [, v]) => b + v, 0), 0);
    const m = hit.length >= keys.length ? "ok" : hit.length ? "part" : "ng";
    results.push({ t: title, m, p: hit.length ? `見つかった欄: ${hit.join("・")}（${cnt}回）` : `見つかりません（探した名前: ${keys.join("・")}）` });
  }

  // 5. 送付済み（別の表）
  {
    const sp = await supabase.from("sent_properties").select("id", { count: "exact", head: true });
    const n = sp.error ? null : (sp.count ?? 0);
    results.push({
      t: "5. 送付済みの把握",
      m: n && n > 0 ? "ok" : "ng",
      p: n == null ? "読めません" : `送付済みの記録 ${n}件（自動モードでも _loadSentRooms で読む・号室が同じ行は選ばない）`,
    });
  }

  for (const r of results) {
    console.log(`${label[r.m]} ${r.t}`);
    console.log(`     ${r.p}`);
  }

  // 順番（押した順）が取れているか
  console.log("\n■ 押した順番（field_order）");
  const okOrders = orders.filter((o) => o.length >= 2);
  console.log(`  順番あり: ${orders.length}件／うち2手以上: ${okOrders.length}件`);
  for (const o of okOrders.slice(0, 3)) console.log(`    ${o.slice(0, 8).join(" → ")}`);
  if (!okOrders.length) console.log("  ⚠ 順番が取れていません（名前は取れているのに順番が空）");

  const ng = results.filter((r) => r.m === "ng").length;
  const part = results.filter((r) => r.m === "part").length;
  const ok = results.filter((r) => r.m === "ok").length;
  console.log(`\n✅ ${ok} ／ 🔶 ${part} ／ ❌ ${ng}`);
  if (part || ng) console.log("🔶/❌ は『名前が取れていない』＝録画がその操作を拾えていない所です。");
})();
