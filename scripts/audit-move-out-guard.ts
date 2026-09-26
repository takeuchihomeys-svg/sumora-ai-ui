// 退去予定の補正（moveOutBlocksViewing＝内覧の希望を AIX【申込へ】に差し替える）の旧と新を、実送信で並べる（読むだけ・LLM なし）
// 2026-09-26 穴:G5（設計知見「退去予定の補正が物件をまたいで効き、新しい物件の内覧希望を申込へに変える」）
//
// 測ること（直近 DAYS 日・グループと YUMA を除く）:
//   お客様の内覧の希望（brain-core の信号と同じ語）で、直近15通に退去予定・入居中の話がある回。
//   その時点の直近15通（新しい順）に旧（会話全体で見る）と新（お部屋ごとに見る・moveOutViewingVerdict）を当て、
//   スタッフの次の AIX（申込へ／内覧へ・待ち合わせ）と比べる。変わった回は全部本文を出す（目で読む）。
//
// 2026-09-26 の結果は memory/dept_line_reply.md の「切り替え（段3）」の節と設計知見（穴:G5）に。
// 実行: npx tsx --env-file=.env.local scripts/audit-move-out-guard.ts   （DAYS=180）
import { createClient } from "@supabase/supabase-js";
import { MOVE_OUT_PATTERN, moveOutEvidenceFromMsgs, staffOffersViewing, staffAdvisesHold, moveOutViewingVerdict } from "../app/lib/move-out-context";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/https?:\/\/\S+/g, "[URL]");
// brain-core の信号（内覧の希望）と同じ語
const VIEWING_WISH = (t: string) =>
  /(内覧|内見|見学)[^。！!？?\n]{0,12}(したい|したく(?!ない|ありません)|行きたい|いきたい|行きたく(?!ない|ありません)|希望(?!(は|も)?(ない|ありません|しない|しません))|お願いし)/.test(t) ||
  /(内覧|内見|見学)[^。！!？?\n]{0,12}(可能|でき|出来)[^。！!？?\n]{0,6}(ですか|ますか|でしょうか)/.test(t) || /見に(行|い)きたい/.test(t) || /行きたいです/.test(t);

type M = { conversation_id: string; sender: string; text: string | null; created_at: string };
/** 旧（2026-09-15〜09-26）: 会話全体で「退去予定の話以降のスタッフの最後の言及」 */
function legacyBlocks(newestFirst: M[]): boolean {
  const oldest = [...newestFirst].reverse();
  let last = -1;
  oldest.forEach((m, i) => { if (MOVE_OUT_PATTERN.test(moveOutEvidenceFromMsgs([m]))) last = i; });
  if (last < 0) return false;
  const staff = oldest.slice(last).filter((m) => m.sender !== "customer");
  for (let i = staff.length - 1; i >= 0; i--) {
    if (staffOffersViewing(staff[i].text)) return false;
    if (staffAdvisesHold(staff[i].text)) return true;
  }
  return false;
}

async function main() {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const convs: Array<{ id: string; line_source_type: string | null }> = [];
  for (let p = 0; p < 20; p++) { const { data } = await sb.from("conversations").select("id, line_source_type").range(p * 1000, p * 1000 + 999); convs.push(...(data ?? []) as typeof convs); if ((data ?? []).length < 1000) break; }
  const ok = new Set(convs.filter((c) => c.id !== YUMA && c.line_source_type !== "group").map((c) => c.id));
  // 退去予定の語がある会話だけ読む
  const moRows: M[] = [];
  for (let p = 0; p < 50; p++) {
    const { data } = await sb.from("messages").select("conversation_id").gte("created_at", since).or("text.ilike.%退去%,text.ilike.%入居中%").range(p * 1000, p * 1000 + 999);
    moRows.push(...(data ?? []) as M[]); if ((data ?? []).length < 1000) break;
  }
  const targetConvs = [...new Set(moRows.map((r) => r.conversation_id))].filter((c) => ok.has(c));
  let turns = 0; const rows: Array<{ conv: string; at: string; legacy: boolean; next: boolean; reason: string; staffNext: string; ctx: string }> = [];
  for (const conv of targetConvs) {
    const { data: ms } = await sb.from("messages").select("conversation_id, sender, text, created_at").eq("conversation_id", conv).gte("created_at", new Date(Date.parse(since) - 30 * 86400e3).toISOString()).order("created_at").limit(3000);
    const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, sent_at, created_at").eq("conversation_id", conv).not("sent_at", "is", null).order("created_at");
    const list = (ms ?? []) as M[];
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.sender !== "customer" || m.created_at < since) continue;
      if (list[i + 1]?.sender === "customer") continue; // 連投の最後だけ
      // 連投をまとめる
      let j = i; const turn: string[] = [];
      while (j >= 0 && list[j].sender === "customer") { turn.unshift(list[j].text ?? ""); j--; }
      if (!VIEWING_WISH(turn.join("\n"))) continue;
      const window = list.slice(Math.max(0, i - 14), i + 1).reverse(); // 直近15通・新しい順（ブレインが読む範囲）
      if (!MOVE_OUT_PATTERN.test(moveOutEvidenceFromMsgs(window))) continue;
      turns++;
      const legacy = legacyBlocks(window);
      const v = moveOutViewingVerdict(window, "newest_first");
      const t = Date.parse(m.created_at);
      const nextAix = (ax ?? []).find((a) => Date.parse(a.sent_at ?? a.created_at) > t && Date.parse(a.sent_at ?? a.created_at) - t < 48 * 3600e3)?.aix_type ?? "なし";
      const ctx = window.slice(0, 8).reverse().map((x) => `    [${x.sender} ${x.created_at.slice(5, 16)}] ${mask((x.text ?? "").replace(/\n/g, " ⏎ ")).slice(0, 200)}`).join("\n");
      rows.push({ conv, at: m.created_at, legacy, next: v.blocks, reason: v.reason, staffNext: nextAix, ctx });
    }
  }
  const cls = (a: string) => a === "application_push" ? "申込へ" : ["viewing_invite", "meeting_place", "greeting_viewing"].includes(a) ? "内覧" : "他";
  const tally = (pick: (r: (typeof rows)[number]) => boolean) => {
    const c: Record<string, number> = {};
    for (const r of rows) { const k = `${pick(r) ? "申込へに差し替え" : "差し替えない"}→スタッフ${cls(r.staffNext)}`; c[k] = (c[k] ?? 0) + 1; }
    return Object.entries(c).sort().map(([k, v]) => `${k} ${v}`).join("・");
  };
  console.log(`直近${DAYS}日・退去予定の話がある内覧の希望 ${turns}ターン（${targetConvs.length}会話を読んだ）`);
  console.log(`旧: ${tally((r) => r.legacy)}`);
  console.log(`新: ${tally((r) => r.next)}`);
  const reasons: Record<string, number> = {};
  for (const r of rows) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  console.log("新の理由:", reasons);
  const changed = rows.filter((r) => r.legacy !== r.next);
  console.log(`\n旧と新で変わった回 ${changed.length}（全部）`);
  for (const r of changed) console.log(`--- ${r.conv.slice(0, 8)} ${r.at.slice(0, 16)} 旧=${r.legacy ? "申込へ" : "-"} 新=${r.next ? "申込へ" : "-"}(${r.reason}) スタッフ=${r.staffNext}\n${r.ctx}`);
  if (process.env.SHOW_BLOCKS) for (const r of rows.filter((x) => x.next)) console.log(`=== 新でも申込へ ${r.conv.slice(0, 8)} ${r.at.slice(0, 16)} スタッフ=${r.staffNext}\n${r.ctx}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
