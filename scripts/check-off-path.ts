// scripts/check-off-path.ts — 穴の型⑤「主な道の外から来る物の割合」の点検（読むだけ・LLM なし・費用0・作業員N2・2026-11-21・台帳 #505）
//
// 統括役 11/21 の5つの型の⑤。主な道（アプリ・AIX ツール・下書き）を通らずに起きた事は、記録・学習・点検のどれにも載らない＝分母から黙って消える。
//   分野ごとの「主な道の外」の割合（軽い読み・数百行まで）:
//     物件オススメ … 売上サポ（AIX ツール）を通らなかったオススメ（作業員K2 の growth:pickup_via_tool を流用＝100−通った%・quality_daily の最新の日）
//     返信 … スタッフが返した番のうち、下書き（generate-reply）が1度も無かった番（line_watch_turns・7日）
//     送信 … スタッフの手の送信のうち、アプリを通らずに送った通（messages.sent_device_id が無い・AIX と LINE グループの発言は除く・7日）
//     内覧 … 過ぎた決まった内覧の予定（calendar_events viewing・30日・ブレインの内覧調整のタスクと【時間確保】の候補は除く）のうち、内覧の記録（viewing_history）が無い会話
//     見積 … 済みにした見積の予定（calendar_events estimate_sheet・30日）のうち、見積書ツールの記録（estimate_records・前3日〜後1日）が無い物
//   テストの会話と申込以降の会話（今の status）は除く。会話は id の頭8字だけ出す。--write で穴（10% 以上・3件以上）を台帳へ
// 実行: npx tsx --env-file=.env.local scripts/check-off-path.ts [--json] [--write]
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isTestConversation, isNoLineTestConversation } from "../app/lib/test-conversations";
import { addFoundGaps } from "./lib/found-gap-ledger";
import { isPostApplyStatus } from "../app/lib/llm-alt-provider";

export type OffPath = { id: string; label: string; owner: string; n: number; off: number; rate: number | null; why: string; convs: string[]; note?: string };
const DAY = 86_400_000;
const isTest = (c: string | null) => !c || isTestConversation(c) || isNoLineTestConversation(c);
const rateOf = (off: number, n: number) => (n ? Math.round((off / n) * 1000) / 10 : null);
export const OFF_PATH_LINE = { rate: 10, off: 3 };
export const isOffPathGap = (o: OffPath) => o.rate != null && o.rate >= OFF_PATH_LINE.rate && o.off >= OFF_PATH_LINE.off;

/** 予定ごとに、同じ会話の記録が時刻の幅にあるか（純関数）。無い予定を返す */
export function eventsWithoutRecord<E extends { conversation_id: string; start_at: string }>(events: ReadonlyArray<E>, records: ReadonlyArray<{ conversation_id: string; created_at: string }>, beforeMs: number, afterMs: number): E[] {
  const by = new Map<string, number[]>();
  for (const r of records) by.set(r.conversation_id, [...(by.get(r.conversation_id) ?? []), Date.parse(r.created_at)]);
  return events.filter((e) => { const t = Date.parse(e.start_at); return !(by.get(e.conversation_id) ?? []).some((x) => x >= t - beforeMs && x <= t + afterMs); });
}

/** 決まった内覧の予定か（純関数）: ブレインの「内覧調整」のタスク（終日・題の終わりが内覧調整）と、候補の【時間確保】は内覧ではない */
export function isConfirmedViewingEvent(e: { all_day?: boolean | null; title?: string | null; notes?: string | null }): boolean {
  if (e.all_day && /内覧調整\s*$/.test(e.title ?? "")) return false;
  if ((e.notes ?? "").trimStart().startsWith("【時間確保】")) return false;
  return true;
}

async function inChunks<T>(ids: string[], f: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 100) out.push(...(await f(ids.slice(i, i + 100))));
  return out;
}

/** 申込以降の会話（今の conversations.status）を除く道具。読めなければ除かない */
async function postApplySet(sb: SupabaseClient, convs: string[]): Promise<Set<string>> {
  const rows = await inChunks([...new Set(convs)], async (c) => ((await sb.from("conversations").select("id, status").in("id", c).limit(1000)).data ?? []) as Array<{ id: string; status: string | null }>);
  return new Set(rows.filter((r) => isPostApplyStatus(r.status)).map((r) => r.id));
}

export async function checkOffPath(sb: SupabaseClient, nowMs = Date.now()): Promise<OffPath[]> {
  const out: OffPath[] = [];
  const d7 = new Date(nowMs - 7 * DAY).toISOString(), d30 = new Date(nowMs - 30 * DAY).toISOString(), nowIso = new Date(nowMs).toISOString();

  // 物件オススメ（作業員K2 の数を流用）
  //   1日ごとの数は1日の件数が少ない（1件の日もある）＝直近7日の行を件数で重みづけて足す
  const { data: pv } = await sb.from("quality_daily").select("day, value, n").eq("metric", "growth:pickup_via_tool").eq("scope", "all").gte("day", new Date(nowMs + 9 * 3600e3 - 8 * DAY).toISOString().slice(0, 10)).limit(20);
  const pvs = ((pv ?? []) as Array<{ day: string; value: number | null; n: number | null }>).filter((r) => r.value != null && r.n);
  const pn = pvs.reduce((a, r) => a + (r.n ?? 0), 0), poff = Math.round(pvs.reduce((a, r) => a + (r.n ?? 0) * (1 - (r.value ?? 0) / 100), 0));
  if (pn) out.push({ id: "pickup.via_tool", label: "物件オススメが売上サポ（AIX ツール）を通らない", owner: "作業員K2", n: pn, off: poff, rate: rateOf(poff, pn), why: `growth:pickup_via_tool（${pvs.length}日分・audit-appeal-vs-codes）を件数で足して流用`, convs: [] });

  // 返信: 下書きが無かった番
  //   スタッフが文を送った番だけ（AIX だけで返した番は AIX の道を通っている）・申込以降の会話は除く（下書きをわざと作らない）
  const { data: wt } = await sb.from("line_watch_turns").select("conversation_id, draft_first, draft_sentinel, staff_texts, conv_status").gte("customer_turn_at", d7).not("staff_first_at", "is", null).limit(3000);
  const turns = ((wt ?? []) as Array<{ conversation_id: string; draft_first: string | null; draft_sentinel: string | null; staff_texts: unknown; conv_status: string | null }>).filter((t) => !isTest(t.conversation_id) && !isPostApplyStatus(t.conv_status) && Array.isArray(t.staff_texts) && t.staff_texts.length > 0);
  //   2026-11-21 実物で照らした（2cb0feb7 ほか）: 下書きの代わりに印（[AIX誘導中]・[返信不要]）がある番はブレインが判断した＝主な道の中（返信か AIX かの外れは見張りの一致で数える）。印も下書きも無い番だけ道の外
  const noDraft = turns.filter((t) => !t.draft_first && !t.draft_sentinel);
  out.push({ id: "reply.no_draft", label: "スタッフが返した番に下書きが無かった", owner: "作業員M", n: turns.length, off: noDraft.length, rate: rateOf(noDraft.length, turns.length), why: "line_watch_turns（7日・スタッフが文を送った番・申込以降を除く）の下書き（draft_first）もブレインの印（draft_sentinel）も無い番＝返信 AI を通っていない（見張りの一致にも学習にも載らない）", convs: [...new Set(noDraft.map((t) => t.conversation_id.slice(0, 8)))] });

  // 送信: アプリを通らない手の送信
  const { data: ms } = await sb.from("messages").select("conversation_id, sent_device_id, staff_writer_source").eq("sender", "staff").eq("is_aix_generated", false).gte("created_at", d7).limit(5000);
  const sends0 = ((ms ?? []) as Array<{ conversation_id: string; sent_device_id: string | null; staff_writer_source: string | null }>).filter((m) => !isTest(m.conversation_id) && m.staff_writer_source !== "group_speaker");
  const paS = await postApplySet(sb, sends0.map((m) => m.conversation_id));
  const sends = sends0.filter((m) => !paS.has(m.conversation_id));
  const outside = sends.filter((m) => !m.sent_device_id);
  out.push({ id: "send.outside_app", label: "スタッフの手の送信がアプリを通っていない", owner: "作業員M", n: sends.length, off: outside.length, rate: rateOf(outside.length, sends.length), why: "messages（7日・staff・AIX でない・LINE グループの発言を除く）の sent_device_id が無い通＝書き手・端末が分からず、書き手の数え・学習から外れる", convs: [...new Set(outside.map((m) => m.conversation_id.slice(0, 8)))] });

  // 内覧: 内覧の記録が無い
  //   2026-11-21 作業員N2（台帳 #579・無い8会話を1件ずつ）: 8会話とも、カレンダーにあったのはブレインの「内覧調整」のタスク
  //   （brain-core createCalendarEventFromBrainAction・終日 10:00・物件（未確定））と候補の【時間確保】だけで、待ち合わせ（meeting_place）・内覧の挨拶（greeting_viewing）は0。
  //   会話も「内覧できますか」の問い・「まだ内覧しない方が」・他社で内見 など＝内覧は無かった（記録の道の外れは0）。数えが調整のタスクを内覧に数えて 30.8% と高く見えた
  //   ＝決まった内覧の予定（isConfirmedViewingEvent）だけを数える（直すと 17会話で記録無し 0）
  const { data: vev } = await sb.from("calendar_events").select("conversation_id, start_at, all_day, title, notes").eq("event_type", "viewing").gte("start_at", d30).lt("start_at", nowIso).limit(2000);
  const views0 = ((vev ?? []) as Array<{ conversation_id: string; start_at: string; all_day: boolean | null; title: string | null; notes: string | null }>).filter((e) => !isTest(e.conversation_id) && isConfirmedViewingEvent(e));
  const paV = await postApplySet(sb, views0.map((e) => e.conversation_id));
  const views = views0.filter((e) => !paV.has(e.conversation_id));
  const vh = await inChunks([...new Set(views.map((e) => e.conversation_id))], async (c) => ((await sb.from("viewing_history").select("conversation_id, created_at").in("conversation_id", c).limit(5000)).data ?? []) as Array<{ conversation_id: string; created_at: string }>);
  // 2026-11-21 実物で照らした（f895b126・fd241181）: 予定は日の付け替えで同じ会話に何本もあり、内覧の記録は予定の数日後に作られる事がある
  //   ＝数えは会話ごと・記録はいつ作られた物でもよい（予定ごとに時刻の幅で見ると、記録のある会話まで道の外に数えて高く見えた 24.8%）
  const vConvs = [...new Set(views.map((e) => e.conversation_id))];
  const vHas = new Set(vh.map((r) => r.conversation_id));
  const vNo = vConvs.filter((c) => !vHas.has(c));
  out.push({ id: "viewing.no_record", label: "過ぎた内覧の予定がある会話に内覧の記録（viewing_history）が無い", owner: "統括役", n: vConvs.length, off: vNo.length, rate: rateOf(vNo.length, vConvs.length), why: "calendar_events viewing（30日・過ぎた物）の会話ごとに、viewing_history が1行も無い＝内覧の前後の案内・報告・成約の記録の道を通っていない", convs: vNo.map((c) => c.slice(0, 8)) });

  // 見積: 見積書ツールの記録が無い
  const { data: eev } = await sb.from("calendar_events").select("conversation_id, start_at").eq("event_type", "estimate_sheet").eq("is_done", true).gte("start_at", d30).lt("start_at", nowIso).limit(2000);
  const ests0 = ((eev ?? []) as Array<{ conversation_id: string; start_at: string }>).filter((e) => !isTest(e.conversation_id));
  const paE = await postApplySet(sb, ests0.map((e) => e.conversation_id));
  // 2026-11-21 実物で照らした（dbe2cf9c・b37b3859）: 同じ会話・同じ日に予定が2〜3本ある＝会話×日（JST）で1つに数える
  const ests = [...new Map(ests0.filter((e) => !paE.has(e.conversation_id)).map((e) => [`${e.conversation_id}|${new Date(Date.parse(e.start_at) + 9 * 3600e3).toISOString().slice(0, 10)}`, e])).values()];
  const er = await inChunks([...new Set(ests.map((e) => e.conversation_id))], async (c) => ((await sb.from("estimate_records").select("conversation_id, created_at").in("conversation_id", c).gte("created_at", new Date(nowMs - 34 * DAY).toISOString()).limit(5000)).data ?? []) as Array<{ conversation_id: string; created_at: string }>);
  const eNo = eventsWithoutRecord(ests, er, 3 * DAY, DAY);
  // 同じ幅にスタッフの画像があった物（手で見積の画像を送った疑い）の数
  const imgs = await inChunks([...new Set(eNo.map((e) => e.conversation_id))], async (c) => ((await sb.from("messages").select("conversation_id, created_at").in("conversation_id", c).eq("sender", "staff").not("image_url", "is", null).gte("created_at", new Date(nowMs - 34 * DAY).toISOString()).limit(5000)).data ?? []) as Array<{ conversation_id: string; created_at: string }>);
  const withImg = eNo.length - eventsWithoutRecord(eNo, imgs, 3 * DAY, DAY).length;
  out.push({ id: "estimate.no_record", label: "済みにした見積の予定に見積書ツールの記録が無い", owner: "作業員K2", n: ests.length, off: eNo.length, rate: rateOf(eNo.length, ests.length), why: "calendar_events estimate_sheet（30日・済み）の前3日〜後1日に estimate_records が無い＝見積書ツール（AIX）を通らず、利益・広告料・初期費用の記録に載らない", convs: [...new Set(eNo.map((e) => e.conversation_id.slice(0, 8)))], note: `うち同じ幅にスタッフの画像あり ${withImg}（手で画像を送った疑い）` });
  return out;
}

if (process.argv[1]?.endsWith("check-off-path.ts")) (async () => {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const r = await checkOffPath(sb);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r)); return; }
  console.log(`主な道の外から来る物（分野 ${r.length}・穴 ${r.filter(isOffPathGap).length}）`);
  for (const o of r) console.log(`- ${isOffPathGap(o) ? "穴" : "  "}｜${o.label}｜${o.off}/${o.n}＝${o.rate ?? "—"}%｜${o.owner}${o.note ? `｜${o.note}` : ""}｜会話 ${o.convs.slice(0, 5).join(",") || "—"}`);
  if (process.argv.includes("--write")) {
    const added = await addFoundGaps(sb, r.filter(isOffPathGap).map((o) => ({
      title: `主な道の外から来る: ${o.label}`, owner: o.owner, priority: 20,
      next: `check-off-path（穴の型⑤）: ${o.off}/${o.n}（${o.rate}%）・${o.why}${o.note ? `・${o.note}` : ""}・会話 ${o.convs.slice(0, 5).join(",")}・なぜ主な道を通らないかを実物で確かめ、道に乗せるか外の物も記録に拾う（台帳 #505）`,
    })), "check-off-path");
    console.log(`台帳に足した ${added.length}行${added.length ? `（#${added.join("・#")}）` : ""}`);
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
