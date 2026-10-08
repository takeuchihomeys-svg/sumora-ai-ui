// scripts/audit-r10-path-truth.ts — 10巡目「返信か AIX か」の正解の表と、ブレインの判断との一致率（読むだけ・LLM なし）
//
// 2026-10-08 竹内「返信か AIX の判断を先に完全にして、それから細かくしていくのが一番効率よくて質も上がる」
//   「AIXのボタンの種類・ピッカーの種類を分かっていたら簡単に完全にすることできる」
//
// 正解（番ごとにスタッフが取った最初の行動）:
//   番 = お客様の連投。窓 = line-watch-judge.staffWindowOf（次のお客様の発言まで・最大24時間）・返事のまとまり（10分の間・30分まで）
//   返信   … まとまりの中が手打ち・下書きの文だけ（約束の語なし）
//   2段    … まとまりの中が約束の文（確認・見積書・ピックアップ）。同じまとまりで同じ種類の AIX も押した時は「2段→AIX」（約束の文の後すぐ果たした）
//   AIX    … まとまりの中で AIX を押した（ボタン×主のピッカー＝aix-catalog.catalogKeyOfPress）
//   なし   … 24時間何も送らなかった（次のお客様の発言が3時間以上後・または来ない）。3時間以内にお客様が続けた番は「続き」で数えない
//   書き手 … まとまりの最初のスタッフの通の messages.staff_writer（takeuchi／employee／null）
//   除く   … YUMA・社内・業者の会話／申込以降（申込へ（push 以外）を押した・申込フォームを送った後。否決の後の切り替えは戻す）
//   押下の記録は 6/26〜（それより前は AIX の道具が無い＝全部 返信）
// ブレイン: brain_decision_logs（analyzed_msg_ts のある 9/12〜）の、スタッフの最初の行動より前の最後の判断（＝スタッフが見た判断）
//   AIX → ボタン（物件確認した は check_pattern の話題まで）／action なし → digest.dir の定型から 2段・連絡待ち（なし）・返信
//
// 実行: npx tsx --env-file=.env.local scripts/audit-r10-path-truth.ts [--since=2026-05-30] [--out=<jsonl>] [--samples=3] [--brain-out=<jsonl>]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { staffWindowOf, type WindowMsg } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { subSceneOf } from "../app/lib/reply-subscene";
import { staffActsOf, APPLY_FORM_RE } from "../app/lib/customer-sim-shadow";
import { STAFF_FAIL_RE } from "../app/lib/post-apply-brain-gate";
import { catalogKeyOfPress, topicKey, buttonOfKey } from "../app/lib/aix-catalog";
import { promiseKindsToday } from "../app/lib/two-stage";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const SINCE = arg("since", "2026-05-30T00:00:00+09:00");
const OUT = arg("out");
const SAMPLES = Number(arg("samples", "3"));
const H = 3_600_000;
const ms = (s: string) => Date.parse(s);

type Msg = WindowMsg & { id: number | string; conversation_id: string; staff_writer: string | null };
type Press = { conversation_id: string; aix_type: string | null; check_pattern: string | null; send_mode: string | null; app_sub_mode: string | null; picker_choices: unknown; generated_text: string | null; created_at: string };
type Dec = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; suggested_check_pattern: string | null; decision_source: string | null; conversation_status: string | null; digest: Record<string, unknown> | null };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 900_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const PROP = /^property_(send|recommendation|pickup|search)$/;
const famOf = (a: string) => (PROP.test(a) ? "物件" : a === "acknowledge_check" ? "property_check_result" : a);
const POST = /^(?:applying|application|screening|contract|approved|closed_won)$/;
const mask = (s: string) => s.replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "〈メール〉").replace(/https?:\/\/\S+/g, "〈URL〉");

type Promise2 = "check" | "estimate" | "pickup" | "photo" | null;
function promiseOf(text: string): Promise2 {
  const acts = staffActsOf(text);
  const t = text.normalize("NFKC");
  if (/撮影(?:出来|でき)次第|撮影(?:させて|し)[^\n]{0,8}お送り/.test(t)) return "photo";
  if (acts.has("estimate_promise")) return "estimate";
  if (acts.has("check_promise") || /(?:内覧|ご内覧)(?:可能|開始日)[^\n]{0,12}確認(?:させて|致し|いたし)/.test(t)) return "check";
  if (acts.has("pickup_promise")) return "pickup";
  return null;
}
/** 約束の種類 → 果たす AIX の族 */
const PROMISE_FAM: Record<string, RegExp> = { check: /^(?:property_check_result|estimate_sheet|viewing_invite|acknowledge_check)$/, estimate: /^(?:estimate_sheet|property_check_result)$/, pickup: PROP, photo: /^property_check_result$/ };

/** ブレインが action なしにした番の道（digest.dir の定型の書き出し） */
function brainNullPath(d: Dec): { path: string; kind: string } {
  const dir = String(d.digest?.dir ?? "");
  if (/ピックアップしてお送りすると約束/.test(dir)) return { path: "2段", kind: "pickup" };
  if (/送ってきた物件の募集状況を確認し|募集状況と最大限割引した初期費用の御見積書をお送りすると約束/.test(dir)) return { path: "2段", kind: "check" };
  if (/室内の写真はスタッフが撮影/.test(dir)) return { path: "2段", kind: "photo" };
  if (/内覧を希望している/.test(dir) && /確認/.test(dir)) return { path: "2段", kind: "check" };
  if (/御見積書を作成しお送りすると約束/.test(dir)) return { path: "2段", kind: "estimate" };
  if (/^お客様に聞かれた事に答える返信/.test(dir)) return { path: "返信|2段", kind: "check" };
  if (/(?:募集状況|聞かれた事).{0,30}確認すると約束する返信/.test(dir)) return { path: "2段", kind: "check" };
  if (/お仕事面は弊社でサポート/.test(dir)) return { path: "返信", kind: "" };
  if (/^お客様の連絡待ち/.test(dir)) return { path: "なし", kind: "" };
  return { path: "返信", kind: "" };
}

(async () => {
  const sinceMs = ms(SINCE);
  const [msgs, presses, decs, convs] = await Promise.all([
    readAll<Msg>((f, t) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", new Date(sinceMs - 3 * 86_400_000).toISOString()).order("created_at").order("id").range(f, t)),
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, generated_text, created_at").gte("created_at", new Date(sinceMs - 3 * 86_400_000).toISOString()).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, suggested_check_pattern, decision_source, conversation_status, digest").not("analyzed_msg_ts", "is", null).order("created_at").range(f, t)),
    readAll<{ id: string; status: string | null }>((f, t) => sb.from("conversations").select("id, status").range(f, t)),
  ]);
  const statusOf = new Map(convs.map((c) => [c.id, c.status]));
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses), dBy = by(decs);
  type Row = Record<string, unknown> & { truth: string; truthKey: string; scene: string; sub: string; writer: string };
  const rows: Row[] = [];
  let skipPost = 0, skipCont = 0, skipOpen = 0, skipTest = 0;
  for (const [conv, mm] of mBy) {
    if (isTestConversation(conv)) { skipTest++; continue; }
    const ps = pBy.get(conv) ?? [];
    // 申込以降の始まり（push 以外の 申込へ・申込フォーム）と否決の後の戻り
    const postStarts = [
      ...ps.filter((p) => p.aix_type === "application_push" && (p.app_sub_mode ?? "") !== "push").map((p) => ms(p.created_at)),
      ...mm.filter((m) => m.sender !== "customer" && APPLY_FORM_RE.test(m.text ?? "")).map((m) => ms(m.created_at)),
    ].sort((a, b) => a - b);
    const fails = mm.filter((m) => STAFF_FAIL_RE.test(m.text ?? "")).map((m) => ms(m.created_at));
    const isPost = (at: number) => { const st = postStarts.filter((x) => x <= at); if (!st.length) return false; const last = st[st.length - 1]; return !fails.some((f) => f > last && f <= at); };
    for (let i = 0; i < mm.length; i++) {
      if (mm[i].sender !== "customer" || (i > 0 && mm[i - 1].sender === "customer")) continue;
      const turnAt = mm[i].created_at;
      if (ms(turnAt) < sinceMs) continue;
      let j = i; while (j + 1 < mm.length && mm[j + 1].sender === "customer") j++;
      const custText = mm.slice(i, j + 1).map((m) => m.text ?? "").join("\n");
      const custLast = mm[j].created_at;
      if (isPost(ms(custLast))) { skipPost++; continue; }
      const w = staffWindowOf({ customerTurnAt: turnAt, msgs: mm, presses: ps });
      const burstPress = ps.filter((p) => ms(p.created_at) > ms(w.customerLastAt) && ms(p.created_at) < ms(w.endAt));
      const nextCust = mm[j + 1] && mm.slice(j + 1).find((m) => m.sender === "customer");
      const burstTexts = w.texts.filter((t) => t.burst);
      const bp = w.presses.filter((p) => p.burst);
      const prevStaff = [...mm.slice(0, i)].reverse().find((m) => m.sender !== "customer");
      const firstStaffMsg = mm.slice(j + 1).find((m) => m.sender !== "customer" && w.staffFirstAt && ms(m.created_at) >= ms(w.staffFirstAt) - 1000);
      const writer = (firstStaffMsg && w.staffFirstAt && ms(firstStaffMsg.created_at) <= ms(w.endAt) ? firstStaffMsg.staff_writer : null) ?? "unknown";
      let truth = "", truthKey = "", promise: Promise2 = null, fulfilledH: number | null = null;
      const bt = burstTexts.map((t) => t.text).join("\n");
      if (bp.length || w.aixMessagesBurst) {
        const p0 = bp.length ? burstPress.find((p) => p.aix_type === bp[0].aix_type && Math.abs(ms(p.created_at) - ms(bp[0].at)) < 1000) ?? null : null;
        const pk = p0 ? catalogKeyOfPress({ ...p0, text: p0.generated_text }) : { key: "aix_unlogged", source: "button_only" as const };
        promise = promiseOf(burstTexts.filter((t) => !bp.length || ms(t.at) <= ms(bp[0].at)).map((t) => t.text).join("\n"));
        if (promise && p0 && PROMISE_FAM[promise].test(p0.aix_type ?? "")) { truth = "2段→AIX"; truthKey = `2段:${promise}→${pk.key}`; }
        else { truth = "AIX"; truthKey = pk.key; }
      } else if (burstTexts.length) {
        promise = promiseOf(bt);
        truth = promise ? "2段" : "返信"; truthKey = promise ? `2段:${promise}` : "返信";
        if (promise) {
          const f = ps.find((p) => ms(p.created_at) > ms(w.staffFirstAt!) && ms(p.created_at) <= ms(w.staffFirstAt!) + 72 * H && PROMISE_FAM[promise!].test(p.aix_type ?? ""));
          fulfilledH = f ? Math.round((ms(f.created_at) - ms(w.staffFirstAt!)) / H * 10) / 10 : null;
        }
      } else {
        if (!w.closed) { skipOpen++; continue; }
        if (nextCust && ms(nextCust.created_at) - ms(custLast) < 3 * H) { skipCont++; continue; }
        truth = "なし"; truthKey = "なし";
      }
      // 窓の後半・窓の後 72時間に押した AIX（「黙って後で AIX」「返信の後で AIX」）
      const laterAix = ps.filter((p) => ms(p.created_at) > ms(custLast) && ms(p.created_at) <= ms(custLast) + 72 * H && !(bp.length && Math.abs(ms(p.created_at) - ms(bp[0].at)) < 1000))
        .map((p) => famOf(String(p.aix_type)));
      const scene = resolveReplyScene({ customerText: custText }).scene;
      const sub = subSceneOf({ customerText: custText, prevStaffText: prevStaff?.text ?? null, scene });
      // ブレイン
      const ds = (dBy.get(conv) ?? []).filter((d) => ms(d.analyzed_msg_ts!) >= ms(turnAt) - 1000 && ms(d.analyzed_msg_ts!) <= ms(custLast) + 1000);
      let brain: string | null = null, brainKey: string | null = null, brainLate = false, brainSrc: string | null = null, brainDir = "", brainKind = "";
      if (ds.length && !(ds[ds.length - 1].conversation_status && POST.test(ds[ds.length - 1].conversation_status!))) {
        const sf = w.staffFirstAt ? ms(w.staffFirstAt) : Infinity;
        const seen = ds.filter((d) => ms(d.created_at) <= sf);
        const d = seen.length ? seen[seen.length - 1] : ds[ds.length - 1];
        brainLate = !seen.length;
        brainSrc = d.decision_source; brainDir = String(d.digest?.dir ?? "").slice(0, 80);
        if (d.suggested_reply_mode === "aix" && d.suggested_action) {
          brain = "AIX";
          brainKey = d.suggested_action === "property_check_result" || d.suggested_action === "acknowledge_check" ? topicKey(`property_check_result/${d.suggested_check_pattern ?? ""}`) : d.suggested_action;
        } else { const n = brainNullPath(d); brain = n.path; brainKind = n.kind; brainKey = n.path === "2段" ? `2段:${n.kind}` : n.path; }
      }
      rows.push({
        conv, at: custLast, period: ms(custLast) >= ms("2026-06-26T00:00:00Z") ? "AIX後" : "AIX前", writer, scene, sub,
        truth, truthKey, truthBtn: truth === "AIX" ? famOf(buttonOfKey(truthKey)) : truth === "2段→AIX" ? famOf(buttonOfKey(truthKey.split("→")[1])) : null,
        truthTopic: truth === "AIX" ? topicKey(truthKey) : null, promise, fulfilledH, laterAix: [...new Set(laterAix)], promisedToday: promiseKindsToday(mm.slice(0, i).filter((m) => m.sender !== "customer" && !m.is_aix_generated).map((m) => ({ text: m.text ?? "", createdAt: m.created_at })), ms(custLast)), latencyMin: w.staffFirstAt ? Math.round((ms(w.staffFirstAt) - ms(custLast)) / 60000) : null,
        brain, brainKey, brainKind, brainLate, brainSrc, brainDir,
        convStatusNow: statusOf.get(conv) ?? null,
        customer: mask(custText).slice(0, 200), staffText: mask(bt).slice(0, 200), prevStaff: mask(prevStaff?.text ?? "").slice(0, 120),
      });
    }
  }
  // 一致（道・ボタン・ピッカー）
  for (const r of rows) {
    if (!r.brain) continue;
    const b = String(r.brain), t = r.truth, bk = String(r.brainKey ?? "");
    const tBtn = r.truthBtn ? String(r.truthBtn) : null;
    let path = false, btn = false, picker: boolean | null = null;
    if (b === "AIX") {
      const bf = famOf(bk.split("/")[0]);
      if (t === "AIX" || t === "2段→AIX") { path = true; btn = bf === tBtn; if (btn && bk.startsWith("property_check_result")) picker = bk === topicKey(String(r.truthKey).split("→").pop()!); }
    } else if (b === "2段") {
      if (t === "2段") { path = true; btn = r.brainKind === r.promise || (r.brainKind === "check" && r.promise === "estimate"); }
      if (t === "2段→AIX") { path = true; btn = true; }
    } else if (b === "返信|2段") { path = t === "返信" || t === "2段"; btn = path; }
    else if (b === "返信") { path = t === "返信"; btn = path; }
    else if (b === "なし") { path = t === "なし"; btn = path; }
    // 黙って後で同じ AIX（約束の後のお礼・了承は打たずに後で果たす＝3巡目の決まり）は一致に数える
    const later = (r.laterAix as string[]) ?? [];
    const bFam = famOf(bk.split("/")[0]);
    if (b === "AIX" && t === "なし" && later.includes(bFam)) { path = true; btn = true; r.waitThenAix = true; }
    r.matchPath = path; r.matchBtn = path && btn; r.matchPicker = picker;
    // 決まりどおり（10/02・10/07 竹内さん「いつも約束の返信を先に」）: ブレインの2段の約束の種類の AIX をスタッフが約束を省いて直接押した番
    const KIND_FAM: Record<string, RegExp> = { check: /^(?:property_check_result|estimate_sheet|viewing_invite)$/, estimate: /^(?:estimate_sheet|property_check_result)$/, pickup: /^物件$/, photo: /^property_check_result$/ };
    r.matchPolicy = r.matchBtn || (b === "2段" && t === "AIX" && !!tBtn && !!KIND_FAM[String(r.brainKind)]?.test(tBtn));
    r.gap = path ? (btn ? "一致" : "種類違い") : `${b}→${t}${b === "AIX" && (t === "返信" || t === "2段") && later.includes(bFam) ? "（後で同じAIX）" : ""}`;
  }
  // ─── 出力 ───
  const n = rows.length;
  const pct = (a: number, b: number) => `${a}/${b}（${b ? Math.round((a / b) * 100) : 0}%）`;
  const count = <T>(xs: T[], f: (x: T) => string) => { const m = new Map<string, number>(); for (const x of xs) { const k = f(x); m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
  console.log(`# 正解の表（${SINCE.slice(0, 10)}〜）番 ${n}｜除外: 申込以降 ${skipPost}・続き（3時間以内に連投）${skipCont}・窓が開いている ${skipOpen}・テスト/社内の会話 ${skipTest}`);
  for (const per of ["AIX前", "AIX後"]) {
    const rs = rows.filter((r) => r.period === per);
    console.log(`\n## ${per}（${per === "AIX前" ? "〜6/25 押下の記録なし" : "6/26〜"}）n=${rs.length}`);
    for (const w of ["all", "takeuchi", "employee", "unknown"]) {
      const x = w === "all" ? rs : rs.filter((r) => r.writer === w);
      console.log(`  ${w.padEnd(9)} n=${x.length}: ${count(x, (r) => r.truth).map(([k, v]) => `${k} ${v}（${Math.round((v / Math.max(1, x.length)) * 100)}%）`).join("・")}`);
    }
  }
  const post = rows.filter((r) => r.period === "AIX後");
  console.log(`\n## 正解の鍵（ボタン×ピッカー・6/26〜）上位`);
  for (const [k, v] of count(post.filter((r) => r.truth !== "返信" && r.truth !== "なし"), (r) => String(r.truthKey)).slice(0, 45)) console.log(`  ${k.padEnd(48)} ${v}`);
  console.log(`  推定の割合: ${(() => { const a = post.filter((r) => r.truth === "AIX"); return a.length; })()} 押下の番`);

  console.log(`\n## 小場面ごとの正解（6/26〜・竹内さん／従業員の多数派と割合・n>=5）`);
  const subs = count(post, (r) => r.sub);
  const majority = (xs: Row[], f: (r: Row) => string) => { const c = count(xs, f); return c.length ? `${c[0][0]} ${Math.round((c[0][1] / xs.length) * 100)}%` : "-"; };
  const diffList: string[] = [];
  for (const [s, c] of subs) {
    if (c < 5) continue;
    const rs = post.filter((r) => r.sub === s);
    const tk = rs.filter((r) => r.writer === "takeuchi"), em = rs.filter((r) => r.writer === "employee");
    const pathOf = (r: Row) => (r.truth === "AIX" ? `AIX:${r.truthBtn}` : r.truth === "2段→AIX" ? `2段→${r.truthBtn}` : r.truth === "2段" ? `2段:${r.promise}` : r.truth);
    const mT = majority(tk, pathOf), mE = majority(em, pathOf);
    console.log(`  ${s.padEnd(34)} n=${String(c).padStart(4)}｜全 ${majority(rs, pathOf)}｜竹内 n=${tk.length} ${mT}｜従業員 n=${em.length} ${mE}`);
    if (tk.length >= 3 && em.length >= 3 && mT.split(" ")[0] !== mE.split(" ")[0]) diffList.push(`${s}: 竹内 ${mT}（n=${tk.length}）／従業員 ${mE}（n=${em.length}）`);
  }
  console.log(`\n## 竹内さんと従業員で多数派が違う小場面`);
  for (const d of diffList) console.log(`  ${d}`);

  const cmp = rows.filter((r) => r.brain);
  console.log(`\n# ブレインとの一致（9/12〜・ブレインの判断のある番 ${cmp.length}）`);
  const rate = (xs: Row[]) => `道 ${pct(xs.filter((r) => r.matchPath).length, xs.length)}・ボタン ${pct(xs.filter((r) => r.matchBtn).length, xs.length)}・決まりどおり込み ${pct(xs.filter((r) => r.matchPolicy).length, xs.length)}`;
  console.log(`  全体: ${rate(cmp)}｜竹内さんの番: ${rate(cmp.filter((r) => r.writer === "takeuchi"))}｜従業員: ${rate(cmp.filter((r) => r.writer === "employee"))}`);
  const since102 = cmp.filter((r) => ms(String(r.at)) >= ms("2026-10-02T05:00:00Z"));
  console.log(`  2段の後（10/02 14時〜）: ${rate(since102)}｜竹内さん ${rate(since102.filter((r) => r.writer === "takeuchi"))}`);
  const since107 = cmp.filter((r) => ms(String(r.at)) >= ms("2026-10-07T00:00:00Z"));
  console.log(`  10/07〜（3〜8巡目の直しの後）: ${rate(since107)}`);
  const pk = cmp.filter((r) => r.matchPicker !== null);
  console.log(`  物件確認した のピッカーの話題: ${pct(pk.filter((r) => r.matchPicker).length, pk.length)}`);
  // ─── 二択（10巡目のゴール: AIX の番を確実に見分けて止める・10/08 竹内さん）───
  //   正解: AIX の番＝最初の行動が AIX（2段→AIX を含む）／返信の番＝返信・約束の返信（2段）／なし は除く
  //   ブレイン: AIX＝止める／返信・2段・返信|2段＝返信（自動送信の候補）／なし（連絡待ち）＝送らない＝止める側
  //   決まりどおり: 正解が AIX でも、ブレインの2段がその AIX の約束なら（10/02・10/07 竹内さんの「先に約束の返信」）決まりどおりとして別に数える
  const bin = cmp.filter((r) => r.truth !== "なし");
  const tAix = (r: Row) => r.truth === "AIX" || r.truth === "2段→AIX";
  const bStop = (r: Row) => r.brain === "AIX" || r.brain === "なし";
  const binRate = (xs: Row[]) => {
    const ta = xs.filter(tAix), tr = xs.filter((r) => !tAix(r));
    const ok = xs.filter((r) => tAix(r) === bStop(r)).length;
    const okP = xs.filter((r) => tAix(r) === bStop(r) || (tAix(r) && r.matchPolicy)).length;
    const miss = ta.filter((r) => !bStop(r)), missP = ta.filter((r) => !bStop(r) && !r.matchPolicy);
    return `二択 ${pct(ok, xs.length)}（決まりどおり込み ${pct(okP, xs.length)}）｜AIX の番を返信にした ${pct(miss.length, ta.length)}（決まりどおりを除く ${pct(missP.length, ta.length)}）｜返信の番を AIX にした ${pct(tr.filter(bStop).length, tr.length)}`;
  };
  console.log(`\n# 二択（返信か AIX か・なしを除く）`);
  console.log(`  全体 n=${bin.length}: ${binRate(bin)}`);
  console.log(`  竹内さんの番 n=${bin.filter((r) => r.writer === "takeuchi").length}: ${binRate(bin.filter((r) => r.writer === "takeuchi"))}`);
  const bin102 = bin.filter((r) => ms(String(r.at)) >= ms("2026-10-02T05:00:00Z"));
  console.log(`  10/02〜 n=${bin102.length}: ${binRate(bin102)}`);
  console.log(`  10/02〜 竹内さん n=${bin102.filter((r) => r.writer === "takeuchi").length}: ${binRate(bin102.filter((r) => r.writer === "takeuchi"))}`);
  console.log(`\n## 二択の場面ごと（9/12〜・n>=4）`);
  for (const [s2, c] of count(bin, (r) => r.sub)) { if (c < 4) continue; console.log(`  ${s2.padEnd(34)} n=${String(c).padStart(3)} ${binRate(bin.filter((r) => r.sub === s2))}`); }
  console.log(`\n## 正解×ブレイン（道）`);
  for (const [k, v] of count(cmp, (r) => `${r.truth} ← ブレイン ${r.brain}`)) console.log(`  ${k.padEnd(30)} ${v}`);
  console.log(`\n## 場面ごとの一致（9/12〜・n>=4）  道／ボタン｜竹内さんの番の道`);
  for (const [s, c] of count(cmp, (r) => r.sub)) {
    if (c < 4) continue;
    const rs = cmp.filter((r) => r.sub === s), tk = rs.filter((r) => r.writer === "takeuchi");
    console.log(`  ${s.padEnd(34)} n=${String(c).padStart(3)} 道 ${Math.round((rs.filter((r) => r.matchPath).length / c) * 100)}%／ボタン ${Math.round((rs.filter((r) => r.matchBtn).length / c) * 100)}%｜竹内 ${tk.length ? `${Math.round((tk.filter((r) => r.matchPath).length / tk.length) * 100)}%（${tk.length}）` : "-"}｜外れ: ${count(rs.filter((r) => !r.matchBtn), (r) => String(r.gap === "種類違い" ? `種類違い ${r.brainKey}→${r.truthKey}` : r.gap)).slice(0, 3).map(([k, v]) => `${k} ${v}`).join("・")}`);
  }
  for (const [lab, xs] of [["9/12〜10/02", cmp.filter((r) => ms(String(r.at)) < ms("2026-10-02T05:00:00Z"))], ["10/02〜（2段の後）", since102]] as const) {
    console.log(`\n## 外れの型×ブレインの判断（${lab}・n=${xs.length}・一致 ${xs.filter((r) => r.matchBtn).length}）`);
    for (const [k, v] of count(xs.filter((r) => !r.matchBtn), (r) => `${r.gap}｜${String(r.brainKey)}`).slice(0, 30)) console.log(`  ${k.padEnd(64)} ${v}`);
  }
  console.log(`\n## 外れの型（多い順）`);
  const gaps = cmp.filter((r) => !r.matchBtn);
  for (const [k, v] of count(gaps, (r) => (r.gap === "種類違い" ? `種類違い ${String(r.brainKey).split("/")[0]}→${String(r.truthKey).split("→").pop()!.split("/")[0]}` : String(r.gap))).slice(0, 30)) console.log(`  ${k.padEnd(56)} ${v}`);
  // 代表例
  for (const [g] of count(gaps, (r) => String(r.gap)).slice(0, 8)) {
    console.log(`\n--- ${g}`);
    for (const r of gaps.filter((x) => x.gap === g).slice(0, SAMPLES)) console.log(`  ${String(r.at).slice(0, 16)} ${String(r.conv).slice(0, 8)} ${r.sub} 書き手=${r.writer} 前「${String(r.prevStaff).replace(/\n/g, " ").slice(0, 50)}」\n    客「${String(r.customer).replace(/\n/g, " ").slice(0, 100)}」\n    人「${String(r.staffText).replace(/\n/g, " ").slice(0, 100)}」 正解=${r.truthKey} ブレイン=${r.brainKey} src=${r.brainSrc ?? "-"} dir=${String(r.brainDir).slice(0, 50)}`);
  }
  if (OUT) writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
