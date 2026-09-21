// 「一度送った物件を次から出さない」が作れるか — 材料の埋まり具合を日別で見る（読み取りのみ）
//
// 2026-09-21 竹内「拡張ツールで物件出した事あるのは出さないようにできるか？
//   物件一括で検索して送るAIXボタン押した／11:00と17:00の部分も
//   一度共有した物件を除いてLINEに送ることが出来ればかなり質高くなる」
//
// ⚠ 先に設計知見を引いた結果、順番が決まっている:
//   「入れ物があることと埋まっていることは別 — 既存の列の埋まり具合を先に測る」
//   「記録の経路は API 側だけ見ても分からない — 呼び出し元が値を渡しているかを実データで確かめる」
//   「直した効果は日別の時系列で確かめる — 全体の率は過去の分で薄まる」
//   → **除外を作る前に「誰に何を送ったか」が引けるかを測る**。引けなければ除外は作れない。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-sent-prop-recent.ts
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const DAYS = Number(process.env.DAYS ?? 21);
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const jst = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);

async function page(table: string, select: string, days: number) {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 60; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte("sent_at", new Date(Date.now() - days * 86400_000).toISOString())
      .order("sent_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const rows = await page("sent_properties",
    "id, source, property_name, room_no, conversation_id, property_customer_id, rent, property_url, sent_at", DAYS);
  console.log(`=== sent_properties 直近${DAYS}日 ${rows.length}件 ===\n`);

  // ① 日別 × 経路 の紐付き率（「直した効果は日別で見る」）
  console.log(`=== ① 日別 — 「誰に送ったか」が残っている率 ===`);
  console.log(`   日付        全件   line_group（拡張→LINEグループ）      その他の経路`);
  const byDay = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) byDay.set(jst(String(r.sent_at)), [...(byDay.get(jst(String(r.sent_at))) ?? []), r]);
  for (const [d, list] of [...byDay.entries()].sort()) {
    const lg = list.filter((r) => String(r.source ?? "") === "line_group");
    const ot = list.filter((r) => String(r.source ?? "") !== "line_group");
    const linked = (a: Array<Record<string, unknown>>) => a.filter((r) => r.conversation_id || r.property_customer_id).length;
    console.log(`   ${d}  ${String(list.length).padStart(5)}   ${String(lg.length).padStart(5)}件 ${pct(linked(lg), lg.length).padStart(7)}`
      + `              ${String(ot.length).padStart(4)}件 ${pct(linked(ot), ot.length).padStart(7)}`);
  }

  // ② 除外に使える形で埋まっているか（名前だけでは足りない — 号室まで要る）
  console.log(`\n=== ② 除外の鍵になる列 ===`);
  const linkedRows = rows.filter((r) => r.conversation_id || r.property_customer_id);
  const has = (a: Array<Record<string, unknown>>, k: string) => a.filter((r) => {
    const v = r[k]; return v !== null && v !== undefined && String(v).trim() !== "";
  }).length;
  console.log(`   誰に送ったか分かる行: ${linkedRows.length}件 / ${rows.length}件（${pct(linkedRows.length, rows.length)}）`);
  for (const k of ["property_name", "room_no", "rent", "property_url"]) {
    console.log(`     ${k.padEnd(16)} ${String(has(linkedRows, k)).padStart(5)}件（${pct(has(linkedRows, k), linkedRows.length)}）`);
  }

  // ③ 実際に同じ物件が同じ相手に2回以上送られているか（＝竹内さんの困りごとの実測）
  console.log(`\n=== ③ 同じ相手に同じ物件を2回以上送っているか（除外の効き目の見積もり）===`);
  const key = (r: Record<string, unknown>) =>
    `${String(r.conversation_id ?? r.property_customer_id ?? "")}|${String(r.property_name ?? "").trim()}|${String(r.room_no ?? "").trim()}`;
  const seen = new Map<string, number>();
  for (const r of linkedRows) {
    if (!String(r.property_name ?? "").trim()) continue;
    seen.set(key(r), (seen.get(key(r)) ?? 0) + 1);
  }
  const dup = [...seen.entries()].filter(([, n]) => n >= 2);
  const dupSends = dup.reduce((a, [, n]) => a + (n - 1), 0);
  console.log(`   相手×物件の組 ${seen.size}件 ／ 2回以上送った組 **${dup.length}件**（${pct(dup.length, seen.size)}）`);
  console.log(`   ＝ 除外できれば減らせる送信 **${dupSends}件**（${pct(dupSends, linkedRows.length)}）`);
  for (const [k, n] of dup.sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    const [, name, room] = k.split("|");
    console.log(`     ${n}回  ${name}${room ? ` ${room}` : ""}`);
  }

  // ③' 再送までの間隔（除外の期間を決める材料）
  //    「古い物は募集状況が変わるので送り直す価値がある」なら間隔が開いた再送が多いはず。
  console.log(`\n=== ③' 同じ物件を送り直すまでの間隔 ===`);
  {
    const byKey = new Map<string, number[]>();
    for (const r of linkedRows) {
      if (!String(r.property_name ?? "").trim()) continue;
      const t = Date.parse(String(r.sent_at));
      if (Number.isNaN(t)) continue;
      byKey.set(key(r), [...(byKey.get(key(r)) ?? []), t]);
    }
    const gaps: number[] = [];
    for (const ts of byKey.values()) {
      if (ts.length < 2) continue;
      ts.sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 3600_000);
    }
    if (gaps.length === 0) { console.log(`   再送が1件も無い`); }
    else {
      const B: Array<[string, number, number]> = [
        ["1時間以内", 0, 1], ["1〜24時間", 1, 24], ["1〜3日", 24, 72],
        ["3〜7日", 72, 168], ["1〜2週", 168, 336], ["2週〜", 336, Infinity],
      ];
      for (const [label, lo, hi] of B) {
        const n = gaps.filter((g) => g >= lo && g < hi).length;
        if (n) console.log(`   ${label.padEnd(10)} ${String(n).padStart(4)}件（${pct(n, gaps.length)}）`);
      }
      console.log(`   ＝ 再送 ${gaps.length}件。**1時間以内が多いなら同じ送信の重複**（除外の対象は同じ送信内にもある）`);
    }
  }

  // ④ 会話単位で「過去に送った物件を引けるか」（読み取り側・書き込み率とは別に測る）
  console.log(`\n=== ④ 会話単位で過去の送付を引けるか ===`);
  const convs = new Map<string, number>();
  for (const r of linkedRows) {
    const c = String(r.conversation_id ?? "");
    if (c) convs.set(c, (convs.get(c) ?? 0) + 1);
  }
  const multi = [...convs.values()].filter((n) => n >= 2).length;
  console.log(`   物件が1件でも紐付く会話 ${convs.size}件 ／ 2件以上ある会話 ${multi}件（${pct(multi, convs.size)}）`);
  console.log(`   ＝ 2件以上ある会話では「前に送った物件」を引いて除外できる`);
}
main().catch((e) => { console.error(e); process.exit(1); });
