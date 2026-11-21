// scripts/audit-combo-unknown-rows.ts — 返信と AIX の組の表（send-combo-table）の「未数え」の行を竹内さん本人の番で数える（読むだけ・LLM なし・費用 0・作業員M・2026-11-22・台帳 #407・#5）
//   ① 結果が手元・悪い知らせ（AIX【物件確認した】の募集終了・申込あり＝check_pattern unavailable）の後、竹内さんは返信で代わりの物件・次の手を足すか（aix_then_reply）／AIX だけか
//      比べに「空いていた（available）」の番も同じ数え方で並べる
//   ② 約束が2つ開いている番（確認＋ピックアップ）で、竹内さんは約束した順に AIX を2つ送るか（aix_then_aix）
//      約束の開きは前の48時間のこちらの通の語（募集状況確認・ピックアップしてお送り）で見る（文は出さない）
//   数える番: 見張りの番（line_watch_turns）のうち、番の後の通が全部 竹内さん本人（messages.staff_writer=takeuchi）。申込以降は外す。
//   本文は出さない（数と会話 id の頭8字だけ）。営業時間（JST 9〜22時）は流さない。
// 実行: npx tsx --env-file=<鍵のある .env> scripts/audit-combo-unknown-rows.ts [--days=120] [--out=<json>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { readWatchTurns } from "./lib/prod-yardstick-db";
import { takeuchiCombo, assignAixKinds, type StaffMove } from "./lib/combo-of-moves";

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const jstHour = (new Date().getUTCHours() + 9) % 24;
if (jstHour >= 9 && jstHour < 22) { console.error("営業時間（JST 9〜22時）は流さない"); process.exit(1); }
const days = Number(arg("days", "120")) || 120;
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const POST_APPLY_RE = /記入欄】|・氏名、フリガナ|申込(?:み)?(?:用)?フォーマット|お申込に必要なご情報|ご本人確認書類として|審査(?:結果|が通|通過しました)/;
const CHECK_PROMISE_RE = /募集状況(?:を)?確認させて|空き(?:状況)?(?:を)?確認させて|確認(?:出来|でき)次第/;
const PICKUP_PROMISE_RE = /ピックアップ(?:して|させて)[^。\n]{0,12}お送り|新たにピックアップ/;

async function main() {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const turns = await readWatchTurns(sb, since);
  const convs = [...new Set(turns.map((t) => t.conversation_id))];
  type M = StaffMove & { text: string };
  const msgs = new Map<string, M[]>();
  for (let i = 0; i < convs.length; i += 50) {
    for (let j = 0; ; j += 1000) {
      const { data, error } = await sb.from("messages").select("conversation_id, created_at, sender, staff_writer, is_aix_generated, text").in("conversation_id", convs.slice(i, i + 50)).gte("created_at", new Date(Date.parse(since) - 2 * 86_400_000).toISOString()).order("created_at", { ascending: true }).range(j, j + 999);
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const a = msgs.get(r.conversation_id as string) ?? [];
        a.push({ at: Date.parse(r.created_at as string), aix: !!r.is_aix_generated, writer: (r.staff_writer as string | null) ?? null, customer: r.sender === "customer", text: String(r.text ?? "") });
        msgs.set(r.conversation_id as string, a);
      }
      if ((data ?? []).length < 1000) break;
    }
    await new Promise((res) => setTimeout(res, 120));
  }
  const bad = new Map<string, number>(), avail = new Map<string, number>(), two = new Map<string, number>();
  const ex: Record<string, string[]> = { bad: [], two: [] };
  const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  let takeuchi = 0;
  for (const t of turns) {
    const at = Date.parse(t.customer_turn_at);
    const all = msgs.get(t.conversation_id) ?? [];
    if (all.some((m) => !m.customer && m.at <= at + 86_400_000 && POST_APPLY_RE.test(m.text))) continue;
    const moves: M[] = [];
    for (const m of all.filter((x) => x.at > at)) { if (m.customer || m.at - at >= 86_400_000) break; moves.push(m); }
    if (!moves.length || !moves.every((m) => m.writer === "takeuchi")) continue;
    takeuchi++;
    const aixLogs = ((t.staff_aix ?? []) as Array<{ at?: string; aix_type?: string; check_pattern?: string | null }>).map((a) => ({ at: Date.parse(String(a.at ?? "")), aixType: String(a.aix_type ?? ""), cp: a.check_pattern ?? null }));
    const combo = takeuchiCombo(at, assignAixKinds(moves, aixLogs.map((a) => ({ at: a.at, aixType: a.aixType })))) ?? "none";
    const first = aixLogs.sort((a, b) => a.at - b.at)[0];
    if (first?.aixType === "property_check_result" && first.cp === "unavailable") { inc(bad, combo); if (ex.bad.length < 8) ex.bad.push(`${t.conversation_id.slice(0, 8)} ${t.customer_turn_at.slice(5, 16)} ${combo}`); }
    if (first?.aixType === "property_check_result" && first.cp === "available") inc(avail, combo);
    const prevStaff = all.filter((m) => !m.customer && m.at < at && at - m.at <= 48 * 3_600_000).map((m) => m.text).join("\n");
    if (CHECK_PROMISE_RE.test(prevStaff) && PICKUP_PROMISE_RE.test(prevStaff)) { inc(two, combo); if (ex.two.length < 8) ex.two.push(`${t.conversation_id.slice(0, 8)} ${t.customer_turn_at.slice(5, 16)} ${combo}`); }
  }
  const show = (name: string, m: Map<string, number>) => { const n = [...m.values()].reduce((a, b) => a + b, 0); console.log(`- ${name}: ${n}番・${[...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}（${Math.round((v / Math.max(1, n)) * 100)}%）`).join("・")}`); };
  console.log(`# 組の表の未数えの行（竹内さん本人の番・直近 ${days}日・見張りの番 ${turns.length}・竹内さん本人 ${takeuchi}）`);
  show("① 結果が手元・悪い知らせ（物件確認した unavailable が最初の AIX）", bad);
  show("  比べ: 空いていた（available）", avail);
  show("② 約束が2つ開いている（確認＋ピックアップ・前48時間）", two);
  for (const [k, v] of Object.entries(ex)) for (const l of v) console.log(`    · ${k} ${l}`);
  if (arg("out")) writeFileSync(arg("out"), JSON.stringify({ days, takeuchi, bad: Object.fromEntries(bad), avail: Object.fromEntries(avail), two: Object.fromEntries(two), ex }, null, 1));
}
main().catch((e) => { console.error(e); process.exit(1); });
