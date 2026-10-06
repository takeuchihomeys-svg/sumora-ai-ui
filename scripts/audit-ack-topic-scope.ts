// scripts/audit-ack-topic-scope.ts — お礼・了承だけの番の「読むべき範囲」の線を実送信で引く（読むだけ・LLM なし・DB に書かない）
//
// 2026-10-07 竹内（uran. 10/05）「対象となる会話で、どこを読み取る必要があるのか、ここの部分を改善する」。
//   app/lib/ack-topic-scope.ts の resolveAckTopicScope で場面を取り、その後スタッフが実際に何をしたか（返さない／範囲の中の事だけ／範囲の外の行為を足した）を数える。
//   ①実送信: お客様のお礼・了承の番 → 24時間以内（次のお客様の発言まで）のスタッフの文字の返事・AIX
//   ②下書き: line_watch_turns（10/01〜）の draft_first と ai_reply_examples の ai_draft で、範囲の外の行為を書いた回を出して目で読む
//
// 実行: npx tsx --env-file=.env.local scripts/audit-ack-topic-scope.ts [--days=365] [--show=20]
import { createClient } from "@supabase/supabase-js";
import { resolveAckTopicScope, outOfTopicActs, isAckOnlyTurn, type ScopeMsg } from "../app/lib/ack-topic-scope";
import { isShortAckOnly, shouldSkipDraftAfterClosing } from "../app/lib/previous-send-note";
import { staffActsOf, STAFF_ACT_JA, type StaffAct } from "../app/lib/customer-sim-shadow";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "365"));
// 返事を数える期間の始まり（5月までは AI の自動返信の文が staff に混ざっている＝c7cc70ce 等の「😅…✨」の文）
const FROM = arg("from", "2026-06-01");
const SHOW = Number(arg("show", "20"));
const MEDIA_ONLY_RE = /^\[(?:画像|動画|スタンプ|ファイル)\]$/;
const mask = (s: string) => s.replace(/[^\s、。！!？?\n]{1,12}(?:さん|様|さま)/g, "〇〇さん").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〇〇").replace(/\n/g, " ／ ");

type Msg = ScopeMsg & { conversation_id: string; created_at: string };

async function readAll<T>(fn: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, cap = 400_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += 1000) {
    const { data, error } = await fn(from, from + 999);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

type Bucket = { n: number; none: number; aixOnly: number; text: number; textInTopic: number; textNewAct: number; newPickup: number; acts: Map<string, number>; samples: string[] };
const mk = (): Bucket => ({ n: 0, none: 0, aixOnly: 0, text: 0, textInTopic: 0, textNewAct: 0, newPickup: 0, acts: new Map(), samples: [] });

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const convs = await readAll<{ id: string; line_source_type: string | null; status: string | null }>((f, t) => sb.from("conversations").select("id, line_source_type, status").range(f, t));
  const skip = new Set(convs.filter((c) => (c.line_source_type ?? "user") !== "user" || c.id === YUMA_CONVERSATION_ID).map((c) => c.id));
  const msgs = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", since).order("created_at").order("id").range(f, t));
  console.log(`=== 材料: messages ${msgs.length}件（直近${DAYS}日）・会話 ${convs.length}（グループ・YUMA ${skip.size} を除く）===`);
  const by = new Map<string, Msg[]>();
  for (const m of msgs) { if (skip.has(m.conversation_id)) continue; (by.get(m.conversation_id) ?? by.set(m.conversation_id, []).get(m.conversation_id)!).push(m); }

  const buckets = {
    "S 範囲がお部屋探しの話でない（!searchTopic）": mk(),
    "S' うち前の話題から7日以上空き": mk(),
    "S'' うち約束も無い（!topicOpen）": mk(),
    "T 範囲がお部屋探しの話（searchTopic）": mk(),
    "A 閉じた・物件以外（closedNonPropertyTopic）": mk(),
  } as Record<string, Bucket>;
  let ackTurns = 0, ackOld = 0, ackNew = 0, skipOld = 0, skipNew = 0;
  for (const [cid, arr] of by) {
    for (let k = 0; k < arr.length; k++) {
      // お客様の番の最後の通
      if (arr[k].sender !== "customer" || arr[k + 1]?.sender === "customer") continue;
      const upto = arr.slice(0, k + 1);
      let s = k; while (s >= 0 && arr[s].sender === "customer") s--;
      const turnText = arr.slice(s + 1, k + 1).map((x) => String(x.text ?? "")).join("\n");
      const scope = resolveAckTopicScope(upto);
      // 既存の入口（isShortAckOnly）との差
      const oldAck = isShortAckOnly(turnText.trim()), newAck = isAckOnlyTurn(turnText);
      if (oldAck) ackOld++; if (newAck) ackNew++;
      if (newAck && scope.applies) {
        const v = shouldSkipDraftAfterClosing({ prevStaffText: scope.staffText, customerText: turnText.trim() });
        if (v.skip && oldAck) skipOld++;
        if (shouldSkipDraftAfterClosing({ prevStaffText: scope.staffText, customerText: "ありがとうございます" }).skip) skipNew++;
      }
      if (!scope.applies) continue;
      if (arr[k].created_at < FROM) continue;
      ackTurns++;
      // 返事: 次のお客様の発言まで・24時間以内
      const turnAt = Date.parse(arr[k].created_at);
      const resp: Msg[] = [];
      // 最初の返事のまとまりだけ（見張り line-watch-judge と同じ: 最初の文から間が10分以内・30分まで。後の報告・翌朝の連絡は同じ番の返事ではない）
      for (let j = k + 1; j < arr.length && arr[j].sender !== "customer"; j++) {
        const at = Date.parse(arr[j].created_at);
        if (at - turnAt > 24 * 3600_000) break;
        if (resp.length) {
          const first = Date.parse(resp[0].created_at), prev = Date.parse(resp[resp.length - 1].created_at);
          if (at - prev > 10 * 60_000 || at - first > 30 * 60_000) break;
        }
        resp.push(arr[j]);
      }
      const texts = resp.filter((x) => !x.is_aix_generated && x.text && !MEDIA_ONLY_RE.test(String(x.text).trim())).map((x) => String(x.text));
      const aix = resp.some((x) => x.is_aix_generated);
      const keys: string[] = [];
      if (!scope.searchTopic) { keys.push("S 範囲がお部屋探しの話でない（!searchTopic）"); if ((scope.gapDaysBefore ?? 0) >= 7) keys.push("S' うち前の話題から7日以上空き"); if (!scope.topicOpen) keys.push("S'' うち約束も無い（!topicOpen）"); }
      else keys.push("T 範囲がお部屋探しの話（searchTopic）");
      if (scope.closedNonPropertyTopic) keys.push("A 閉じた・物件以外（closedNonPropertyTopic）");
      const have = new Set<StaffAct>(scope.topicActs);
      const ra = texts.length ? [...staffActsOf(texts.join("\n"))] : [];
      const newActs = ra.filter((a) => !have.has(a));
      for (const key of keys) {
        const b = buckets[key]; b.n++;
        if (!resp.length) b.none++;
        else if (!texts.length) b.aixOnly++;
        else {
          b.text++;
          if (newActs.length) { b.textNewAct++; for (const a of newActs) b.acts.set(a, (b.acts.get(a) ?? 0) + 1); } else b.textInTopic++;
          if (newActs.includes("pickup_promise")) b.newPickup++;
        }
        if (b.samples.length < SHOW && (key.startsWith("S'") || newActs.includes("pickup_promise") || newActs.includes("pickup_done"))) {
          b.samples.push(`[${cid.slice(0, 8)} ${arr[k].created_at.slice(0, 10)} 空き${scope.gapDaysBefore ?? "-"}日] 客「${mask(scope.topicText).slice(0, 50)}」→ 我「${mask(scope.staffText).slice(0, 70)}」→ 客「${mask(turnText).slice(0, 20)}」→ ${resp.length ? (texts.length ? `我「${mask(texts.join(" / ")).slice(0, 90)}」${newActs.length ? ` ＋${newActs.map((a) => STAFF_ACT_JA[a]).join("・")}` : ""}` : "AIX だけ") : "（返さない）"}`);
        }
      }
    }
  }
  console.log(`\nお礼・了承だけの番: isShortAckOnly ${ackOld} ／ isAckOnlyTurn（ZWJ の絵文字も） ${ackNew}`);
  console.log(`読むべき範囲が決まった番（直前にこちらの文字の返事・72時間以内）: ${ackTurns}`);
  console.log(`（参考）既存の返信不要の入口が止める番 ${skipOld}`);
  void skipNew;
  for (const [k, b] of Object.entries(buckets)) {
    const pct = (x: number) => (b.n ? `${Math.round((x / b.n) * 1000) / 10}%` : "-");
    const pt = (x: number) => (b.text ? `${Math.round((x / b.text) * 1000) / 10}%` : "-");
    console.log(`\n■ ${k}: ${b.n}番`);
    console.log(`  返さない ${b.none}（${pct(b.none)}）／ AIX だけ ${b.aixOnly}（${pct(b.aixOnly)}）／ 文字の返事 ${b.text}（${pct(b.text)}）`);
    console.log(`  文字の返事のうち: 範囲の中だけ ${b.textInTopic}（${pt(b.textInTopic)}）／ 範囲の外の行為を足した ${b.textNewAct}（${pt(b.textNewAct)}）／ うち探す宣言 ${b.newPickup}（${pt(b.newPickup)}）`);
    if (b.acts.size) console.log(`  足した行為: ${[...b.acts.entries()].sort((a, c) => c[1] - a[1]).map(([a, c]) => `${STAFF_ACT_JA[a as StaffAct] ?? a} ${c}`).join("・")}`);
    for (const s of b.samples) console.log(`   - ${s}`);
  }

  // ②下書き（line_watch_turns と ai_reply_examples）
  console.log(`\n=== 下書き: 範囲が閉じた物件以外の番で、範囲の外の行為を書いた回 ===`);
  const turns = await readAll<{ id: number; conversation_id: string; customer_turn_at: string; draft_first: string | null; staff_texts: Array<{ text: string; burst: boolean }> | null; verdict: string | null }>((f, t) => sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, draft_first, staff_texts, verdict").order("customer_turn_at").range(f, t));
  let lwN = 0, lwOut = 0;
  for (const t of turns) {
    if (skip.has(t.conversation_id) || !t.draft_first) continue;
    const arr = (by.get(t.conversation_id) ?? []).filter((m) => Date.parse(m.created_at) <= Date.parse(t.customer_turn_at) + 1000);
    // 番の最後のお客様の通まで（customer_turn_at は番の最初の通）
    const all = by.get(t.conversation_id) ?? [];
    let end = arr.length; while (end < all.length && all[end].sender === "customer") end++;
    const scope = resolveAckTopicScope(all.slice(0, end));
    if (!scope.applies || !scope.closedNonPropertyTopic) continue;
    lwN++;
    const out = outOfTopicActs(t.draft_first, scope);
    if (out.length) {
      lwOut++;
      const staff = (t.staff_texts ?? []).filter((x) => x.burst).map((x) => x.text).join(" / ");
      console.log(` - [見張り#${t.id} ${t.conversation_id.slice(0, 8)} ${t.customer_turn_at.slice(0, 16)} 空き${scope.gapDaysBefore ?? "-"}日] ${out.map((a) => STAFF_ACT_JA[a]).join("・")}\n     我「${mask(scope.staffText).slice(0, 80)}」\n     下書き「${mask(t.draft_first).slice(0, 110)}」\n     スタッフ: ${staff ? `「${mask(staff).slice(0, 80)}」` : "（返さない）"}`);
    }
  }
  console.log(`見張りの番（10/01〜）: 範囲が閉じた物件以外 ${lwN}番・範囲の外の行為を書いた下書き ${lwOut}`);

  const ex = await readAll<{ conversation_id: string | null; customer_message: string | null; ai_draft: string | null; sent_reply: string | null; created_at: string }>((f, t) => sb.from("ai_reply_examples").select("conversation_id, customer_message, ai_draft, sent_reply, created_at").gte("created_at", since).not("ai_draft", "is", null).order("created_at").range(f, t));
  let exN = 0, exOut = 0, exStaffOut = 0;
  for (const e of ex) {
    if (!e.conversation_id || skip.has(e.conversation_id) || !e.ai_draft || !isAckOnlyTurn(e.customer_message)) continue;
    const all = by.get(e.conversation_id) ?? [];
    // 例の時刻の直前のお客様の通までで範囲を決める
    const at = Date.parse(e.created_at);
    let end = all.findIndex((m) => Date.parse(m.created_at) > at); if (end < 0) end = all.length;
    let kk = end - 1; while (kk >= 0 && all[kk].sender !== "customer") kk--;
    if (kk < 0) continue;
    const scope = resolveAckTopicScope(all.slice(0, kk + 1));
    if (!scope.applies || !scope.closedNonPropertyTopic) continue;
    exN++;
    const out = outOfTopicActs(e.ai_draft, scope);
    const sOut = outOfTopicActs(e.sent_reply, scope);
    if (sOut.length) exStaffOut++;
    if (out.length) {
      exOut++;
      if (exOut <= SHOW) console.log(` - [例 ${e.conversation_id.slice(0, 8)} ${e.created_at.slice(0, 10)}] ${out.map((a) => STAFF_ACT_JA[a]).join("・")}\n     我「${mask(scope.staffText).slice(0, 80)}」\n     下書き「${mask(e.ai_draft).slice(0, 110)}」\n     送った「${mask(e.sent_reply ?? "").slice(0, 90)}」${sOut.length ? `（送った文も範囲の外: ${sOut.map((a) => STAFF_ACT_JA[a]).join("・")}）` : ""}`);
    }
  }
  console.log(`手本の例（送った番）: 範囲が閉じた物件以外 ${exN}番・下書きが範囲の外 ${exOut}・送った文が範囲の外 ${exStaffOut}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
