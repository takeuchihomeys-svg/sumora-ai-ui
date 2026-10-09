// scripts/audit-brain-handoff-signals.ts — 2026-10-09 竹内さんとの打ち合わせ「4. ブレインが分からない時はスタッフに渡す」の準備の数字（読むだけ・LLM なし・$0）
//   ブレインの判断（brain_decision_logs）× スタッフの一手（line-watch-judge.staffWindowOf の返事のまとまり・aix_usage_logs の種類×ピッカー）を番ごとに結び、
//   「外れた番」と「当たった番」を分け、判断の時点で決定論で取れる印ごとに外れの率を出す。印を組み合わせた時の拾える割合（出す番の割合との釣り合い）も出す。
//
//   外れの決め方（既存の決まった計算に合わせる）:
//     道 … brain-exam-score.brainPathCode と同じ読み方（reply_mode=aix＋action → AIX／初回ガード → 2段／digest.dir の定型の書き出し → 2段・なし・返信）
//           スタッフ: 返事のまとまりで押した AIX → AIX:種類（物件の4種は同じ族・acknowledge_check は物件確認した）／押さず文だけ → 返信
//     当たり … line-watch-judge.judgeTurn の道の部分と同じ: AIX 同じ族（まとまりの外でも窓の中で押せば当たり）／確認の AIX に手打ちの確認の宣言（aix_ack_by_text）
//              ／2段の約束の返信×その約束を果たす AIX を直接（two_stage_fulfilled）／返信×返信
//     外れ … 返信×人 AIX・AIX×人返信・別の AIX。加えて「返信の番に人だけが知る事を手打ち（text-diff-types.isStaffOnlyReport）」＝本来 AIX の番（絶対ルール③）も外れ（--no-staff-only で外す）
//     文の外れ（9/28〜の line_watch_turns の verdict が partial/different・返信の道が当たった番だけ）は別の表に出す
//   除く: テストの会話・申込以降・申込へ を押した後・スタッフが何も送っていない番・窓が閉じていない番
// 実行: npx tsx --env-file=.env.local scripts/audit-brain-handoff-signals.ts [--days=60|--since=2026-10-02T05:00:00Z] [--writer=A|all] [--out=<jsonl>] [--samples=3] [--no-staff-only]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { staffWindowOf, type WindowMsg, type WindowPress } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { subSceneOf } from "../app/lib/reply-subscene";
import { staffActsOf } from "../app/lib/customer-sim-shadow";
import { currentTurnRequests } from "../app/lib/request-ledger";
import { detectSensitiveCase } from "../app/lib/sensitive-case";
import { isStaffOnlyReport } from "../app/lib/text-diff-types";
import { pathOfDirection } from "./lib/brain-exam-score";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "60"));
const SINCE = arg("since", new Date(Date.now() - DAYS * 86_400_000).toISOString());
const OUT = arg("out");
const SAMPLES = Number(arg("samples", "3"));
const STAFF_ONLY_IS_MISS = !process.argv.includes("--no-staff-only");
const H = 3_600_000;
const ms = (s: string) => Date.parse(s);
const jstHour = (s: string) => (new Date(ms(s)).getUTCHours() + 9) % 24;
const mask = (s: string) => String(s ?? "").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "〈メール〉").replace(/https?:\/\/\S+/g, "〈URL〉").replace(/\d{3}-?\d{4}/g, "〈番号〉").replace(/\n/g, " ");

type M = WindowMsg & { id: string; conversation_id: string; image_url: string | null; quoted_message_id: string | null; staff_writer: string | null };
type P = WindowPress & { conversation_id: string };
type D = {
  id: string; conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null;
  suggested_check_pattern: string | null; decision_source: string | null; conversation_status: string | null; analysis_mode: string | null; digest: Record<string, unknown> | null;
};
type LW = { conversation_id: string; customer_last_at: string | null; verdict: string | null; verdict_detail: Record<string, unknown> | null };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 1_000_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const POST = /^(?:applying|application|screening|contract|approved|closed_won)$/;
const PROP = /^property_(?:send|recommendation|pickup|search)$/;
const fam = (a: string) => (PROP.test(a) ? "物件" : a === "acknowledge_check" ? "property_check_result" : a);
const CHECK_AIX = /^(?:property_check_result|acknowledge_check)$/;
const PROP_CARD = /(?:万円|号室|徒歩\s*\d+\s*分|㎡|築\s*\d+)/;

/** ブレインの道（brainPathCode と同じ読み方・DB の列から） */
function brainPath(d: D): { path: "AIX" | "2段" | "返信" | "なし"; aix: string | null; kind: string } {
  const a = (d.suggested_action ?? "").trim();
  if (d.suggested_reply_mode === "aix" && a) return { path: "AIX", aix: a, kind: "" };
  if (/^guard:first_contact/.test(d.decision_source ?? "") && a) return { path: "2段", aix: null, kind: a === "property_check_result" ? "check" : "pickup" };
  const p = pathOfDirection(String(d.digest?.dir ?? ""));
  if (p.path === "2段") return { path: "2段", aix: null, kind: p.kind };
  if (p.path === "なし") return { path: "なし", aix: null, kind: "" };
  return { path: "返信", aix: null, kind: p.kind };
}
const fulfils = (kind: string, a: string) => (kind === "pickup" && PROP.test(a)) || (kind === "check" && (CHECK_AIX.test(a) || a === "estimate_sheet")) || (kind === "estimate" && a === "estimate_sheet") || (kind === "photo" && a === "property_check_result");

type Row = Record<string, unknown> & { miss: boolean; missType: string; sig: Record<string, boolean>; writer: string; conv: string; at: string; half: 0 | 1 };

(async () => {
  const [msgs, presses, decs, lws] = await Promise.all([
    readAll<M>((f, t) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, image_url, quoted_message_id, staff_writer").order("created_at").order("id").range(f, t)),
    readAll<P>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, created_at").not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<D>((f, t) => sb.from("brain_decision_logs").select("id, conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, suggested_check_pattern, decision_source, conversation_status, analysis_mode, digest").gte("created_at", SINCE).order("created_at").range(f, t)),
    readAll<LW>((f, t) => sb.from("line_watch_turns").select("conversation_id, customer_last_at, verdict, verdict_detail").not("verdict", "is", null).range(f, t)),
  ]);
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const mp = new Map<string, T[]>(); for (const r of rows) { if (!mp.has(r.conversation_id)) mp.set(r.conversation_id, []); mp.get(r.conversation_id)!.push(r); } return mp; };
  const mBy = by(msgs), pBy = by(presses);
  const msgIdx = new Map<string, { conv: string; i: number }>();
  for (const [c, mm] of mBy) mm.forEach((m, i) => msgIdx.set(m.id, { conv: c, i }));
  const lwBy = new Map<string, LW>();
  for (const l of lws) if (l.customer_last_at) lwBy.set(`${l.conversation_id}|${Math.round(ms(l.customer_last_at) / 1000)}`, l);
  const turnDecs = new Map<string, D[]>();
  for (const d of decs) {
    if (!d.analyzed_msg_ts || isTestConversation(d.conversation_id)) continue;
    const k = `${d.conversation_id}|${new Date(d.analyzed_msg_ts).toISOString()}`;
    if (!turnDecs.has(k)) turnDecs.set(k, []);
    turnDecs.get(k)!.push(d);
  }
  const rows: Row[] = [];
  const seenTurn = new Map<string, number>();
  let skippedPost = 0, skippedOpen = 0, skippedSilent = 0;
  for (const [, ds] of turnDecs) {
    const conv = ds[0].conversation_id;
    const ps = pBy.get(conv) ?? [];
    const at = ds[ds.length - 1].analyzed_msg_ts!;
    if (POST.test(ds[ds.length - 1].conversation_status ?? "") || ps.some((p) => p.aix_type === "application_push" && ms(p.created_at) <= ms(at))) { skippedPost++; continue; }
    const mm = mBy.get(conv) ?? [];
    const w = staffWindowOf({ customerTurnAt: at, msgs: mm, presses: ps });
    if (!w.closed) { skippedOpen++; continue; }
    const bp = [...new Set(w.presses.filter((p) => p.burst).map((p) => p.aix_type))];
    const bpFull = w.presses.filter((p) => p.burst);
    const allP = [...new Set(w.presses.map((p) => p.aix_type))];
    const burstTexts = w.texts.filter((t) => t.burst).map((t) => t.text);
    const bt = burstTexts.join("\n");
    if (!bp.length && !bt && !w.aixMessagesBurst) { skippedSilent++; continue; }
    const tkey = `${conv}|${ms(w.customerLastAt)}`;
    const sf = w.staffFirstAt ? ms(w.staffFirstAt) : Infinity;
    const seenList = ds.filter((d) => ms(d.created_at) <= sf);
    const d = seenList.length ? seenList[seenList.length - 1] : ds[ds.length - 1];
    const brainLate = !seenList.length;
    const b = brainPath(d);
    const routeOf = (x: D) => { const p = brainPath(x); return p.path === "AIX" ? `AIX:${fam(p.aix!)}` : p.path === "2段" ? `2段:${p.kind}` : p.path; };
    const routes = new Set(ds.map(routeOf));
    // お客様の番（連投）
    const before = mm.filter((m) => ms(m.created_at) <= ms(w.customerLastAt));
    const burst: M[] = [];
    for (let i = before.length - 1; i >= 0; i--) { if (before[i].sender !== "customer") break; burst.unshift(before[i]); }
    const custText = burst.map((m) => m.text ?? "").join("\n");
    const custPlain = custText.replace(/\[画像\][\s\S]*?(?=\n\n|$)/g, "[画像]");
    const scene = resolveReplyScene({ customerText: custText }).scene;
    const turnStart = before.length - burst.length;
    const prevBurst: M[] = [];
    for (let i = turnStart - 1; i >= 0; i--) { if (before[i].sender === "customer") break; prevBurst.unshift(before[i]); }
    const prevStaff = prevBurst[prevBurst.length - 1];
    const sub = subSceneOf({ customerText: custText, prevStaffText: prevStaff?.text ?? null, scene });
    // ── スタッフの一手と当たり外れ ──
    const acts = staffActsOf(bt);
    let hit = false, missType = "", subHit = "";
    const staffOnly = !bp.length && isStaffOnlyReport(bt);
    if (b.path === "AIX") {
      const f = fam(b.aix!);
      if (bp.length) { hit = bp.some((a) => fam(a!) === f); missType = hit ? "" : "別のAIX"; subHit = hit ? "まとまりで同じAIX" : ""; }
      else if (allP.some((a) => fam(a!) === f)) { hit = true; subHit = "窓の中で後から同じAIX"; }
      else if (CHECK_AIX.test(b.aix!) && acts.has("check_promise")) { hit = true; subHit = "確認のAIXを手打ちの確認の宣言で"; }
      else missType = "AIX×人返信";
    } else {
      if (bp.length) {
        if (b.path === "2段" && bp.some((a) => fulfils(b.kind, a!))) { hit = true; subHit = "2段どおり（約束を果たすAIXを直接）"; }
        else missType = "返信×人AIX";
      } else if (staffOnly && STAFF_ONLY_IS_MISS) missType = "返信×人だけが知る事を手打ち（本来AIX）";
      else if (b.path === "なし") missType = "なし×人は返した";
      else { hit = true; subHit = b.path === "2段" ? "2段×返信" : "返信×返信"; }
    }
    // ピッカーの違い（物件確認した）: 当たりのうち、ピッカーまで比べると違う
    const staffCp = bpFull.find((p) => CHECK_AIX.test(p.aix_type))?.check_pattern ?? null;
    const pickerDiff = hit && b.path === "AIX" && CHECK_AIX.test(b.aix!) && !!staffCp && !!d.suggested_check_pattern && staffCp !== d.suggested_check_pattern;
    // 細かい外れ（約束の有無）: 返信×返信の当たりのうち、2段の約束の有無が違う
    const staffPromise = acts.has("check_promise") || acts.has("pickup_promise") || acts.has("estimate_promise");
    const promiseDiff = hit && !bp.length && b.path !== "AIX" && ((b.path === "2段") !== staffPromise);
    // 文の外れ（line_watch_turns・9/28〜）
    const lw = lwBy.get(`${conv}|${Math.round(ms(w.customerLastAt) / 1000)}`);
    const textVerdict = lw?.verdict ?? null;
    const textMiss = hit && b.path !== "AIX" && !bp.length && (textVerdict === "partial" || textVerdict === "different");
    // 書き手（返事のまとまりの文・AIX の送信の staff_writer）
    const burstStaffMsgs = mm.filter((m) => m.sender !== "customer" && ms(m.created_at) > ms(w.customerLastAt) && ms(m.created_at) <= ms(w.endAt));
    const wc = new Map<string, number>(); for (const m of burstStaffMsgs) if (m.staff_writer) wc.set(m.staff_writer, (wc.get(m.staff_writer) ?? 0) + 1);
    const writer = (wc.get("takeuchi") ?? 0) > 0 && (wc.get("takeuchi") ?? 0) >= (wc.get("employee") ?? 0) ? "A" : (wc.get("employee") ?? 0) > 0 ? "B" : "?";
    // ── 判断の時点で取れる印 ──
    const dg = d.digest ?? {};
    const prevPropCards = prevBurst.filter((m) => PROP_CARD.test(m.text ?? "")).length;
    const prevPressProps = ps.filter((p) => PROP.test(p.aix_type ?? "") && prevStaff && ms(p.created_at) <= ms(prevStaff.created_at) + 60_000 && ms(p.created_at) >= ms(prevBurst[0].created_at) - 60_000).length;
    const quoted = burst.map((m) => m.quoted_message_id).filter(Boolean) as string[];
    const quoteFar = quoted.some((q) => { const x = msgIdx.get(q); return x && x.conv === conv && before.length - x.i > 20; });
    const qCount = (custPlain.match(/[？?]|ますか|でしょうか|ですか/g) ?? []).length;
    const nPrevMsgs = turnStart;
    const prevAnyAt = turnStart > 0 ? before[turnStart - 1].created_at : null;
    const gapDays = prevAnyAt ? (ms(burst[0]?.created_at ?? at) - ms(prevAnyAt)) / 86_400_000 : null;
    const sentPropsBefore = ps.filter((p) => PROP.test(p.aix_type ?? "") && ms(p.created_at) < ms(at)).length;
    const reqs = currentTurnRequests(before.map((m) => ({ sender: m.sender, text: m.text, createdAt: m.created_at, isAix: m.is_aix_generated })));
    const emo = String(dg.emo ?? "");
    const sens = detectSensitiveCase(custText);
    const src = d.decision_source ?? "";
    const custHour = jstHour(w.customerLastAt);
    const night = custHour >= 22 || custHour < 9;
    const lagMin = (ms(d.created_at) - ms(w.customerLastAt)) / 60000;
    const deictic = /(?:こちら|そちら|それ|これ|あれ|この|その|あの)(?:の)?(?:物件|お部屋|部屋|件)?/.test(custPlain) && !/(?:号室|マンション|レジデンス|ハイツ|コーポ|メゾン|https?:)/.test(custPlain);
    const oldRef = /(?:さっき|先ほど|先程|前に|以前|前回|この前|昨日の|前の|最初の|1番目|一番目|上の)/.test(custPlain);
    const sig: Record<string, boolean> = {
      "主語:直前のこちらの送信に物件が複数": prevPropCards >= 2 || prevPressProps >= 2,
      "主語:画像の直後（お客様の番に画像）": /\[画像\]/.test(custText),
      "主語:引用リプライ": quoted.length > 0,
      "主語:引用が20通の窓の外": quoteFar,
      "主語:指す語だけ（こちら・その 等・物件名なし）": deictic,
      "主語:前の話題を指す（さっき・前の 等）": oldRef,
      "材料:話題の物件が特定できない（digest.prop 空・物件の場面）": !dg.prop && /^(?:cost|property_share|viewing|question)$/.test(scene),
      "材料:物件をまだ1件も送っていない": sentPropsBefore === 0,
      "材料:会話が20通の窓より長い": nPrevMsgs > 20,
      "材料:会話が60通超": nPrevMsgs > 60,
      "材料:7日以上ぶりの発言": gapDays != null && gapDays >= 7,
      "場面:小場面の出現が少ない（≤5）": false, // 後で数える
      "場面:小場面の出現が少ない（≤15）": false,
      "場面:小場面の出現が少ない（≤40）": false,
      "依頼:1つの連投に依頼が2件以上": reqs.length >= 2,
      "依頼:依頼が3件以上": reqs.length >= 3,
      "気持ち:迷い・不安・不満・離れかけ（digest.emo）": /迷い|不安|不満|離れかけ/.test(emo),
      "気持ち:保留の型あり（digest.hes）": !!dg.hes,
      "気持ち:クレーム・否決・キャンセル（sensitive-case）": !!sens,
      "規則:決定論の規則が答えを決めた（decision_source が llm 以外）": !!src && !/^llm/.test(src),
      "規則:signal:*": /^signal:/.test(src),
      "規則:promise:*": /^promise:/.test(src),
      "規則:guard:*": /^guard:/.test(src),
      "規則:correction:*/rule:*/no_aix:*": /^(?:correction|rule|no_aix):/.test(src),
      "古さ:判断がスタッフの最初の一手に間に合っていない": brainLate,
      "古さ:判断まで10分超": lagMin > 10,
      "古さ:全体分析（full/incremental＝T2/T3 相当）": /^(?:full|incremental)$/.test(d.analysis_mode ?? ""),
      "古さ:夜（22〜9時）の発言を朝に判断（見送りの後）": night && lagMin > 60,
      "割れ:同じ番の判断の版で道が割れた（案B の代わり）": routes.size >= 2,
      "長さ:お客様の文が120字超": custPlain.replace(/\[画像\]/g, "").length > 120,
      "長さ:疑問が2つ以上": qCount >= 2,
      "時刻:夜（22〜9時）の発言": night,
      "2択:ブレインが2択をセット（digest.tc・10/08〜）": dg.tc === true,
      "道:ブレインが AIX": b.path === "AIX",
      "道:ブレインが2段の約束": b.path === "2段",
    };
    const row: Row = {
      conv, at, half: 0, writer, miss: !hit, missType: hit ? "" : missType, subHit, pickerDiff, promiseDiff, textVerdict, textMiss,
      scene, sub, brain: b.path === "AIX" ? `AIX:${b.aix}${d.suggested_check_pattern ? "/" + d.suggested_check_pattern : ""}` : b.path === "2段" ? `2段:${b.kind}` : b.path,
      staff: bp.length ? bpFull.map((p) => `${p.aix_type}${p.check_pattern ? "/" + p.check_pattern : ""}`).join(",") : `返信${[...acts].filter((a) => /_promise$/.test(a)).length ? "（" + [...acts].filter((a) => /_promise$/.test(a)).join(",") + "）" : ""}`,
      src, emo, nReq: reqs.length, sig,
      customer: mask(custPlain).slice(0, 160), staffText: mask(bt).slice(0, 140), prevStaffText: mask(prevStaff?.text ?? "").slice(0, 80), dir: String(dg.dir ?? "").slice(0, 60),
    };
    const prevI = seenTurn.get(tkey);
    if (prevI != null) { if (ms(String(rows[prevI].at)) < ms(at)) rows[prevI] = row; continue; }
    seenTurn.set(tkey, rows.length); rows.push(row);
  }
  // 珍しい小場面（本番の全期間のお客様の番＝連投ごとの出現数で。判断のない番も含めて数える）
  const subCount = new Map<string, number>();
  for (const [c, mm] of mBy) {
    if (isTestConversation(c)) continue;
    let i = 0;
    while (i < mm.length) {
      if (mm[i].sender !== "customer") { i++; continue; }
      let j = i; const parts: string[] = [];
      while (j < mm.length && mm[j].sender === "customer") { parts.push(mm[j].text ?? ""); j++; }
      const s = subSceneOf({ customerText: parts.join("\n"), prevStaffText: i > 0 ? mm[i - 1].text ?? null : null });
      subCount.set(s, (subCount.get(s) ?? 0) + 1);
      i = j;
    }
  }
  console.log(`小場面の種類 ${subCount.size}・本番のお客様の番 ${[...subCount.values()].reduce((a, b) => a + b, 0)}`);
  for (const r of rows) {
    const c = subCount.get(String(r.sub)) ?? 0; r.subN = c;
    r.sig["場面:小場面の出現が少ない（≤5）"] = c <= 5; r.sig["場面:小場面の出現が少ない（≤15）"] = c <= 15; r.sig["場面:小場面の出現が少ない（≤40）"] = c <= 40;
  }
  // 文まで含めた外れ（--label=full）: 道の外れ＋返信の道が当たった番の文の外れ（line_watch_turns の verdict がある番だけ）。文の判定が無い返信の番は数えない
  if (arg("label", "route") === "full") {
    const keep = rows.filter((r) => r.miss || String(r.brain).startsWith("AIX") || /^[a-z]/.test(String(r.staff)) || !!r.textVerdict);
    rows.length = 0; rows.push(...keep);
    for (const r of rows) if (r.textMiss) { r.miss = true; r.missType = `文の外れ（${r.textVerdict}）`; }
    console.log(`ラベル=道＋文（文の判定がある返信の番だけ残す）`);
  }
  rows.sort((a, b) => ms(a.at) - ms(b.at));
  rows.forEach((r, i) => { r.half = i < rows.length / 2 ? 0 : 1; });

  const WRITER = arg("writer", "all");
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
  const sigNames = Object.keys(rows[0]?.sig ?? {});
  console.log(`期間 ${SINCE.slice(0, 10)}〜（brain_decision_logs は 2026-09-05 から）｜番 ${rows.length}｜除外: 申込以降 ${skippedPost}・窓が開 ${skippedOpen}・スタッフ無し ${skippedSilent}｜人だけが知る事の手打ちを外れに数える=${STAFF_ONLY_IS_MISS}`);
  for (const wr of WRITER === "all" ? ["全員", "A"] : [WRITER]) {
    const rs = wr === "全員" ? rows : rows.filter((r) => r.writer === wr);
    const miss = rs.filter((r) => r.miss).length;
    console.log(`\n================ 書き手=${wr} 番 ${rs.length}・外れ ${miss}（${pct(miss, rs.length)}）================`);
    const mt = new Map<string, number>(); for (const r of rs) if (r.miss) mt.set(r.missType, (mt.get(r.missType) ?? 0) + 1);
    console.log(`  外れの型: ${[...mt].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
    const sh = new Map<string, number>(); for (const r of rs) if (!r.miss) sh.set(String(r.subHit), (sh.get(String(r.subHit)) ?? 0) + 1);
    console.log(`  当たりの内訳: ${[...sh].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  当たりのうち ピッカー違い ${rs.filter((r) => r.pickerDiff).length}・約束の有無が違う ${rs.filter((r) => r.promiseDiff).length}`);
    const tv = rs.filter((r) => r.textVerdict && !r.miss && String(r.brain).match(/^(返信|2段)/) && !String(r.staff).match(/^[a-z]/));
    console.log(`  文の外れ（line_watch_turns 9/28〜・返信の道が当たった番）: ${tv.filter((r) => r.textMiss).length}/${tv.length}（${pct(tv.filter((r) => r.textMiss).length, tv.length)}）`);
    console.log(`\n  ① 印ごと（出る番の割合／出た時の外れ率 vs 出ない時の外れ率／外れのうち拾う割合）`);
    console.log(`  ${"印".padEnd(46)} 出る番     外れ率(出)   外れ率(無)   倍率   拾う外れ`);
    const base = miss / Math.max(1, rs.length);
    const stats: { k: string; n: number; m: number; lift: number }[] = [];
    for (const k of sigNames) {
      const on = rs.filter((r) => r.sig[k]); const off = rs.filter((r) => !r.sig[k]);
      const mOn = on.filter((r) => r.miss).length, mOff = off.filter((r) => r.miss).length;
      const lift = on.length ? (mOn / on.length) / Math.max(1e-9, base) : 0;
      stats.push({ k, n: on.length, m: mOn, lift });
      console.log(`  ${k.padEnd(46)} ${String(on.length).padStart(4)}（${pct(on.length, rs.length).padStart(5)}） ${String(mOn).padStart(3)}/${String(on.length).padEnd(4)} ${pct(mOn, on.length).padStart(6)}  ${pct(mOff, off.length).padStart(6)}   ×${lift.toFixed(2)}  ${pct(mOn, miss)}`);
    }
    // ② 組み合わせ: 前半で印の重み（外れ率の対数オッズ比・n≥8）を作り、後半で並べて「上位 x% の番に出すと外れの何%を拾うか」
    const fit = (train: Row[]) => {
      const bm = train.filter((r) => r.miss).length / Math.max(1, train.length);
      const wts: Record<string, number> = {};
      for (const k of sigNames) {
        if (k.startsWith("道:") || k.startsWith("2択:")) continue;
        const on = train.filter((r) => r.sig[k]); if (on.length < 8) continue;
        const p = (on.filter((r) => r.miss).length + 1) / (on.length + 2);
        const lo = Math.log(p / (1 - p)) - Math.log(bm / (1 - bm));
        if (lo > 0.15) wts[k] = lo;
      }
      return wts;
    };
    const score = (r: Row, wts: Record<string, number>) => Object.entries(wts).reduce((s, [k, v]) => s + (r.sig[k] ? v : 0), 0);
    const curve = (test: Row[], wts: Record<string, number>, label: string) => {
      const sorted = [...test].map((r) => ({ r, s: score(r, wts) + Math.random() * 1e-6 })).sort((a, b) => b.s - a.s);
      const tm = test.filter((r) => r.miss).length;
      const line = [5, 10, 20, 30, 50].map((p) => { const top = sorted.slice(0, Math.round((test.length * p) / 100)); const c = top.filter((x) => x.r.miss).length; return `${p}%の番→外れ ${pct(c, tm)}（その中の外れ率 ${pct(c, top.length)}）`; }).join("｜");
      console.log(`  ${label}（番 ${test.length}・外れ ${tm}）: ${line}`);
    };
    console.log(`\n  ② 印を組み合わせた時の釣り合い（重み＝外れのオッズ比の対数・n≥8・正の印だけ）`);
    const wAll = fit(rs);
    console.log(`  重み（全体で作った）: ${Object.entries(wAll).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace(/（.*?）/g, "")} ${v.toFixed(2)}`).join("・")}`);
    curve(rs, wAll, "全体で作って全体で測る（甘め）");
    const tr = rs.slice(0, Math.floor(rs.length / 2)), te = rs.slice(Math.floor(rs.length / 2));
    curve(te, fit(tr), "前半で作って後半で測る（厳しめ）");
    // 規則の印（決まった形）: 単純な OR の組み合わせ
    const combos: [string, (r: Row) => boolean][] = [
      ["割れ OR 規則（llm 以外）", (r) => r.sig["割れ:同じ番の判断の版で道が割れた（案B の代わり）"] || r.sig["規則:決定論の規則が答えを決めた（decision_source が llm 以外）"]],
      ["割れ OR 依頼2件以上 OR 気持ち(sensitive)", (r) => r.sig["割れ:同じ番の判断の版で道が割れた（案B の代わり）"] || r.sig["依頼:1つの連投に依頼が2件以上"] || r.sig["気持ち:クレーム・否決・キャンセル（sensitive-case）"]],
      ["ブレインが AIX（AIX の番は全部人へ）", (r) => r.sig["道:ブレインが AIX"]],
      ["気持ち(emo) OR signal:/promise:", (r) => r.sig["気持ち:迷い・不安・不満・離れかけ（digest.emo）"] || r.sig["規則:signal:*"] || r.sig["規則:promise:*"]],
      ["気持ち(emo) OR 引用 OR 依頼2件以上 OR 疑問2つ以上", (r) => r.sig["気持ち:迷い・不安・不満・離れかけ（digest.emo）"] || r.sig["主語:引用リプライ"] || r.sig["依頼:1つの連投に依頼が2件以上"] || r.sig["長さ:疑問が2つ以上"]],
      ["ブレインが AIX かつ（気持ち OR 規則 llm 以外 OR 疑問2つ以上）", (r) => r.sig["道:ブレインが AIX"] && (r.sig["気持ち:迷い・不安・不満・離れかけ（digest.emo）"] || r.sig["規則:決定論の規則が答えを決めた（decision_source が llm 以外）"] || r.sig["長さ:疑問が2つ以上"])],
      ["気持ち(emo) OR (ブレインが AIX かつ 規則 llm 以外)", (r) => r.sig["気持ち:迷い・不安・不満・離れかけ（digest.emo）"] || (r.sig["道:ブレインが AIX"] && r.sig["規則:決定論の規則が答えを決めた（decision_source が llm 以外）"])],
    ];
    for (const [name, f] of combos) { const on = rs.filter(f); const c = on.filter((r) => r.miss).length; console.log(`  [${name}] 出る番 ${pct(on.length, rs.length)}・外れ率 ${pct(c, on.length)}・拾う外れ ${pct(c, miss)}`); }
    // 場面ごと
    console.log(`\n  場面ごとの外れ率`);
    const sc = new Map<string, Row[]>(); for (const r of rs) { const k = String(r.scene); if (!sc.has(k)) sc.set(k, []); sc.get(k)!.push(r); }
    for (const [k, v] of [...sc].sort((a, b) => b[1].length - a[1].length)) console.log(`    ${k.padEnd(15)} n=${String(v.length).padStart(4)} 外れ ${pct(v.filter((r) => r.miss).length, v.length)}`);
    console.log(`\n  ブレインの道ごとの外れ率`);
    const bd = new Map<string, Row[]>(); for (const r of rs) { const k = String(r.brain).replace(/\/.*$/, ""); if (!bd.has(k)) bd.set(k, []); bd.get(k)!.push(r); }
    for (const [k, v] of [...bd].sort((a, b) => b[1].length - a[1].length).slice(0, 18)) console.log(`    ${k.padEnd(30)} n=${String(v.length).padStart(4)} 外れ ${pct(v.filter((r) => r.miss).length, v.length)}`);
    if (wr !== "全員") continue;
    // ③ 実例（印ごと 2〜3件）
    console.log(`\n  ③ 外れの実例（印ごと）`);
    for (const s of stats.filter((x) => x.lift >= 1.2 && x.m >= 3 && !x.k.startsWith("道:")).sort((a, b) => b.lift - a.lift)) {
      console.log(`   ■ ${s.k}（外れ ${s.m}/${s.n}）`);
      for (const r of rs.filter((x) => x.miss && x.sig[s.k]).slice(-SAMPLES)) console.log(`     ${String(r.at).slice(0, 16)} ${String(r.conv).slice(0, 8)} [${r.sub}] 前「${String(r.prevStaffText).slice(0, 40)}」\n       客「${String(r.customer).slice(0, 100)}」\n       脳=${r.brain}（${r.src || "null"}）→ 人=${r.staff}「${String(r.staffText).slice(0, 70)}」 型=${r.missType}`);
    }
    // ④ 印で拾えない外れ（重みのある印が1つも立たない外れ）
    // 弱い印（重み 0.4 未満か、出る番が3割超）は外して「印で拾えない外れ」を見る
    const strong = Object.fromEntries(Object.entries(wAll).filter(([k, v]) => v >= 0.4 && rs.filter((r) => r.sig[k]).length <= rs.length * 0.3));
    console.log(`  強い印: ${Object.keys(strong).join("・")}`);
    const none = rs.filter((r) => r.miss && score(r, strong) === 0);
    console.log(`\n  ④ 重みのある印が1つも立たない外れ ${none.length}/${miss}（${pct(none.length, miss)}）`);
    const nt = new Map<string, Row[]>(); for (const r of none) { const k = `${r.missType}｜脳=${String(r.brain).replace(/\/.*$/, "")}→人=${String(r.staff).replace(/\/.*$/, "").replace(/（.*$/, "")}`; if (!nt.has(k)) nt.set(k, []); nt.get(k)!.push(r); }
    for (const [k, v] of [...nt].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
      console.log(`   ${k} ${v.length}`);
      for (const r of v.slice(-2)) console.log(`     ${String(r.at).slice(0, 16)} [${r.sub}] 客「${String(r.customer).slice(0, 80)}」 人「${String(r.staffText).slice(0, 60)}」`);
    }
  }
  // 10項目の数字の材料: 1日あたりの番・外れ・夜の番
  const days = Math.max(1, (ms(String(rows[rows.length - 1]?.at)) - ms(String(rows[0]?.at))) / 86_400_000);
  console.log(`\n■ 量: 1日あたり 番 ${(rows.length / days).toFixed(1)}・外れ ${(rows.filter((r) => r.miss).length / days).toFixed(1)}・夜（22〜9時）の番 ${pct(rows.filter((r) => r.sig["時刻:夜（22〜9時）の発言"]).length, rows.length)}・書き手 A ${rows.filter((r) => r.writer === "A").length}・B ${rows.filter((r) => r.writer === "B").length}・? ${rows.filter((r) => r.writer === "?").length}`);
  if (OUT) writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
