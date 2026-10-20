// scripts/audit-day-subject.ts — 「何の日か」「確認の相手（主語）」「かしこまりましたの重なり・置き場所」「本日の圧」の外れを数える
//   （読むだけ・LLM なし・DB に書かない・文の中身は出さない）
//
// 見張り（line_watch_turns）の AI の下書き（draft_first）とスタッフが送った文（staff_texts）を、app/lib/day-subject-reader.ts と
//   app/lib/opener-repeat.ts の同じ関数で確かめる（四者同名）。スタッフの送信も同じ型に当たる時は「決まりの方が違う」目安。
// 実行: npx tsx --env-file=.env.local scripts/audit-day-subject.ts [--days=60] [--ids]   （--ids は外れの番の id だけ出す・試験の問題の候補）
import { createClient } from "@supabase/supabase-js";
import { resolveViewingFlow } from "../app/lib/viewing-flow";
import { readDaySubject, splitTurn, viewingSchedulingOpen, draftConfirmsOwnViewingTime, draftConfirmPromiseSentences, draftKindNearDate, draftEchoesCustomerDeadline, type DateKind } from "../app/lib/day-subject-reader";
import { collapseRepeatedOpener, dedupeKashikomarimashita, placeAckInContentBlock } from "../app/lib/opener-repeat";
import { stripInternalTags } from "../app/lib/draft-text";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const DAYS = Number(arg("days", "60"));
const SHOW_IDS = process.argv.includes("--ids");

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
type Msg = { conversation_id: string; sender: string; text: string | null; created_at: string };
type Row = { id: number; conversation_id: string; customer_turn_at: string; customer_last_at: string; draft_first: string | null; staff_texts: Array<{ text: string }> | null; staff_aix: unknown[] | null };

const ACK_RE = /かしこまりました|承知(?:いた|致)?しました/g;
const ackCount = (t: string) => (t.match(ACK_RE) ?? []).length;

async function main() {
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const rows = await readAll<Row>((f, t) => sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, draft_first, staff_texts, staff_aix").gte("created_at", since).not("draft_first", "is", null).order("id").range(f, t));
  const convIds = [...new Set(rows.map((r) => r.conversation_id))];
  const byConv = new Map<string, Msg[]>();
  for (let i = 0; i < convIds.length; i += 40) {
    const part = await readAll<Msg>((f, t) => sb.from("messages").select("conversation_id, sender, text, created_at").in("conversation_id", convIds.slice(i, i + 40)).gte("created_at", new Date(Date.parse(since) - 14 * 86400_000).toISOString()).order("created_at").order("id").range(f, t));
    for (const m of part) (byConv.get(m.conversation_id) ?? byConv.set(m.conversation_id, []).get(m.conversation_id)!).push(m);
  }
  const c = new Map<string, number>();
  const ids = new Map<string, number[]>();
  const inc = (k: string, id?: number) => { c.set(k, (c.get(k) ?? 0) + 1); if (id != null) (ids.get(k) ?? ids.set(k, []).get(k)!).push(id); };
  let n = 0, nStaff = 0;
  for (const r of rows) {
    const all = (byConv.get(r.conversation_id) ?? []).filter((m) => m.created_at <= r.customer_last_at).slice(-40);
    if (!all.length || all[all.length - 1].sender !== "customer" || !r.draft_first) continue;
    n++;
    const draft = stripInternalTags(r.draft_first);
    const staff = (r.staff_texts ?? []).map((x) => x.text).filter(Boolean).join("\n");
    if (staff.trim()) nStaff++;
    const flow = resolveViewingFlow({ messages: all.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at })), nowMs: Date.parse(r.customer_last_at) });
    const rd = readDaySubject(all.map((m) => ({ sender: m.sender, text: m.text })), flow.stage);
    const { customer, staffBefore } = splitTurn(all.map((m) => ({ sender: m.sender, text: m.text })));
    const open = viewingSchedulingOpen(flow.stage, staffBefore);

    // ── A 何の日か ──
    if (rd.dates.length) inc("A0 日付の話のある番");
    for (const d of rd.dates) inc(`A0 読み: ${d.kind}/${d.source}`);
    const implicit = rd.dates.filter((d) => d.source === "flow" || d.source === "staff_question");
    if (implicit.length) inc("A1 何の日かの語が無い日付（流れ・こちらの問いで決めた）", r.id);
    for (const d of implicit) {
      const dk = draftKindNearDate(draft, d.dateText);
      const sk = staff ? draftKindNearDate(staff, d.dateText) : null;
      if (dk && dk !== d.kind) inc(`A2 下書きが別の日として書いた（読み=${d.kind}・下書き=${dk}）`, r.id);
      if (sk) { inc("A3 スタッフの送信で何の日か分かる"); if (sk === d.kind) inc("A3 読みとスタッフが一致"); else inc(`A3 読みとスタッフが不一致（読み=${d.kind}・スタッフ=${sk}）`, r.id); }
      if (d.kind === "viewing" && d.staffAskedMoveIn) inc("A4 内覧の調整中に直前のこちらが入居を聞いた（Moe 型）", r.id);
    }
    if (rd.dates.some((d) => d.kind === "viewing" && !d.dateText && d.timeOfDay)) {
      inc("A5 時間帯だけの指定（朝方 等）を内覧の日時と読んだ", r.id);
      if (draftConfirmPromiseSentences(draft).length) inc("A5 └ 下書きは確認の約束", r.id);
    }
    // ── B 確認の相手 ──
    const ownTime = draftConfirmsOwnViewingTime(draft);
    if (ownTime) inc("B1 下書きが内覧の日時（スタッフで決める事）を確認の約束にした", r.id);
    if (ownTime && open) inc("B1 └ 内覧の日程の調整中", r.id);
    if (ownTime && staff) { inc("B1 └ スタッフの送信あり"); if (draftConfirmsOwnViewingTime(staff)) inc("B1 └ スタッフも同じ確認の約束"); }
    const staffParty = rd.parties.filter((p) => p.party === "staff");
    if (staffParty.length && draftConfirmPromiseSentences(draft).length) {
      inc("B2 （参考）スタッフで決める話題の番に下書きが確認の約束（別の話題の約束も含む）", r.id);
      if (staff) { inc("B2 └ スタッフの送信あり"); if (draftConfirmPromiseSentences(staff).length) inc("B2 └ スタッフも確認の約束"); }
    }
    const custParty = rd.parties.filter((p) => p.party === "customer");
    if (custParty.length && draftConfirmPromiseSentences(draft).length) inc("B3 お客様が確かめる番にこちらが確認の約束", r.id);
    for (const p of rd.parties) inc(`B0 話題: ${p.topic}=${p.party}`);
    // ── C かしこまりました・本日 ──
    const dc = collapseRepeatedOpener(draft).text;
    if (ackCount(dc) >= 2) inc("C1 下書きのかしこまりましたが2回以上（続く行の網の後）", r.id);
    if (dedupeKashikomarimashita(dc).removed) inc("C1 └ 重なりの網で落ちる", r.id);
    const staffMsgs = (r.staff_texts ?? []).map((x) => x.text).filter(Boolean);
    if (staff) {
      if (staffMsgs.some((t) => ackCount(t) >= 2)) inc("C1s スタッフの送信のかしこまりましたが2回以上");
      if (staffMsgs.some((t) => dedupeKashikomarimashita(t).removed)) inc("C1s スタッフの送信が重なりの網で変わる（誤削除の目安）", r.id);
      if (staffMsgs.some((t) => placeAckInContentBlock(t).moved)) inc("C2s スタッフの送信が置き場所の網で変わる（決まりとの食い違いの目安）", r.id);
    }
    if (placeAckInContentBlock(dc).moved) inc("C2 下書きの受けが挨拶の段に付いた（置き場所の網で動く）", r.id);
    if (draftEchoesCustomerDeadline(customer, draft)) inc("C3 お客様の『今日中に連絡します』に下書きが本日・今日を返した", r.id);
    if (staff && draftEchoesCustomerDeadline(customer, staff)) inc("C3s スタッフも本日・今日を返した");
    if (rd.dates.some((d) => d.kind === "contact")) inc("C3 お客様が自分で連絡の期日を言った番");
  }
  // 人の手打ちの全送信（1通ずつ）で網が変える通（誤削除・決まりとの食い違いの目安）
  const sent = await readAll<{ text: string | null; is_aix_generated: boolean | null }>((f, t) => sb.from("messages").select("text, is_aix_generated").eq("sender", "staff").gte("created_at", since).order("id").range(f, t));
  let manual = 0, dd = 0, pl = 0;
  for (const m of sent) { if (m.is_aix_generated || !m.text) continue; manual++; if (dedupeKashikomarimashita(m.text).removed) dd++; if (placeAckInContentBlock(m.text).moved) pl++; }
  console.log(`=== 人の手打ち ${manual}通: 重なりの網で変わる ${dd}・置き場所の網で変わる ${pl} ===`);
  console.log(`=== 見張りの下書き ${n}番（直近${DAYS}日・お客様が最後の番）・うちスタッフの文字の送信あり ${nStaff} ===`);
  for (const [k, v] of [...c].sort((a, b) => a[0].localeCompare(b[0], "ja"))) console.log(`${String(v).padStart(5)}  ${k}`);
  if (SHOW_IDS) for (const [k, v] of [...ids].sort((a, b) => a[0].localeCompare(b[0], "ja"))) console.log(`[ids] ${k}: ${v.slice(-15).join(",")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
