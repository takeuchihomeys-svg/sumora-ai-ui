// scripts/audit-screening-failed-switch.ts — 審査落ち→別物件への切り替えの場面で、スタッフが次に押した AIX を数える（読むだけ・LLM は呼ばない・本文はマスク）
// 実行: npx tsx --env-file=.env.local scripts/audit-screening-failed-switch.ts   （DAYS=180）
//
// 2026-09-27 竹内「重い順から治す」②（app/lib/screening-failed-switch.ts）:
//   A. お客様の連投に否決の語（審査落ち・ダメでした・否決・通りませんでした）→ isOwnScreeningFailureTurn・もしブレインが 物件確認した を選んでいたら
//      resolveScreeningFailedSwitch が 物件ピックアップ に変えるか・次のお客様の発言までにスタッフが押した AIX・その時のブレインの判断
//   B. こちらが否決を伝えた（仮定の「否決の場合」を除く）後 7日以内の最初の AIX と、お客様の返事の後 72時間の AIX
import { createClient } from "@supabase/supabase-js";
import { isOwnScreeningFailureTurn, resolveScreeningFailedSwitch } from "../app/lib/screening-failed-switch";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const DAYS = Number(process.env.DAYS ?? 180);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function page(table: string, cols: string, s: string | null): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (let p = 0; p < 400; p++) {
    let q = sb.from(table).select(cols).order("created_at").range(p * 1000, p * 1000 + 999);
    if (s) q = q.gte("created_at", s);
    const { data, error } = await q; if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/https?:\/\/\S+/g, "[URL]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ");
const ANY_FAIL_RE = /審査[^。！!？?\n]{0,8}(落ち|おち|通らなかっ|ダメ|だめ|駄目|否決|NG|無理|通りませんでし)|否決|落ちました|落ちちゃ|落ちてしま|通りませんでした/;
const STAFF_FAIL_RE = /(審査|保証会社)[^。！!？?\n]{0,12}(否決と|否決で|否決に|否決の(ご)?(連絡|ご返事|結果)|否決とな|NGとな|通りませんでし|通らなかっ|落ちてしま|不可とな)/;
const STAFF_HYPO_RE = /否決の場合|否決になった場合|否決でも|もし|万が一/;
const kindOf = (a?: { aix_type: string; check_pattern: string | null } | null) => a ? a.aix_type + (a.check_pattern ? `(${a.check_pattern})` : "") : "なし";

async function main() {
  const convs = await page("conversations", "id, line_source_type", null);
  const ok = new Set<string>(convs.filter((c) => c.id !== YUMA_CONVERSATION_ID && c.line_source_type !== "group").map((c) => c.id));
  const msgs = (await page("messages", "conversation_id, sender, text, created_at", since)).filter((m) => ok.has(m.conversation_id));
  const aix = (await page("aix_usage_logs", "conversation_id, aix_type, check_pattern, sent_at, created_at", since)).filter((a) => a.sent_at && ok.has(a.conversation_id));
  const bdl = (await page("brain_decision_logs", "conversation_id, suggested_action, decision_source, analyzed_msg_ts, created_at", since)).filter((a) => ok.has(a.conversation_id));
  const byConv = new Map<string, typeof msgs>(); for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const aixBy = new Map<string, typeof aix>(); for (const a of aix) { const x = aixBy.get(a.conversation_id) ?? []; x.push(a); aixBy.set(a.conversation_id, x); }

  console.log(`■ A. お客様の連投に否決の語（${DAYS}日・グループと YUMA を除く）`);
  const tally: Record<string, Record<string, number>> = {};
  for (const [cid, list] of byConv) for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.sender !== "customer" || list[i + 1]?.sender === "customer") continue; // 連投の最後
    let j = i; const parts: string[] = []; let hasImage = false;
    while (j >= 0 && list[j].sender === "customer") { const t = (list[j].text ?? "").trim(); if (/^\[画像\]/.test(t)) hasImage = true; else if (t) parts.unshift(t); j--; }
    const turn = parts.join("\n");
    if (!ANY_FAIL_RE.test(turn)) continue;
    const own = isOwnScreeningFailureTurn(turn);
    const sw = resolveScreeningFailedSwitch("property_check_result", { text: turn, hasImage });
    const t0 = Date.parse(m.created_at);
    const nextCust = list.slice(i + 1).find((x) => x.sender === "customer");
    const tEnd = Math.min(nextCust ? Date.parse(nextCust.created_at) : Infinity, t0 + 72 * 3600e3);
    const nx = (aixBy.get(cid) ?? []).find((a) => { const t = Date.parse(a.sent_at); return t > t0 && t <= tEnd; });
    const b = bdl.filter((d) => d.conversation_id === cid && d.analyzed_msg_ts && Math.abs(Date.parse(d.analyzed_msg_ts) - t0) < 5000).pop();
    const key = !own ? "否決の語だが自分の報告ではない（仮定・他人）" : sw ? "自分の審査落ち・切り替える（物件確認した→物件ピックアップ）" : "自分の審査落ち・変えない（特定のお部屋・空き・別の保証会社・質問）";
    const cell = (tally[key] ??= {}); const k = kindOf(nx); cell[k] = (cell[k] ?? 0) + 1;
    console.log(`  ${m.created_at.slice(0, 16)} ${cid.slice(0, 8)} [${key.slice(0, 18)}] 次の AIX: ${k} ／ ブレイン: ${b ? `${b.suggested_action ?? "なし"}（${b.decision_source ?? "-"}）` : "記録なし"}\n     「${mask(turn).slice(0, 100)}」`);
  }
  for (const [k, v] of Object.entries(tally)) console.log(`  → ${k}: ${Object.entries(v).map(([a, n]) => `${a} ${n}`).join("・")}`);

  console.log(`\n■ B. こちらが否決を伝えた後（仮定を除く）`);
  const first: Record<string, number> = {}; const after: Record<string, number> = {}; const seen = new Set<string>();
  for (const [cid, list] of byConv) for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (m.sender === "customer" || !m.text || !STAFF_FAIL_RE.test(m.text) || STAFF_HYPO_RE.test(m.text)) continue;
    const dkey = cid + m.created_at.slice(0, 10); if (seen.has(dkey)) continue; seen.add(dkey);
    const t0 = Date.parse(m.created_at);
    const reply = list.slice(i + 1).find((x) => x.sender === "customer");
    const nx = (aixBy.get(cid) ?? []).find((a) => { const t = Date.parse(a.sent_at); return t > t0 && t <= t0 + 7 * 86400e3; });
    const tc = reply ? Date.parse(reply.created_at) : null;
    const nx2 = tc ? (aixBy.get(cid) ?? []).find((a) => { const t = Date.parse(a.sent_at); return t > tc && t <= tc + 72 * 3600e3; }) : null;
    const k = kindOf(nx); first[k] = (first[k] ?? 0) + 1;
    const k2 = !reply ? "(返事なし)" : kindOf(nx2); after[k2] = (after[k2] ?? 0) + 1;
    console.log(`  ${m.created_at.slice(0, 16)} ${cid.slice(0, 8)} 7日内の最初: ${k} ／ 返事の後: ${k2}\n     こちら「${mask(m.text).slice(0, 80)}」\n     お客様「${mask(reply?.text ?? "").slice(0, 70)}」`);
  }
  console.log(`  → 7日内の最初の AIX: ${Object.entries(first).map(([a, n]) => `${a} ${n}`).join("・")}`);
  console.log(`  → お客様の返事の後の AIX: ${Object.entries(after).map(([a, n]) => `${a} ${n}`).join("・")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
