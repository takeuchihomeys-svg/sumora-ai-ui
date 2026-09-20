// 2通目に共感フレーズ（〜ますよね／ですよね）はあるか（読み取りのみ）
//
// 2026-09-21 YUMA の検証で、懸念への2通目が「1階のお部屋ですと確かに防犯面**気になりますよね**😌」と書いた。
// 設計知見: 「共感語は全面禁止（正解返信125件中0件・スタッフ実送信6,090通中『〜ますよね/ですよね』は3通）。
//   感情はトーンにだけ反映し、気持ちの代弁・同調文は書かせない」
// → **2通目でも同じか**を実測してから直す（場面が違えば線も違う可能性があるため）。
import { createClient } from "@supabase/supabase-js";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const EMPATHY: Array<[string, RegExp]> = [
  ["〜ますよね／ですよね", /(?:ます|です)よね/],
  ["お気持ち（よくわかります）", /お気持ち[^\n。！!]{0,8}(?:わかり|分かり|お察し)/],
  ["ご心配（ですよね・かと思います）", /ご心配[^\n。！!]{0,10}(?:ですよね|かと思い|お察し)/],
  ["気になり（ますよね・ますね）", /気になり(?:ますよね|ますね)/],
  ["不安（ですよね・かと思います）", /不安[^\n。！!]{0,10}(?:ですよね|かと思い)/],
  ["〜かと思います（推測の同調）", /かと思います/],
  // 2026-09-21: 2通目で日程を聞く形（AIX【内覧日調整】の担当かどうか）
  ["ご都合よろしいお日にち（疑問形）", /ご都合[^\n]{0,12}(?:お日にち|日程)[^\n]{0,12}(?:御座|ござ)いますでしょうか/],
  ["ご都合よろしいお日にち（条件節）", /ご都合[^\n]{0,12}(?:お日にち|日程)[^\n]{0,14}(?:お伺い|頂け|いただけ|教えて)/],
  ["内覧の日程調整させて頂きます", /内覧[^\n]{0,8}日程[^\n]{0,6}調整/],
];

async function page(table: string, select: string, order: string, days: number): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let p = 0; p < 16; p++) {
    const { data, error } = await sb.from(table).select(select)
      .gte(order, new Date(Date.now() - days * 86400_000).toISOString())
      .order(order, { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (error) { console.log(`   ⚠ ${table}: ${error.message}`); break; }
    const r = (data ?? []) as unknown as Array<Record<string, unknown>>;
    if (r.length === 0) break;
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}

async function main() {
  const days = Number(process.env.DAYS ?? 180);
  const logs = await page("aix_usage_logs", "conversation_id, aix_type, sent_at, created_at", "created_at", days);
  const convIds = [...new Set(logs.map((l) => String(l.conversation_id ?? "")).filter(Boolean))];
  const msgs: Array<{ conversation_id: string; sender: string; text: string | null; created_at: string }> = [];
  for (let i = 0; i < convIds.length; i += 20) {
    const chunk = convIds.slice(i, i + 20);
    for (let p = 0; p < 12; p++) {
      const { data } = await sb.from("messages").select("conversation_id, sender, text, created_at")
        .in("conversation_id", chunk).eq("sender", "staff")
        .gte("created_at", new Date(Date.now() - days * 86400_000).toISOString())
        .order("created_at", { ascending: false }).range(p * 1000, p * 1000 + 999);
      const r = (data ?? []) as typeof msgs;
      if (r.length === 0) break;
      msgs.push(...r);
      if (r.length < 1000) break;
    }
  }
  const byConv = new Map<string, typeof msgs>();
  for (const m of msgs) {
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  for (const [, l] of byConv) l.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  const seconds: string[] = [];
  for (const l of logs) {
    const c = String(l.conversation_id ?? "");
    const t = Date.parse(String(l.sent_at ?? l.created_at));
    const list = (byConv.get(c) ?? []).filter((m) => (m.text ?? "").length > 15 && !/^\[/.test(m.text ?? ""));
    const first = list.find((m) => Math.abs(Date.parse(m.created_at) - t) <= 5 * 60_000);
    if (!first) continue;
    const ft = Date.parse(first.created_at);
    const second = list.find((m) => Date.parse(m.created_at) > ft && Date.parse(m.created_at) <= ft + 30 * 60_000);
    if (second) seconds.push(String(second.text));
  }
  // 参考: スタッフの実送信全体
  const allStaff = msgs.filter((m) => (m.text ?? "").length > 15 && !/^\[/.test(m.text ?? "")).map((m) => String(m.text));

  console.log(`=== 共感フレーズ（直近${days}日）===`);
  console.log(`   AIX の2通目 ${seconds.length}通 ／ スタッフ送信全体 ${allStaff.length}通\n`);
  console.log(`   ${"形".padEnd(30)} 2通目          全体`);
  for (const [label, re] of EMPATHY) {
    const a = seconds.filter((s) => re.test(s)).length;
    const b = allStaff.filter((s) => re.test(s)).length;
    console.log(`   ${label.padEnd(30)} ${String(a).padStart(4)}通 (${((a / Math.max(1, seconds.length)) * 100).toFixed(2)}%)  ${String(b).padStart(5)}通 (${((b / Math.max(1, allStaff.length)) * 100).toFixed(2)}%)`);
  }
  console.log(`\n   --- 2通目で当たった実物（あれば8件）---`);
  let shown = 0;
  for (const s of seconds) {
    if (shown >= 8) break;
    const hit = EMPATHY.find(([, re]) => re.test(s));
    if (!hit) continue;
    shown++;
    console.log(`     [${hit[0]}] ${s.replace(/\n/g, " ／ ").slice(0, 110)}`);
  }
  if (shown === 0) console.log(`     （0件＝2通目では一度も使われていない）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
