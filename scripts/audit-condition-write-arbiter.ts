// scripts/audit-condition-write-arbiter.ts
// 条件の自動の書き込み（property_condition_history）の当たりと、取り合いの止め（condition-write-arbiter.ts）を過去の履歴に当てる（読むだけ・LLM なし・費用0・DB に書かない）。
//
// 2026-11-15 作業員K（竹内さん 11/15「お客さんの最新の条件を具体的に判断して…AIX ツールが判断して更新」の頼み4）:
//   ① 書き手 × 欄ごとに: 自動で書いた数／14日以内にスタッフが画面で同じ欄を直した数（＝誤りの目安）／別の自動の書き手が前の値に戻した数（取り合い）
//   ② 止めを当てると何行止まるか（書き手の組ごと）。人の直し（screen_edit）と今回だけの戻し（scope 等）は1行も止めないこと
// 出力は数と条件の値の頭だけ（お客様は id の先頭6文字）。会話の文は出さない。
//
// 実行: npx tsx --env-file=.env.local scripts/audit-condition-write-arbiter.ts [--days=30] [--show=10]
import { createClient } from "@supabase/supabase-js";
import { arbitrateField, AUTO_WRITERS, type HistoryRowLike } from "../app/lib/condition-write-arbiter";

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), "1"]; }));
const DAYS = parseInt(String(args.days ?? "30"), 10);
const SHOW = parseInt(String(args.show ?? "10"), 10);
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type Row = HistoryRowLike & { property_customer_id: string };
const D = 864e5;
const writerOf = (s: string | null) => String(s ?? "(none)").split(":")[0];

(async () => {
  const since = new Date(Date.now() - (DAYS + 14) * D).toISOString();
  let rows: Row[] = [];
  for (let p = 0; p < 30; p++) {
    const { data, error } = await sb.from("property_condition_history").select("property_customer_id, changed_field, old_value, new_value, source_message_id, created_at")
      .gte("created_at", since).order("created_at").range(p * 1000, p * 1000 + 999);
    if (error) throw new Error(error.message);
    rows = rows.concat((data ?? []) as Row[]);
    if (!data || data.length < 1000) break;
  }
  const ids = [...new Set(rows.map((r) => String(r.source_message_id ?? "").split(":")[1] ?? "").filter((x) => /^[0-9a-f-]{36}$/i.test(x)))];
  const at = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await sb.from("messages").select("id, created_at").in("id", ids.slice(i, i + 150));
    for (const m of (data ?? []) as Array<{ id: string; created_at: string }>) at.set(m.id, m.created_at);
  }
  const byPc = new Map<string, Row[]>();
  for (const r of rows) { const k = r.property_customer_id; if (!byPc.has(k)) byPc.set(k, []); byPc.get(k)!.push(r); }
  const from = Date.now() - DAYS * D;
  const target = rows.filter((r) => Date.parse(r.created_at) >= from);

  // ① 書き手 × 欄
  const tab = new Map<string, { n: number; human: number; revert: number }>();
  for (const r of target) {
    const w = writerOf(r.source_message_id);
    if (!(AUTO_WRITERS as readonly string[]).includes(w)) continue;
    const k = `${w}\t${r.changed_field}`;
    const e = tab.get(k) ?? { n: 0, human: 0, revert: 0 }; e.n++;
    const later = (byPc.get(r.property_customer_id) ?? []).filter((x) => x.changed_field === r.changed_field && x.created_at > r.created_at && Date.parse(x.created_at) - Date.parse(r.created_at) <= 14 * D);
    if (later.some((x) => writerOf(x.source_message_id) === "screen_edit")) e.human++;
    if (later.some((x) => (AUTO_WRITERS as readonly string[]).includes(writerOf(x.source_message_id)) && writerOf(x.source_message_id) !== w && String(x.new_value ?? "") === String(r.old_value ?? ""))) e.revert++;
    tab.set(k, e);
  }
  console.log(`=== ① 自動の書き込み（${DAYS}日）: 書き手 × 欄 ・ 書いた数 ・ 14日以内に画面で直された ・ 別の自動の書き手が前の値に戻した ===`);
  let tn = 0, th = 0, tr = 0;
  for (const [k, e] of [...tab.entries()].sort((a, b) => b[1].n - a[1].n)) { tn += e.n; th += e.human; tr += e.revert; console.log(`  ${k.replace("\t", " × ").padEnd(32)} ${String(e.n).padStart(3)} ・ 直し ${e.human} ・ 戻し ${e.revert}`); }
  console.log(`  計 ${tn} ・ 直し ${th} ・ 戻し ${tr}`);
  const human = target.filter((r) => writerOf(r.source_message_id) === "screen_edit").length;
  console.log(`  （同じ期間の画面の直し ${human} 行・今回だけの戻し等 ${target.filter((r) => /^(scope|restore|undo)/.test(writerOf(r.source_message_id))).length} 行）`);

  // ② 止めを当てる
  let stopped = 0; const pair = new Map<string, number>(); const ex: string[] = []; let wrongStop = 0;
  for (const r of target) {
    const w = writerOf(r.source_message_id);
    const before = (byPc.get(r.property_customer_id) ?? []).filter((x) => x.created_at < r.created_at);
    const v = arbitrateField({
      field: r.changed_field, current: r.old_value, proposed: r.new_value, writer: w, now: r.created_at, messageId: String(r.source_message_id ?? "").split(":")[1] || null,
      messageAt: at.get(String(r.source_message_id ?? "").split(":")[1] ?? "") ?? null, history: before, messageAtOf: (id) => at.get(id),
    });
    if (v.action !== "skip") continue;
    if (!(AUTO_WRITERS as readonly string[]).includes(w)) wrongStop++;
    stopped++;
    const pk = `${v.reason}｜${v.against?.writer} → ${w}`; pair.set(pk, (pair.get(pk) ?? 0) + 1);
    if (ex.length < SHOW) ex.push(`  ${r.property_customer_id.slice(0, 6)} ${r.changed_field}: ${v.against?.writer} が書いた「${String(r.old_value ?? "∅").slice(0, 24)}」を ${w} が「${String(r.new_value ?? "∅").slice(0, 24)}」に戻す（${Math.round((Date.parse(r.created_at) - Date.parse(v.against!.at)) / 1000)}秒後）`);
  }
  console.log(`\n=== ② 取り合いの止め（CONDITION_WRITE_ARBITER=on）を当てると: 止まる ${stopped} 行／自動の書き込み ${tn} 行 ・ 人の直しと決まった戻しを止めた ${wrongStop} 行 ===`);
  for (const [k, n] of [...pair.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k} ${n}`);
  console.log(ex.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
