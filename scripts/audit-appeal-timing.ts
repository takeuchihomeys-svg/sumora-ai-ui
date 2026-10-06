// 訴求のタイミングの監査（読み取りのみ・LLM を呼ばない）
//
// 2026-10-07 竹内さん（R・チンシャン）「どのタイミングでお部屋抑えるっていれてるか どのタイミングで内覧誘導しているか
//   状況やお部屋の状況によっても違うのでその点もふまえて … 足りていない部分は（ブレイン）にあるのか」
//
// お客様の発言（連投）ごとに、次のこちらの応答（48時間以内・次のお客様の発言まで）を見て
//   ・人の手打ちの返信（応答の最初の AIX でない1通）に 申込（お部屋を抑える）／内覧 の訴求があるか・位置（締め／本文）
//   ・応答全体（AIX のテンプレートを含む）に訴求があるか
//   ・AI の下書き（ai_reply_examples の ai_draft・同じ番）に訴求があるか
//   ・app/lib/appeal-timing.ts の判定（場面×お客様×部屋の状況）
// を数え、場面×部屋の状況の表・AI とのずれ・判定との一致を出す。
//
// 使い方:
//   npx tsx --env-file=.env.local scripts/audit-appeal-timing.ts            # 2026-06-01 から（それより前は AI の下書きの記録が無く、AI の文がそのまま送られていて人の形と分けられない）
//   SINCE=2026-07-01 EX=after_estimate|thinking N=10 npx tsx ...           # 場面の実例
//   STATS=1 …                                                              # appeal-timing.ts の APPEAL_STATS に貼る表を出す
import { createClient } from "@supabase/supabase-js";
import { analyzeSubstance, classifyLastStaffTurn, classifyCustomerResponse } from "../app/lib/reply-context";
import { isTestConversation } from "../app/lib/test-conversations";
import { detectAppeal, isPostApplyText, PROPERTY_SEND_TEXT_RE, buildAppealInput, resolveAppealTiming, type AppealTimingInput, type AppealTimingVerdict } from "../app/lib/appeal-timing";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const SINCE = process.env.SINCE ?? "2026-06-01";
type M = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null };
type L = { conversation_id: string; aix_type: string | null; created_at: string; sent_at: string | null; generated_text: string | null };
type E = { conversation_id: string | null; created_at: string; was_ai_used: boolean | null; was_ai_modified: boolean | null; ai_draft: string | null; sent_reply: string | null };
async function readAll<T>(f: (a: number, b: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 2000; p++) {
    const { data, error } = await f(p * 1000, p * 1000 + 999);
    if (error) { console.error(error); break; }
    const r = (data ?? []) as T[];
    out.push(...r);
    if (r.length < 1000) break;
  }
  return out;
}
const norm = (t: string) => t.replace(/\s+/g, "");
const kindOf = (a: { apply: boolean; viewing: boolean } | null) => (!a ? "none" : a.apply ? "apply" : a.viewing ? "viewing" : "none");
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const JA: Record<string, string> = {
  after_recommend: "物件オススメ後", after_pickup: "ピックアップ後", after_estimate: "見積書後", after_check: "物件確認した後",
  viewing_adjusting: "内覧調整中", viewing_confirmed: "内覧決定後(内覧前)", post_viewing: "内覧後", after_apply_push: "申込へ！直後", post_apply: "申込以降", other: "その他",
  apply_intent: "申込の意思", viewing_wish: "内覧希望", positive: "前向き(評価)", thinking: "検討します", ack: "了承・お礼", question: "質問",
  concern: "懸念", condition_change: "条件変更", decline: "断り",
  vacant: "空室", move_out_not_viewable: "退去予定(まだ見られない)", move_out_viewable: "退去予定(見られる)", unknown: "不明",
  apply: "申込", viewing: "内覧", none: "なし",
};

type Row = {
  cid: string; at: string; input: AppealTimingInput; verdict: AppealTimingVerdict;
  staffAny: string; staffReply: string; replyPos: string | null; ai: string | null; aiIsAix: boolean;
  cust: string; reply: string; aiDraft: string; respAix: string;
};

async function main() {
  const [msgs, logs, convs, exs] = await Promise.all([
    readAll<M>((a, b) => sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated").gte("created_at", SINCE).order("created_at").order("id").range(a, b)),
    readAll<L>((a, b) => sb.from("aix_usage_logs").select("conversation_id, aix_type, created_at, sent_at, generated_text").gte("created_at", SINCE).order("created_at").range(a, b)),
    readAll<{ id: string; line_source_type: string | null }>((a, b) => sb.from("conversations").select("id, line_source_type").range(a, b)),
    readAll<E>((a, b) => sb.from("ai_reply_examples").select("conversation_id, created_at, was_ai_used, was_ai_modified, ai_draft, sent_reply").gte("created_at", SINCE).not("ai_draft", "is", null).order("created_at").range(a, b)),
  ]);
  const group = new Set(convs.filter((c) => c.line_source_type === "group").map((c) => c.id));
  const byConv = new Map<string, M[]>();
  for (const m of msgs) {
    if (isTestConversation(m.conversation_id) || group.has(m.conversation_id)) continue;
    if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
    byConv.get(m.conversation_id)!.push(m);
  }
  const logsBy = new Map<string, L[]>();
  for (const l of logs) { if (!logsBy.has(l.conversation_id)) logsBy.set(l.conversation_id, []); logsBy.get(l.conversation_id)!.push(l); }
  const exBy = new Map<string, E[]>();
  for (const e of exs) { if (!e.conversation_id) continue; if (!exBy.has(e.conversation_id)) exBy.set(e.conversation_id, []); exBy.get(e.conversation_id)!.push(e); }

  const rows: Row[] = [];
  let aiUneditedSkipped = 0;
  let propertySendSkipped = 0;
  for (const [cid, list] of byConv) {
    const cl = logsBy.get(cid) ?? [];
    const lt = (l: L) => Date.parse(l.sent_at ?? l.created_at);
    let i = 0;
    while (i < list.length) {
      if (list[i].sender !== "customer") {
        if (list[i].sender === "staff" && isPostApplyText(list[i].text)) break; // 申込以降は対象外
        i++; continue;
      }
      const cStart = i;
      while (i < list.length && list[i].sender === "customer" && (i === cStart || Date.parse(list[i].created_at) - Date.parse(list[i - 1].created_at) < 6 * 3600_000)) i++;
      const custMsgs = list.slice(cStart, i);
      const custText = custMsgs.map((m) => m.text ?? "").filter((t) => t && !/^\[/.test(t)).join("\n");
      const cAt = Date.parse(custMsgs[custMsgs.length - 1].created_at);
      const rStart = i;
      while (i < list.length && list[i].sender !== "customer" && Date.parse(list[i].created_at) - cAt < 48 * 3600_000) i++;
      const resp = list.slice(rStart, i).filter((m) => m.sender === "staff" && (m.text ?? "").trim() && !/^\[/.test(m.text ?? ""));
      if (!custText.trim() || resp.length === 0) continue;
      if (resp.some((m) => isPostApplyText(m.text))) break;
      const respEnd = Date.parse(resp[resp.length - 1].created_at);
      const respLogs = cl.filter((l) => l.aix_type && lt(l) >= cAt && lt(l) <= respEnd + 3 * 60_000);
      const isAixMsg = (m: M) => Boolean(m.is_aix_generated) || respLogs.some((l) => Math.abs(lt(l) - Date.parse(m.created_at)) <= 3 * 60_000);
      const replyMsg = resp.find((m) => !isAixMsg(m)) ?? null;
      if (!replyMsg) continue; // 手打ちの返信の無い番（AIX だけ）は返信の訴求の監査から外す
      if (PROPERTY_SEND_TEXT_RE.test(replyMsg.text ?? "")) { propertySendSkipped++; continue; } // 手打ちの物件の送付（締めは recommend-cta の担当）
      // AI の下書き（同じ番）
      const cands = (exBy.get(cid) ?? []).filter((e) => Date.parse(e.created_at) >= cAt - 60_000 && Date.parse(e.created_at) <= respEnd + 10 * 60_000);
      const ex = cands.find((e) => norm(e.sent_reply ?? "") === norm(replyMsg.text ?? "")) ?? cands.find((e) => resp.some((m) => norm(m.text ?? "") === norm(e.sent_reply ?? ""))) ?? null;
      if (ex && ex.was_ai_used && !ex.was_ai_modified && norm(ex.sent_reply ?? "") === norm(replyMsg.text ?? "")) { aiUneditedSkipped++; continue; } // AI の文のまま＝人の形ではない
      const exIsAix = Boolean(ex && respLogs.some((l) => l.generated_text && norm(l.generated_text).slice(0, 30) === norm(ex.ai_draft ?? "").slice(0, 30)));

      const before = list.slice(0, cStart);
      const prevStaff = [...before].reverse().find((m) => m.sender === "staff" && (m.text ?? "").trim() && !/^\[/.test(m.text ?? ""));
      const staffTurn = classifyLastStaffTurn(prevStaff?.text ?? "", { lastStaffAt: prevStaff?.created_at ?? null });
      const sub = analyzeSubstance(custText, undefined, { staffAskedQuestion: staffTurn.kind === "question_to_customer" });
      const cr = classifyCustomerResponse(sub, staffTurn, { recentStaffText: prevStaff?.text ?? "" });
      const cStartAt = Date.parse(custMsgs[0].created_at);
      const aixBefore = cl.filter((l) => l.aix_type && lt(l) < cStartAt).map((l) => ({ aixType: l.aix_type, at: new Date(lt(l)).toISOString() }));
      const meeting = cl.some((l) => l.aix_type === "meeting_place" && lt(l) < cStartAt && lt(l) > cStartAt - 14 * 86400_000);
      const greeted = cl.some((l) => l.aix_type === "greeting_viewing" && lt(l) < cStartAt);
      const input = buildAppealInput({
        msgs: [...before, ...custMsgs].map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at })),
        aixLogs: aixBefore,
        customerKind: cr.kind,
        viewingStage: greeted ? "done" : null,
      });
      const verdict = resolveAppealTiming(input);
      let staffAnyApply = false, staffAnyViewing = false;
      for (const m of resp) { const a = detectAppeal(m.text); staffAnyApply ||= a.apply; staffAnyViewing ||= a.viewing; }
      const rap = detectAppeal(replyMsg.text);
      const aiAp = ex?.ai_draft && !exIsAix ? detectAppeal(ex.ai_draft) : null;
      rows.push({
        cid, at: custMsgs[0].created_at, input, verdict,
        staffAny: staffAnyApply ? "apply" : staffAnyViewing ? "viewing" : "none",
        staffReply: kindOf(rap), replyPos: rap.position, ai: aiAp ? kindOf(aiAp) : null, aiIsAix: exIsAix,
        cust: custText.slice(0, 120), reply: (replyMsg.text ?? "").slice(0, 400), aiDraft: (ex?.ai_draft ?? "").slice(0, 300),
        respAix: respLogs.map((l) => l.aix_type).join(","),
      });
    }
  }
  console.log(`=== 訴求のタイミング（${SINCE}〜・人の手打ちの返信 ${rows.length}番・AI の下書きのままの送信 ${aiUneditedSkipped}番・手打ちの物件の送付 ${propertySendSkipped}番を除く・YUMA/グループ/申込以降を除く）===`);
  console.log(`   手打ちの返信の訴求: 申込 ${rows.filter((r) => r.staffReply === "apply").length} / 内覧 ${rows.filter((r) => r.staffReply === "viewing").length}  ／ 応答全体（AIX 含む）: 申込 ${rows.filter((r) => r.staffAny === "apply").length} / 内覧 ${rows.filter((r) => r.staffAny === "viewing").length}`);

  // ① 場面×お客様×部屋
  const key = (r: Row) => `${JA[r.input.scene]} × ${JA[r.input.customer]} × ${JA[r.input.room]}`;
  const g = new Map<string, Row[]>();
  for (const r of rows) { const k = key(r); if (!g.has(k)) g.set(k, []); g.get(k)!.push(r); }
  console.log(`\n── ① 場面 × お客様 × 部屋の状況（手打ちの返信／応答全体／AI の下書き）`);
  console.log(`   ${"場面".padEnd(40)}   件数 | 手打ち 申込 内覧 | 応答全体 申込 内覧 | AI(件) 申込 内覧 | 今の判定`);
  for (const [k, s] of [...g.entries()].filter(([, v]) => v.length >= Number(process.env.MIN ?? 5)).sort((a, b) => b[1].length - a[1].length)) {
    const ai = s.filter((r) => r.ai !== null);
    const vk = s[0].verdict.kind === "none" ? (s[0].verdict.level === "avoid" ? "入れない" : "-") : `${JA[s[0].verdict.kind]}(材料)`;
    console.log(`   ${k.padEnd(40)} ${String(s.length).padStart(4)} | ${pct(s.filter((r) => r.staffReply === "apply").length, s.length).padStart(5)} ${pct(s.filter((r) => r.staffReply === "viewing").length, s.length).padStart(5)} | ${pct(s.filter((r) => r.staffAny === "apply").length, s.length).padStart(5)} ${pct(s.filter((r) => r.staffAny === "viewing").length, s.length).padStart(5)} | ${String(ai.length).padStart(3)} ${pct(ai.filter((r) => r.ai === "apply").length, ai.length).padStart(4)} ${pct(ai.filter((r) => r.ai === "viewing").length, ai.length).padStart(4)} | ${vk}`);
  }

  // ② 訴求の位置
  const ap = rows.filter((r) => r.staffReply !== "none");
  console.log(`\n── ② 手打ちの返信の訴求の位置: 締め（最後の2行） ${ap.filter((r) => r.replyPos === "closing").length} / 本文 ${ap.filter((r) => r.replyPos === "body").length}`);

  // ③ AI とのずれ（同じ番に AI の下書きがある・AIX の下書きを除く）
  const paired = rows.filter((r) => r.ai !== null);
  const miss = paired.filter((r) => r.staffReply !== "none" && r.ai === "none");
  const extra = paired.filter((r) => r.staffReply === "none" && r.ai !== "none");
  const swap = paired.filter((r) => r.staffReply !== "none" && r.ai !== "none" && r.staffReply !== r.ai);
  const same = paired.filter((r) => r.staffReply === r.ai);
  console.log(`\n── ③ 今の AI の下書きとスタッフ（同じ番 ${paired.length}）: 一致 ${same.length} (${pct(same.length, paired.length)})`);
  console.log(`   訴求すべき所でしない（スタッフ訴求・AI なし）: ${miss.length}  申込 ${miss.filter((r) => r.staffReply === "apply").length} / 内覧 ${miss.filter((r) => r.staffReply === "viewing").length}`);
  console.log(`   余計・早すぎ（スタッフなし・AI 訴求）: ${extra.length}  申込 ${extra.filter((r) => r.ai === "apply").length} / 内覧 ${extra.filter((r) => r.ai === "viewing").length}`);
  console.log(`   取り違え（申込⇔内覧）: ${swap.length}`);

  // ④ 判定との当て直し（判定の種類＝材料 suggest / 入れない avoid）
  const sug = rows.filter((r) => r.verdict.level !== "avoid" && r.verdict.kind !== "none");
  const avoid = rows.filter((r) => r.verdict.level === "avoid");
  const sugHit = sug.filter((r) => r.staffReply === r.verdict.kind);
  const sugWrongKind = sug.filter((r) => r.staffReply !== "none" && r.staffReply !== r.verdict.kind);
  const avoidOk = avoid.filter((r) => r.staffReply === "none");
  console.log(`\n── ④ 判定（appeal-timing）を同じ番に当てる`);
  console.log(`   入れない（avoid） ${avoid.length}番: スタッフも入れていない ${avoidOk.length} (${pct(avoidOk.length, avoid.length)})`);
  console.log(`   材料・必須（suggest・must） ${sug.length}番: スタッフが同じ種類を入れた ${sugHit.length} (${pct(sugHit.length, sug.length)}) ／ 別の種類 ${sugWrongKind.length} ／ 入れていない ${sug.length - sugHit.length - sugWrongKind.length}`);
  const staffAppealed = rows.filter((r) => r.staffReply !== "none");
  const covered = staffAppealed.filter((r) => r.verdict.kind === r.staffReply);
  console.log(`   スタッフが訴求した ${staffAppealed.length}番のうち 判定が同じ種類を材料に出した ${covered.length} (${pct(covered.length, staffAppealed.length)}) ／ 判定が入れない ${staffAppealed.filter((r) => r.verdict.level === "avoid").length}`);
  // AI の前後（AI の下書きがある番で、判定を足したら: 材料の番で AI が訴求なし→判定の種類、avoid の番で AI の訴求→なし と仮定）
  const after = paired.map((r) => {
    let ai = r.ai as string;
    if (r.verdict.level === "avoid") ai = "none";
    else if (r.verdict.kind !== "none" && ai === "none" && (r.input.customer === "positive")) ai = r.verdict.kind; // 前向きの時だけ入れる想定
    else if (r.verdict.kind !== "none" && ai !== "none" && ai !== r.verdict.kind) ai = r.verdict.kind;
    return ai === r.staffReply;
  }).filter(Boolean).length;
  console.log(`   一致の前後（同じ番 ${paired.length}・前＝今の AI／後＝判定の材料と入れないを守った想定）: ${same.length} (${pct(same.length, paired.length)}) → ${after} (${pct(after, paired.length)})`);

  if (process.env.EX) {
    const [sc, cu, kd] = process.env.EX.split("|");
    const set = rows.filter((r) => (!sc || r.input.scene === sc) && (!cu || r.input.customer === cu) && (!kd || r.staffReply === kd));
    console.log(`\n── 実例 ${process.env.EX}（${set.length}番）`);
    for (const r of set.slice(0, Number(process.env.N ?? 8))) {
      console.log(`--- ${r.at.slice(0, 10)} ${r.cid.slice(0, 8)} [${JA[r.input.room]}${r.input.competing ? "・他申込" : ""}${r.input.scarcity ? "・1部屋/好条件" : ""}${r.input.estimateSent ? "・見積済" : ""}${r.input.urgent ? "・急ぎ" : ""}] 客「${r.cust.replace(/\n/g, " ").slice(0, 70)}」`);
      console.log(`    スタッフ(${JA[r.staffReply]}): ${r.reply.replace(/\n/g, " ").slice(0, 220)}`);
      if (r.aiDraft) console.log(`    AI(${r.ai ? JA[r.ai] : "AIX"}): ${r.aiDraft.replace(/\n/g, " ").slice(0, 160)}`);
      console.log(`    判定: ${r.verdict.kind}/${r.verdict.level} ${r.verdict.reason}`);
    }
  }
  if (process.env.EXV) {
    const set = rows.filter((r) => r.staffReply !== "none" && r.verdict.level === process.env.EXV && (process.env.EXV !== "suggest" || r.verdict.kind !== r.staffReply));
    console.log(`\n── スタッフが訴求したのに判定が ${process.env.EXV}（${set.length}番）`);
    for (const r of set.slice(0, Number(process.env.N ?? 30))) {
      console.log(`--- ${r.at.slice(0, 10)} ${r.cid.slice(0, 8)} ${JA[r.input.scene]}×${JA[r.input.customer]}×${JA[r.input.room]} 判定=${r.verdict.kind}/${r.verdict.reason} 客「${r.cust.replace(/\n/g, " ").slice(0, 50)}」`);
      console.log(`    スタッフ(${JA[r.staffReply]}): ${r.reply.replace(/\n/g, " ").slice(0, 200)}`);
    }
  }
  if (process.env.EXTRA) {
    console.log("\n── AI だけが訴求した番（余計・早すぎ）");
    for (const r of extra.slice(0, Number(process.env.N ?? 20))) {
      console.log(`--- ${r.at.slice(0, 10)} ${r.cid.slice(0, 8)} ${JA[r.input.scene]}×${JA[r.input.customer]}×${JA[r.input.room]} 客「${r.cust.replace(/\n/g, " ").slice(0, 60)}」`);
      console.log(`    スタッフ: ${r.reply.replace(/\n/g, " ").slice(0, 160)}`);
      console.log(`    AI(${r.ai ? JA[r.ai] : "-"}): ${r.aiDraft.replace(/\n/g, " ").slice(0, 200)}`);
    }
    console.log("\n── スタッフだけが訴求した番（AI が入れなかった）");
    for (const r of miss.slice(0, Number(process.env.N ?? 20))) {
      console.log(`--- ${r.at.slice(0, 10)} ${r.cid.slice(0, 8)} ${JA[r.input.scene]}×${JA[r.input.customer]}×${JA[r.input.room]} 客「${r.cust.replace(/\n/g, " ").slice(0, 60)}」`);
      console.log(`    スタッフ(${JA[r.staffReply]}): ${r.reply.replace(/\n/g, " ").slice(0, 200)}`);
      console.log(`    AI: ${r.aiDraft.replace(/\n/g, " ").slice(0, 140)}`);
    }
  }
  if (process.env.STATS) {
    const sg = new Map<string, Row[]>();
    for (const r of rows) { const k = `${r.input.scene}|${r.input.customer}`; if (!sg.has(k)) sg.set(k, []); sg.get(k)!.push(r); }
    console.log(`\n── APPEAL_STATS（appeal-timing.ts に貼る）`);
    for (const [k, s] of [...sg.entries()].filter(([, v]) => v.length >= 6).sort()) {
      console.log(`  "${k}": [${s.length}, ${Math.round((s.filter((r) => r.staffReply === "apply").length / s.length) * 100)}, ${Math.round((s.filter((r) => r.staffReply === "viewing").length / s.length) * 100)}],`);
    }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
