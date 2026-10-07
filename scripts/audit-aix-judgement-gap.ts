// scripts/audit-aix-judgement-gap.ts — 2026-10-07 竹内さん「AIXの判断の部分なぜずれあるのかも深く徹底的に調査する」
//   「返信か AIX か」「どの AIX か」のずれを番ごとに並べ、型に分けて出所（材料・決まり・鮮度・スタッフ側）を数える（読むだけ・LLM なし）。
//   番: brain_decision_logs の analyzed_msg_ts ごと（同じ番の判断が複数ある時は「スタッフの最初の行動より前の最後」＝スタッフが見た判断。無ければ最後）
//   スタッフ: line-watch-judge.staffWindowOf の返事のまとまり（burst）で押した AIX／手打ちの文。まとまりの外で後から押した AIX（窓の中・72時間以内）も控える
//   除く: テストの会話（YUMA 等）・申込以降・申込へ を押した後・スタッフが何も送っていない番・窓が閉じていない番
//   ブレインの action が null になった訳は decision_source が残らない（brain-core は finalAix が null の時 decision_source を捨てる）ので、
//   digest.dir（reply_direction の先頭60字）の定型の書き出しから読む（2段の約束・連絡待ち・手続きの質問 等）
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-judgement-gap.ts [--days=45] [--out=<jsonl>] [--samples=4]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene, type ReplyScene } from "../app/lib/reply-scene";
import { staffActsOf } from "../app/lib/customer-sim-shadow";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "45"));
const SINCE = arg("since", new Date(Date.now() - DAYS * 86_400_000).toISOString());
const OUT = arg("out");
const SAMPLES = Number(arg("samples", "4"));
const H = 3_600_000;
/** 2段の決まり（d1e4b1fe）が本番に入った時刻（10/02 13:41 JST のコミット・配備の後） */
const TWO_STAGE_LIVE = "2026-10-02T05:00:00Z";

type M = WindowMsg & { conversation_id: string };
type P = WindowPress & { conversation_id: string; suggested_action: string | null; picker_choices: unknown; send_mode: string | null };
type D = {
  id: string; conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null;
  suggested_check_pattern: string | null; decision_source: string | null; conversation_status: string | null; scene_evidence: string | null;
  analysis_mode: string | null; digest: Record<string, unknown> | null; suggested_next_steps: unknown;
};
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 500_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const POST = /^(?:applying|application|screening|contract|approved|closed_won)$/;
const PROP = /^property_(send|recommendation|pickup)$/;
const sameAix = (a: string, b: string) => a === b || (PROP.test(a) && PROP.test(b));
const ms = (s: string) => Date.parse(s);
const mask = (s: string) => s.replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "〈メール〉").replace(/https?:\/\/\S+/g, "〈URL〉");

/** ブレインが action を null にした訳（dir の書き出し・brain-core の定型の方向） */
function nullCause(d: D): string {
  const dir = String(d.digest?.dir ?? "");
  if (/お部屋をピックアップしてお送りすると約束する返信/.test(dir)) return "2段:ピックアップの約束";
  if (/募集状況と最大限割引した初期費用の御見積書をお送りすると約束/.test(dir)) return "2段:確認＋見積の約束";
  if (/(?:募集状況|聞かれた事).{0,30}確認すると約束する返信/.test(dir)) return "2段:確認の約束";
  if (/御見積書を作成しお送りすると約束する返信/.test(dir)) return "2段:見積書の約束";
  if (/お仕事面は弊社でサポート/.test(dir)) return "2段:お仕事面";
  if (/^お客様の連絡待ち/.test(dir)) return "連絡待ち";
  if (d.decision_source) return `src:${d.decision_source}`;
  return "LLM が AIX なし";
}
function promiseKind(acts: Set<string>): string | null {
  if (acts.has("check_promise")) return "check";
  if (acts.has("estimate_promise")) return "estimate";
  if (acts.has("pickup_promise")) return "pickup";
  return null;
}
const TWO_SET = /^(?:property_send|property_recommendation|property_search|property_check_result|acknowledge_check|estimate_sheet)$/;
const KEEP_SRC = /^(?:promise:|signal:pending_pickup|rule:closed_ack_wait|correction:check_already_declared)/;
/** 本番でほぼ押されない AIX（全期間の押下: guarantor_info 0・greeting_viewing 0・property_search 0・cost_explain 2・acknowledge_check 6） */
const UNUSED_AIX = /^(?:guarantor_info|greeting_viewing|property_search|cost_explain|acknowledge_check|followup_revive)$/;
const FAMILY: Record<string, RegExp> = { "2段:確認の約束": /^(?:property_check_result)$/, "2段:見積書の約束": /^estimate_sheet$/, "2段:確認＋見積の約束": /^(?:property_check_result|estimate_sheet)$/, "2段:ピックアップの約束": PROP };
/** ずれの型（1通の直しでなく型で数える） */
function causeOf(r: Record<string, unknown> & { type: string; brain: string; staff: string[] }): string {
  const acts = (r.acts as string[]) ?? [];
  const hasPromise = acts.some((a) => /_promise$/.test(a) && a !== "phone_promise");
  if (r.type === "AI返信×人AIX") {
    const nc = String(r.nullCause ?? "");
    if (nc.startsWith("2段")) {
      const fam = FAMILY[nc];
      if (fam && r.staff.some((a) => fam.test(a))) return hasPromise ? "R1a 2段どおり（約束の文＋同じまとまりで AIX）" : "R1b 2段の約束を飛ばして直に AIX（もう確かめた・作った）";
      return "R2 2段の種類違い（約束の種類と押した AIX が違う）";
    }
    if (nc === "src:guard:first_contact") return "R3 初回ガード（人は条件ヒアリング等を押す）";
    return r.nsMentionsStaffAix ? "R4a LLM の次の一手には書いたのに action なし" : "R4 LLM が AIX なし";
  }
  if (r.type === "AI_AIX×人返信") {
    if (UNUSED_AIX.test(r.brain)) return "A8 押されない種類の AIX（ボタンはあるが人は文で）";
    if (/^(?:viewing_invite|meeting_place)$/.test(r.brain)) return acts.includes("check_promise") ? "A5 内覧の前に確認が要る（内覧可否・時間外）" : "A6 内覧系を人は文で（日時の受け・段階）";
    if (r.brain === "application_push") return "A7 申込誘導を人は文で";
    const src = String(r.src ?? "");
    if (TWO_SET.test(r.brain)) {
      if (KEEP_SRC.test(src)) return hasPromise ? "A3a 約束・合図の AIX に人は約束の言い直し" : "A3b 約束・合図の AIX に人は別の答え";
      if (/^signal:/.test(src)) return "A4 合図（signal:*）の誤発火";
      if (hasPromise) return PROP.test(r.brain) && r.pendingPickupAtTurn ? "A1p 先に約束（売上サポの古い未送付で2段が効かない）" : "A1 先に約束（今の2段なら返信）";
      return "A2 質問・受けに AIX（LLM の飛び）";
    }
    return "A9 その他";
  }
  if (r.type === "別のAIX") {
    const s0 = r.staff.join(",");
    if (/(?:property_check_result|acknowledge_check)/.test(r.brain) && /estimate_sheet/.test(s0) || r.brain === "estimate_sheet" && /property_check_result/.test(s0)) return "O1 確認と見積の取り違え";
    if (PROP.test(r.brain) && /property_check_result|estimate_sheet/.test(s0)) return "O2 ピックアップ（約束）より先に確認・見積を果たした";
    if (/property_check_result|estimate_sheet/.test(r.brain) && /property_(send|recommendation)/.test(s0)) return "O3 確認・見積より新しい物件を送った";
    if (/viewing_invite|meeting_place/.test(r.brain + s0)) return "O4 内覧の段階の取り違え";
    return "O9 その他";
  }
  return "一致";
}
const PROMISE_AIX: Record<string, RegExp> = { check: /^(?:property_check_result|acknowledge_check|estimate_sheet)$/, estimate: /^estimate_sheet$/, pickup: PROP };

(async () => {
  const since = SINCE;
  const [msgs, presses, decs, pickups] = await Promise.all([
    readAll<M>((f, t) => sb.from("messages").select("conversation_id, sender, created_at, text, is_aix_generated").gte("created_at", new Date(ms(since) - 10 * 86_400_000).toISOString()).order("created_at").order("id").range(f, t)),
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at, suggested_action, picker_choices, send_mode").gte("created_at", new Date(ms(since) - 60 * 86_400_000).toISOString()).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<D>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, suggested_check_pattern, decision_source, conversation_status, scene_evidence, analysis_mode, digest, suggested_next_steps").gte("created_at", since).order("created_at").range(f, t)),
    readAll<{ conversation_id: string; status: string; created_at: string; sent_at: string | null }>((f, t) => sb.from("property_pickups").select("conversation_id, status, created_at, sent_at").not("conversation_id", "is", null).order("created_at").range(f, t)),
  ]);
  const pkBy = new Map<string, { status: string; created_at: string; sent_at: string | null }[]>();
  for (const k of pickups) { if (!pkBy.has(k.conversation_id)) pkBy.set(k.conversation_id, []); pkBy.get(k.conversation_id)!.push(k); }
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const mp = new Map<string, T[]>(); for (const r of rows) { if (!mp.has(r.conversation_id)) mp.set(r.conversation_id, []); mp.get(r.conversation_id)!.push(r); } return mp; };
  const mBy = by(msgs), pBy = by(presses);
  const turnDecs = new Map<string, D[]>();
  for (const d of decs) {
    if (!d.analyzed_msg_ts || isTestConversation(d.conversation_id)) continue;
    const k = `${d.conversation_id}|${new Date(d.analyzed_msg_ts).toISOString()}`;
    if (!turnDecs.has(k)) turnDecs.set(k, []);
    turnDecs.get(k)!.push(d);
  }
  type Row = Record<string, unknown> & { type: string; brain: string; staff: string[]; scene: ReplyScene };
  const rows: Row[] = [];
  /** 同じ連投の中の複数の判断（画像を続けて送った等）は1番にまとめる（連投の最後の発言に近い判断を採る） */
  const seenTurn = new Map<string, { idx: number; at: number }>();
  let skippedPost = 0, skippedOpen = 0, skippedSilent = 0;
  for (const [, ds] of turnDecs) {
    const d0 = ds[ds.length - 1];
    const conv = d0.conversation_id;
    const ps = pBy.get(conv) ?? [];
    const at = d0.analyzed_msg_ts!;
    if (POST.test(d0.conversation_status ?? "") || ps.some((p) => p.aix_type === "application_push" && ms(p.created_at) <= ms(at))) { skippedPost++; continue; }
    const mm = mBy.get(conv) ?? [];
    const w = staffWindowOf({ customerTurnAt: at, msgs: mm, presses: ps });
    if (!w.closed) { skippedOpen++; continue; }
    const bp = [...new Set(w.presses.filter((p) => p.burst).map((p) => p.aix_type))];
    const burstTexts = w.texts.filter((t) => t.burst).map((t) => t.text);
    const bt = burstTexts.join("\n");
    if (!bp.length && !bt && !w.aixMessagesBurst) { skippedSilent++; continue; }
    // スタッフが見た判断＝スタッフの最初の行動より前の最後の判断（無ければ最後）
    const sf = w.staffFirstAt ? ms(w.staffFirstAt) : Infinity;
    const seenList = ds.filter((d) => ms(d.created_at) <= sf);
    const d = seenList.length ? seenList[seenList.length - 1] : ds[ds.length - 1];
    const brainLate = !seenList.length;
    const brainAix = d.suggested_reply_mode === "aix" ? (d.suggested_action || "(種類なし)") : null;
    const brain = brainAix ?? "reply";
    const versions = [...new Set(ds.map((x) => (x.suggested_reply_mode === "aix" ? x.suggested_action || "(種類なし)" : "reply")))];
    // お客様の番の文（連投）
    const before = mm.filter((m) => ms(m.created_at) <= ms(w.customerLastAt));
    const burst: string[] = [];
    for (let i = before.length - 1; i >= 0; i--) { if (before[i].sender !== "customer") break; burst.unshift(before[i].text ?? ""); }
    const custText = burst.join("\n");
    const scene = resolveReplyScene({ customerText: custText }).scene;
    // 直前のこちらの文（番の前の最後のスタッフの発言）とその約束・その後に果たしたか
    const turnStartIdx = before.length - burst.length;
    const prevStaff = [...before.slice(0, turnStartIdx)].reverse().find((m) => m.sender !== "customer");
    const prevActs = prevStaff ? staffActsOf(prevStaff.is_aix_generated ? "" : prevStaff.text ?? "") : new Set<string>();
    const prevPromise = promiseKind(prevActs as Set<string>);
    const prevPromiseFulfilled = prevPromise && prevStaff ? ps.some((p) => ms(p.created_at) > ms(prevStaff.created_at) && ms(p.created_at) <= ms(at) && PROMISE_AIX[prevPromise].test(p.aix_type ?? "")) : false;
    const prevIsAix = !!prevStaff?.is_aix_generated;
    // スタッフの行動
    const acts = [...staffActsOf(bt)];
    const laterInWindow = [...new Set(w.presses.filter((p) => !p.burst).map((p) => p.aix_type))];
    const after72 = ps.filter((p) => ms(p.created_at) > ms(w.endAt) && ms(p.created_at) <= ms(w.customerLastAt) + 72 * H).map((p) => p.aix_type as string);
    const latencyMin = w.staffFirstAt ? Math.round((ms(w.staffFirstAt) - ms(w.customerLastAt)) / 60000) : null;
    const textFirst = bp.length > 0 && burstTexts.length > 0;
    const pressRow = ps.find((p) => p.aix_type === bp[0] && ms(p.created_at) > ms(w.customerLastAt) && ms(p.created_at) < ms(w.endAt));
    let se: Record<string, unknown> | null = null; try { se = d.scene_evidence ? JSON.parse(d.scene_evidence) : null; } catch { se = null; }
    const agree = brain === "reply" ? !bp.length : bp.some((a) => sameAix(a, brain));
    const type = agree ? "一致" : brain === "reply" ? "AI返信×人AIX" : !bp.length ? "AI_AIX×人返信" : "別のAIX";
    // その時点の売上サポの未送付（brain-core の pickupReady と同じ: status=pending が1件でもあれば「送れる物がある」）
    const pend = (pkBy.get(conv) ?? []).filter((k) => ms(k.created_at) <= ms(at) && (k.status === "pending" || (k.sent_at && ms(k.sent_at) > ms(at))));
    const pendingPickupAtTurn = pend.length > 0;
    const pendingNewestAgeD = pend.length ? Math.round((ms(at) - Math.max(...pend.map((k) => ms(k.created_at)))) / 86_400_000 * 10) / 10 : null;
    const nextSteps = Array.isArray(d.suggested_next_steps) ? (d.suggested_next_steps as string[]).join(" / ") : "";
    const tkey = `${conv}|${ms(w.customerLastAt)}`;
    const prevSeen = seenTurn.get(tkey);
    if (prevSeen && prevSeen.at >= ms(at)) continue;
    const row = {
      period: ms(at) >= ms(TWO_STAGE_LIVE) ? "2段の後" : "2段の前",
      type, conv, at, scene, brain, brainCp: d.suggested_check_pattern, src: d.decision_source, nullCause: brain === "reply" ? nullCause(d) : null,
      seCand: se?.candidate ?? null, seScene: se?.scene ?? null, seReason: se?.reason ?? null, mode: d.analysis_mode, status: d.conversation_status,
      brainLate, versions, brainLagSec: Math.round((ms(d.created_at) - ms(w.customerLastAt)) / 1000), latencyMin,
      staff: bp.length ? bp : ["reply"], staffCp: pressRow?.check_pattern ?? null, pressSuggested: pressRow?.suggested_action ?? null, textFirst, acts, laterInWindow, after72,
      prevPromise, prevPromiseFulfilled, prevIsAix, prevStaffAgoH: prevStaff ? Math.round((ms(at) - ms(prevStaff.created_at)) / H * 10) / 10 : null,
      nsMentionsStaffAix: bp.length ? bp.some((a) => nextSteps.includes(a) || String(d.digest?.dir ?? "").includes(a)) : false,
      dir: String(d.digest?.dir ?? "").slice(0, 60), intent: d.digest?.intent ?? null, ns: nextSteps.slice(0, 240),
      pendingPickupAtTurn, pendingNewestAgeD,
      customer: mask(custText).slice(0, 220), staffText: mask(bt).slice(0, 220), prevStaffText: mask(prevStaff?.text ?? "").slice(0, 140),
    } as Row;
    row.cause = causeOf(row);
    if (prevSeen) rows[prevSeen.idx] = row; else { seenTurn.set(tkey, { idx: rows.length, at: ms(at) }); rows.push(row); continue; }
    seenTurn.set(tkey, { idx: prevSeen.idx, at: ms(at) });
  }
  const n = rows.length;
  const pct = (x: number, base = n) => `${x}（${Math.round((x / Math.max(1, base)) * 100)}%）`;
  const count = <T>(xs: T[], f: (x: T) => string | string[]) => { const m = new Map<string, number>(); for (const x of xs) { const v = f(x); for (const k of Array.isArray(v) ? v : [v]) m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
  const fmt = (xs: [string, number][], base: number, top = 12) => xs.slice(0, top).map(([k, v]) => `${k} ${v}（${Math.round((v / Math.max(1, base)) * 100)}%）`).join("・");
  console.log(`期間 ${since.slice(0, 10)}〜（YUMA・申込以降・沈黙・窓が開いている番を除く）番 ${n}｜除外: 申込以降 ${skippedPost}・窓が開 ${skippedOpen}・スタッフ無し ${skippedSilent}`);
  for (const [t, c] of count(rows, (r) => r.type)) console.log(`  ${t}: ${pct(c)}`);
  for (const per of ["2段の前", "2段の後"]) { const rs = rows.filter((r) => r.period === per); console.log(`  [${per}] n=${rs.length} ${fmt(count(rs, (r) => r.type), rs.length)}`); }

  const r2a = rows.filter((r) => r.type === "AI返信×人AIX");
  console.log(`\n■ AI返信×人AIX ${r2a.length}`);
  console.log(`  押した AIX: ${fmt(count(r2a, (r) => r.staff), r2a.length)}`);
  console.log(`  ブレインが AIX なしにした訳: ${fmt(count(r2a, (r) => r.nullCause as string), r2a.length)}`);
  console.log(`  場面の証拠の候補＝押した AIX: ${pct(r2a.filter((r) => r.seCand && r.staff.some((a) => sameAix(a, String(r.seCand)))).length, r2a.length)}｜候補あり ${r2a.filter((r) => r.seCand).length}`);
  console.log(`  ブレイン自身の次の一手/方向に押した AIX の名: ${pct(r2a.filter((r) => r.nsMentionsStaffAix).length, r2a.length)}`);
  console.log(`  同じ番の判断の版のどれかが押した AIX: ${pct(r2a.filter((r) => (r.versions as string[]).some((v) => r.staff.some((a) => sameAix(a, v)))).length, r2a.length)}`);
  console.log(`  ブレインの判断がスタッフの行動より後: ${pct(r2a.filter((r) => r.brainLate).length, r2a.length)}`);
  console.log(`  文も打ってから AIX: ${pct(r2a.filter((r) => r.textFirst).length, r2a.length)}`);
  console.log(`  直前のこちらの文が約束: ${fmt(count(r2a, (r) => `${r.prevPromise ?? "約束なし"}${r.prevPromise ? (r.prevPromiseFulfilled ? "(果たし済)" : "(未)") : ""}`), r2a.length)}`);
  console.log(`  返事まで: ${fmt(count(r2a, (r) => (r.latencyMin == null ? "?" : (r.latencyMin as number) < 10 ? "<10分" : (r.latencyMin as number) < 60 ? "10-60分" : (r.latencyMin as number) < 360 ? "1-6時間" : "6時間+")), r2a.length)}`);
  console.log(`  場面: ${fmt(count(r2a, (r) => r.scene), r2a.length)}`);
  console.log(`  訳×押した AIX: ${fmt(count(r2a, (r) => r.staff.map((a) => `${r.nullCause}→${a}`)), r2a.length, 20)}`);

  const a2r = rows.filter((r) => r.type === "AI_AIX×人返信");
  console.log(`\n■ AI_AIX×人返信 ${a2r.length}`);
  console.log(`  ブレインの AIX: ${fmt(count(a2r, (r) => r.brain), a2r.length)}`);
  console.log(`  出どころ: ${fmt(count(a2r, (r) => String(r.src ?? "null").replace(/\(.*$/, "").replace(/\+ack_to_check/, "")), a2r.length)}`);
  console.log(`  スタッフの文の行為: ${fmt(count(a2r, (r) => ((r.acts as string[]).length ? (r.acts as string[]) : ["(行為なし・答え/受け)"])), a2r.length, 16)}`);
  console.log(`  後でその AIX を押した（窓の中）: ${pct(a2r.filter((r) => (r.laterInWindow as string[]).some((a) => sameAix(a, r.brain))).length, a2r.length)}｜72時間以内: ${pct(a2r.filter((r) => [...(r.laterInWindow as string[]), ...(r.after72 as string[])].some((a) => sameAix(a, r.brain))).length, a2r.length)}`);
  console.log(`  ブレインの判断がスタッフの行動より後: ${pct(a2r.filter((r) => r.brainLate).length, a2r.length)}`);
  console.log(`  直前のこちらの文が約束: ${fmt(count(a2r, (r) => `${r.prevPromise ?? "約束なし"}${r.prevPromise ? (r.prevPromiseFulfilled ? "(果たし済)" : "(未)") : ""}`), a2r.length)}`);
  console.log(`  場面: ${fmt(count(a2r, (r) => r.scene), a2r.length)}`);
  console.log(`  AIX×スタッフの行為: ${fmt(count(a2r, (r) => `${r.brain}→${(r.acts as string[])[0] ?? "答え/受け"}`), a2r.length, 20)}`);

  const oth = rows.filter((r) => r.type === "別のAIX");
  console.log(`\n■ 別のAIX ${oth.length}`);
  console.log(`  ブレイン→押した: ${fmt(count(oth, (r) => r.staff.map((a) => `${r.brain}→${a}${a === "property_check_result" && r.staffCp ? `/${r.staffCp}` : ""}`)), oth.length, 25)}`);
  console.log(`  出どころ: ${fmt(count(oth, (r) => String(r.src ?? "null").replace(/\(.*$/, "")), oth.length)}`);

  const ag = rows.filter((r) => r.type === "一致");
  console.log(`\n■ 一致 ${ag.length}: ${fmt(count(ag, (r) => r.brain), ag.length)}`);
  console.log(`\n■ 場面ごとの一致`);
  for (const [s] of count(rows, (r) => r.scene)) {
    const rs = rows.filter((r) => r.scene === s);
    console.log(`  ${s.padEnd(15)} n=${rs.length} ${fmt(count(rs, (r) => r.type), rs.length)}`);
  }
  console.log(`\n■ ブレインの道ごとの一致（AIX の種類別・その AIX を出した番のうちスタッフが同じ AIX を押した率）`);
  for (const [b, c] of count(rows, (r) => r.brain)) {
    const rs = rows.filter((r) => r.brain === b);
    console.log(`  ${b.padEnd(26)} n=${c} 一致 ${pct(rs.filter((r) => r.type === "一致").length, c)}｜人の行動: ${fmt(count(rs, (r) => r.staff), c, 5)}`);
  }
  console.log(`
■ ずれの型（全期間・2段の前・2段の後）`);
  const gaps = rows.filter((r) => r.type !== "一致");
  const pre = rows.filter((r) => r.period === "2段の前"), post = rows.filter((r) => r.period === "2段の後");
  for (const [c, k] of count(gaps, (r) => String(r.cause))) {
    const a = pre.filter((r) => r.cause === c).length, b = post.filter((r) => r.cause === c).length;
    console.log(`  ${c.padEnd(40)} ${String(k).padStart(4)}（全番の${Math.round((k / n) * 100)}%）｜前 ${a}/${pre.length}（${Math.round((a / Math.max(1, pre.length)) * 100)}%）｜後 ${b}/${post.length}（${Math.round((b / Math.max(1, post.length)) * 100)}%）`);
  }
  const a1 = rows.filter((r) => PROP.test(r.brain) && r.type === "AI_AIX×人返信");
  console.log(`  物件の AIX×人返信 ${a1.length} のうち 売上サポに未送付あり ${a1.filter((r) => r.pendingPickupAtTurn).length}（一番新しい未送付の古さ 中央 ${(() => { const xs = a1.filter((r) => r.pendingPickupAtTurn).map((r) => r.pendingNewestAgeD as number).sort((x, y) => x - y); return xs.length ? xs[Math.floor(xs.length / 2)] : "-"; })()}日）`);
  const postP = post.filter((r) => PROP.test(r.brain));
  console.log(`  2段の後 ブレイン=物件の AIX ${postP.length}: 未送付あり ${postP.filter((r) => r.pendingPickupAtTurn).length}・その古さ ${postP.filter((r) => r.pendingPickupAtTurn).map((r) => r.pendingNewestAgeD).join(",")}`);
  // 代表例
  for (const t of ["AI返信×人AIX", "AI_AIX×人返信", "別のAIX"]) {
    console.log(`\n--- 代表例 ${t}`);
    const rs = rows.filter((r) => r.type === t);
    const groups = count(rs, (r) => t === "AI返信×人AIX" ? `${r.nullCause}→${r.staff[0]}` : t === "AI_AIX×人返信" ? `${r.brain}→${(r.acts as string[])[0] ?? "答え/受け"}` : `${r.brain}→${r.staff[0]}`).slice(0, 6);
    for (const [g] of groups) {
      const ex = rs.filter((r) => (t === "AI返信×人AIX" ? `${r.nullCause}→${r.staff[0]}` : t === "AI_AIX×人返信" ? `${r.brain}→${(r.acts as string[])[0] ?? "答え/受け"}` : `${r.brain}→${r.staff[0]}`) === g).slice(0, SAMPLES);
      console.log(`  [${g}]`);
      for (const r of ex) console.log(`    ${String(r.at).slice(0, 16)} ${String(r.conv).slice(0, 8)} 場面=${r.scene} 前=${r.prevStaffText ? `「${String(r.prevStaffText).replace(/\n/g, " ").slice(0, 50)}」` : "-"}\n      客「${String(r.customer).replace(/\n/g, " ").slice(0, 90)}」\n      人「${String(r.staffText).replace(/\n/g, " ").slice(0, 90)}」 押=${r.staff.join(",")}${r.staffCp ? `/${r.staffCp}` : ""} 遅れ=${r.latencyMin}分 dir=${String(r.dir).slice(0, 50)}`);
    }
  }
  if (OUT) writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
