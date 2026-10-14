// audit-split-reply-aix.ts — 「AIX と返信を分けた物差し」（読むだけ・LLM なし・本番 DB を読むだけ）
//
// 2026-10-14 区切り6（竹内さん「物差しを直す」）: scratchpad の split/audit-split-reply-aix.ts をリポジトリに写した。
//   人が文で送った番でも、その文に AIX の中身（交渉の結果・確認の結果・探した結果・スタッフの予定・空き・内覧の確定 等＝aix-content-gate.classifyAixContent
//   の根拠の無い（前の会話の引用でない）文、＋スタッフの予定の文）があれば AIX の番として数える（truth="AIX"・truthKey="文:<AIX の鍵>"・aixByText=true）。
//   旧の数え方は --no-aix-text（返信の番に人だけが知る中身の番が混ざり、返信の一致率の分母を汚していた）
//
// 2026-10-13 竹内さん「AIX と返信をちゃんと区別していれば、直さず送れる率はもっと高くなるのでは」「分けた物差しで考える」
//   番 = お客様の連投（audit-r10-path-truth と同じ: staffWindowOf の返事のまとまり・YUMA 等のテスト会話と申込以降を除く）
//   ブレインの判断 = brain_decision_logs の「スタッフの最初の行動より前の最後」（無ければその番の最後＝遅れ）
//     AIX（reply_mode=aix＋action）／2段（action なし・dir が約束の定型＝約束の返信の後に AIX）／返信（返信・返信|2段）／なし（連絡待ち）／判断なし
//   スタッフの行動 = まとまりの中で AIX を押した（約束の文の後なら 2段→AIX）／約束の文（2段）／文（返信）／何もしない（なし）
//     文の番は ai_reply_examples(entry_source=line_reply) と結ぶ: 下書きそのまま（正規化して同じ）／直した／手打ち（下書きなし）／記録なし
//   書き手 = まとまりの最初のスタッフの通の messages.staff_writer（takeuchi／employee／unknown）
//
// 物差し:
//   ① 返信の番: 直さず送った割合・直した量（字の差・遠さ 1−Dice）・竹内さんの番の近さ（Dice・行の差・次の一手の有無の一致）
//   ② AIX の番: 同じ AIX・違う AIX（どれ→どれ）・返信で済ませた・2段・なし
//   ③ 区別の外れ: ブレイン返信→人 AIX／ブレイン AIX→人 返信（型と見本）
//   ④ 全体の「直さず送った」を ブレインの判断の種類ごとに割る
//
// 実行: npx tsx --env-file=.env.local scripts/audit-split-reply-aix.ts [--days=30] [--since2=2026-10-13T15:00:00+09:00] [--samples=5] [--out=<jsonl・個人情報あり＝リポジトリに置かない>] [--no-aix-text]
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { staffWindowOf, cleanDraft, type WindowMsg } from "../app/lib/line-watch-judge";
import { isTestConversation } from "../app/lib/test-conversations";
import { resolveReplyScene } from "../app/lib/reply-scene";
import { subSceneOf } from "../app/lib/reply-subscene";
import { staffActsOf, APPLY_FORM_RE } from "../app/lib/customer-sim-shadow";
import { STAFF_FAIL_RE } from "../app/lib/post-apply-brain-gate";
import { catalogKeyOfPress, topicKey } from "../app/lib/aix-catalog";
import { splitSentencesJa, promiseTopics, normalizeSentence, isAckOnlyTurn } from "../app/lib/draft-repeat";
import { classifyAixContent } from "../app/lib/aix-content-gate";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const SINCE2 = arg("since2", "2026-10-13T15:00:00+09:00");
const SAMPLES = Number(arg("samples", "5"));
const OUT = arg("out");
const AIX_TEXT = !process.argv.includes("--no-aix-text");
/** スタッフの予定（スタッフだけが知る）: 「13時から予定が入っており」「18時半からであればご案内可能」 */
const STAFF_SCHEDULE_RE = /(?:予定|別件|ご案内)(?:が)?(?:入って(?:おり|い)|ございま|ありま)|(?:[0-9０-９]{1,2}(?:時|:|：)[0-9０-９半]*)[^。\n]{0,8}(?:以降|から|まで)(?:であれば|でしたら|なら)?[^。\n]{0,6}(?:ご案内|ご内覧|ご対応)(?:が)?(?:可能|出来|でき)/;
/** 人の文に AIX の中身があるか（根拠の無い＝前の会話の引用でない文だけ） */
function aixTextOf(text: string, ground: string): string | null {
  if (!AIX_TEXT || !text.trim()) return null;
  const hit = classifyAixContent(text, ground).find((h) => !h.grounded);
  if (hit) return hit.catalogKey;
  return STAFF_SCHEDULE_RE.test(text.normalize("NFKC")) ? "staff_schedule" : null;
}
const H = 3_600_000;
const ms = (s: string) => Date.parse(s);
const NOW = Date.now();
const SINCE = NOW - DAYS * 86_400_000;

type Msg = WindowMsg & { id: string; conversation_id: string; staff_writer: string | null };
type Press = { conversation_id: string; aix_type: string | null; check_pattern: string | null; app_sub_mode: string | null; picker_choices: unknown; generated_text: string | null; created_at: string };
type Dec = { conversation_id: string; created_at: string; analyzed_msg_ts: string | null; suggested_action: string | null; suggested_reply_mode: string | null; suggested_check_pattern: string | null; decision_source: string | null; conversation_status: string | null; digest: Record<string, unknown> | null };
type Ex = { id: string; conversation_id: string; ai_draft: string | null; sent_reply: string | null; sent_at: string | null; created_at: string; was_ai_used: boolean | null; was_ai_modified: boolean | null };
async function readAll<T>(q: (f: number, t: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []; for (let i = 0; i < 900_000; i += 1000) { const r = await q(i, i + 999); if (r.error) throw new Error(r.error.message); const d = (r.data ?? []) as T[]; out.push(...d); if (d.length < 1000) break; } return out;
}
const PROP = /^property_(send|recommendation|pickup|search)$/;
const famOf = (a: string) => (PROP.test(a) ? "物件" : a === "acknowledge_check" ? "property_check_result" : a);
const POST = /^(?:applying|application|screening|contract|approved|closed_won)$/;
const mask = (s: string) => String(s ?? "").replace(/0\d{1,3}-?\d{2,4}-?\d{3,4}/g, "〈電話〉").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "〈メール〉").replace(/https?:\/\/\S+/g, "〈URL〉")
  .replace(/[^\s、。！!？?「」（）()]{1,12}(?:さん|様|さま)/g, "〈名〉").replace(/\n+/g, " ／ ");

// ── 近さ（audit-draft-vs-takeuchi と同じ数え方）──
const lineCount = (s: string) => String(s ?? "").split("\n").filter((x) => x.trim()).length;
const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]/gu, "");
function dice(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  const A = new Map<string, number>(), B = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) A.set(x.slice(i, i + 2), (A.get(x.slice(i, i + 2)) ?? 0) + 1);
  for (let i = 0; i < y.length - 1; i++) B.set(y.slice(i, i + 2), (B.get(y.slice(i, i + 2)) ?? 0) + 1);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v; for (const v of B.values()) nb += v;
  for (const [g, v] of A) inter += Math.min(v, B.get(g) ?? 0);
  return na + nb ? 2 * inter / (na + nb) : 0;
}
const hasNextStep = (s: string) => splitSentencesJa(s).some((x) => promiseTopics(x).length > 0 && normalizeSentence(x).length >= 10);

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
const PROMISE_FAM: Record<string, RegExp> = { check: /^(?:property_check_result|estimate_sheet|viewing_invite|acknowledge_check)$/, estimate: /^(?:estimate_sheet|property_check_result)$/, pickup: PROP, photo: /^property_check_result$/ };
function brainNullPath(d: Dec): { path: string; kind: string } {
  const dir = String(d.digest?.dir ?? "");
  if (/ピックアップしてお送りすると約束/.test(dir)) return { path: "2段", kind: "pickup" };
  if (/送ってきた物件の募集状況を確認し|募集状況と最大限割引した初期費用の御見積書をお送りすると約束/.test(dir)) return { path: "2段", kind: "check" };
  if (/室内の写真はスタッフが撮影/.test(dir)) return { path: "2段", kind: "photo" };
  if (/内覧を希望している/.test(dir) && /確認/.test(dir)) return { path: "2段", kind: "check" };
  if (/御見積書を作成しお送りすると約束/.test(dir)) return { path: "2段", kind: "estimate" };
  if (/^お客様に聞かれた事に答える返信/.test(dir)) return { path: "返信", kind: "答える" };
  if (/(?:募集状況|聞かれた事).{0,30}確認すると約束する返信/.test(dir)) return { path: "2段", kind: "check" };
  if (/お仕事面は弊社でサポート/.test(dir)) return { path: "返信", kind: "" };
  if (/^お客様の連絡待ち/.test(dir)) return { path: "なし", kind: "" };
  return { path: "返信", kind: "" };
}

type Row = {
  conv: string; at: string; period2: boolean; writer: string; scene: string; sub: string; intent: string; ack: boolean;
  brain: string; brainKey: string; brainLate: boolean; brainSrc: string; brainDir: string; tc: boolean;
  truth: string; truthKey: string; truthFam: string | null; promise: Promise2; laterAix: string[];
  /** 2026-10-14 区切り6: 人の文に AIX の中身があったので AIX の番に数えた */
  aixByText?: boolean;
  replyKind: string | null; draft: string | null; sent: string | null; exId: string | null;
  customer: string; staffText: string; prevStaff: string;
};

(async () => {
  const since = new Date(SINCE - 3 * 86_400_000).toISOString();
  const [msgs, presses, decs, exs] = await Promise.all([
    readAll<Msg>((f, t) => sb.from("messages").select("id, conversation_id, sender, created_at, text, is_aix_generated, staff_writer").gte("created_at", since).order("created_at").order("id").range(f, t)),
    readAll<Press>((f, t) => sb.from("aix_usage_logs").select("conversation_id, aix_type, check_pattern, app_sub_mode, picker_choices, generated_text, created_at").gte("created_at", new Date(SINCE - 60 * 86_400_000).toISOString()).not("aix_type", "is", null).order("created_at").range(f, t)),
    readAll<Dec>((f, t) => sb.from("brain_decision_logs").select("conversation_id, created_at, analyzed_msg_ts, suggested_action, suggested_reply_mode, suggested_check_pattern, decision_source, conversation_status, digest").gte("created_at", since).not("analyzed_msg_ts", "is", null).order("created_at").range(f, t)),
    readAll<Ex>((f, t) => sb.from("ai_reply_examples").select("id, conversation_id, ai_draft, sent_reply, sent_at, created_at, was_ai_used, was_ai_modified").eq("entry_source", "line_reply").gte("created_at", since).order("created_at").range(f, t)),
  ]);
  const by = <T extends { conversation_id: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) { if (!r.conversation_id) continue; if (!m.has(r.conversation_id)) m.set(r.conversation_id, []); m.get(r.conversation_id)!.push(r); } return m; };
  const mBy = by(msgs), pBy = by(presses), dBy = by(decs), eBy = by(exs);
  const exAt = (e: Ex) => ms(e.sent_at ?? e.created_at);
  const rows: Row[] = [];
  const exToRow = new Map<string, Row>();
  let skipPost = 0, skipCont = 0, skipOpen = 0, skipTest = 0;
  for (const [conv, mm] of mBy) {
    if (isTestConversation(conv)) { skipTest++; continue; }
    const ps = pBy.get(conv) ?? [];
    const postStarts = [
      ...ps.filter((p) => p.aix_type === "application_push" && (p.app_sub_mode ?? "") !== "push").map((p) => ms(p.created_at)),
      ...mm.filter((m) => m.sender !== "customer" && APPLY_FORM_RE.test(m.text ?? "")).map((m) => ms(m.created_at)),
    ].sort((a, b) => a - b);
    const fails = mm.filter((m) => STAFF_FAIL_RE.test(m.text ?? "")).map((m) => ms(m.created_at));
    const isPost = (at: number) => { const st = postStarts.filter((x) => x <= at); if (!st.length) return false; const last = st[st.length - 1]; return !fails.some((f) => f > last && f <= at); };
    const es = eBy.get(conv) ?? [];
    for (let i = 0; i < mm.length; i++) {
      if (mm[i].sender !== "customer" || (i > 0 && mm[i - 1].sender === "customer")) continue;
      const turnAt = mm[i].created_at;
      let j = i; while (j + 1 < mm.length && mm[j + 1].sender === "customer") j++;
      const custLast = mm[j].created_at;
      if (ms(custLast) < SINCE) continue;
      const custTexts = mm.slice(i, j + 1).map((m) => m.text ?? "");
      const custText = custTexts.join("\n");
      if (isPost(ms(custLast))) { skipPost++; continue; }
      const w = staffWindowOf({ customerTurnAt: turnAt, msgs: mm, presses: ps });
      const burstPress = ps.filter((p) => ms(p.created_at) > ms(w.customerLastAt) && ms(p.created_at) < ms(w.endAt));
      const nextCust = mm.slice(j + 1).find((m) => m.sender === "customer");
      const burstTexts = w.texts.filter((t) => t.burst);
      const bp = w.presses.filter((p) => p.burst);
      const prevStaff = [...mm.slice(0, i)].reverse().find((m) => m.sender !== "customer");
      const firstStaffMsg = mm.slice(j + 1).find((m) => m.sender !== "customer" && w.staffFirstAt && ms(m.created_at) >= ms(w.staffFirstAt) - 1000);
      const writer = (firstStaffMsg && w.staffFirstAt && ms(firstStaffMsg.created_at) <= ms(w.endAt) ? firstStaffMsg.staff_writer : null) ?? "unknown";
      let truth = "", truthKey = "", truthFam: string | null = null, promise: Promise2 = null, aixByText = false;
      const bt = burstTexts.map((t) => t.text).join("\n");
      if (bp.length || w.aixMessagesBurst) {
        const p0 = bp.length ? burstPress.find((p) => p.aix_type === bp[0].aix_type && Math.abs(ms(p.created_at) - ms(bp[0].at)) < 1000) ?? null : null;
        const pk = p0 ? catalogKeyOfPress({ ...p0, text: p0.generated_text } as never) : { key: "aix_unlogged" };
        truthFam = p0 ? famOf(String(p0.aix_type)) : "aix_unlogged";
        promise = promiseOf(burstTexts.filter((t) => !bp.length || ms(t.at) <= ms(bp[0].at)).map((t) => t.text).join("\n"));
        if (promise && p0 && PROMISE_FAM[promise].test(p0.aix_type ?? "")) { truth = "2段→AIX"; truthKey = `2段:${promise}→${pk.key}`; }
        else { truth = "AIX"; truthKey = pk.key; }
      } else if (burstTexts.length && aixTextOf(bt, mm.slice(Math.max(0, i - 25), i).map((m) => m.text ?? "").join("\n"))) {
        // 2026-10-14 区切り6: 人が文で送ったが、中身は AIX の中身（スタッフだけが知る事）＝AIX の番
        truth = "AIX"; truthKey = `文:${aixTextOf(bt, mm.slice(Math.max(0, i - 25), i).map((m) => m.text ?? "").join("\n"))}`; aixByText = true; truthFam = famOf(truthKey.slice(2).split("/")[0]);
      } else if (burstTexts.length) {
        promise = promiseOf(bt);
        truth = promise ? "2段" : "返信"; truthKey = promise ? `2段:${promise}` : "返信";
      } else {
        if (!w.closed) { skipOpen++; continue; }
        if (nextCust && ms(nextCust.created_at) - ms(custLast) < 3 * H) { skipCont++; continue; }
        truth = "なし"; truthKey = "なし";
      }
      const laterAix = [...new Set(ps.filter((p) => ms(p.created_at) > ms(custLast) && ms(p.created_at) <= ms(custLast) + 72 * H && !(bp.length && Math.abs(ms(p.created_at) - ms(bp[0].at)) < 1000)).map((p) => famOf(String(p.aix_type))))];
      // 文の番 → 下書きの記録
      let replyKind: string | null = null, draft: string | null = null, sent: string | null = null, exId: string | null = null;
      if (burstTexts.length && w.staffFirstAt) {
        const lo = ms(w.staffFirstAt) - 20_000, hi = Math.min(ms(w.endAt), ms(w.staffFirstAt) + 40 * 60_000);
        const e = es.find((x) => exAt(x) >= lo && exAt(x) <= hi && !exToRow.has(x.id));
        if (!e) replyKind = "記録なし";
        else {
          exId = e.id; sent = String(e.sent_reply ?? "").trim();
          const d = cleanDraft(e.ai_draft).text;
          if (!d) replyKind = "手打ち（下書きなし）";
          else { draft = d; replyKind = norm(d) === norm(sent) ? "下書きそのまま" : dice(d, sent) < 0.35 ? "書き直し（近さ<0.35）" : "下書きを直した"; }
        }
      }
      const scene = resolveReplyScene({ customerText: custText }).scene;
      const sub = subSceneOf({ customerText: custText, prevStaffText: prevStaff?.text ?? null, scene });
      // ブレイン
      const ds = (dBy.get(conv) ?? []).filter((d) => ms(d.analyzed_msg_ts!) >= ms(turnAt) - 1000 && ms(d.analyzed_msg_ts!) <= ms(custLast) + 1000);
      let brain = "判断なし", brainKey = "", brainLate = false, brainSrc = "", brainDir = "", tc = false, intent = "";
      if (ds.length && !(ds[ds.length - 1].conversation_status && POST.test(ds[ds.length - 1].conversation_status!))) {
        const sf = w.staffFirstAt ? ms(w.staffFirstAt) : Infinity;
        const seen = ds.filter((d) => ms(d.created_at) <= sf);
        const d = seen.length ? seen[seen.length - 1] : ds[ds.length - 1];
        brainLate = !seen.length;
        brainSrc = String(d.decision_source ?? ""); brainDir = String(d.digest?.dir ?? "").slice(0, 70);
        tc = d.digest?.tc === true; intent = String(d.digest?.intent ?? "");
        if (d.suggested_reply_mode === "aix" && d.suggested_action) {
          brain = "AIX";
          brainKey = d.suggested_action === "property_check_result" || d.suggested_action === "acknowledge_check" ? topicKey(`property_check_result/${d.suggested_check_pattern ?? ""}`) : d.suggested_action;
        } else { const n = brainNullPath(d); brain = n.path; brainKey = n.path === "2段" ? `2段:${n.kind}` : n.kind ? `返信:${n.kind}` : n.path; }
      } else if (ds.length) { brain = "判断なし"; brainKey = "申込以降の判断"; }
      const row: Row = {
        conv, at: custLast, period2: ms(custLast) >= ms(SINCE2), writer, scene, sub, intent, ack: isAckOnlyTurn(custTexts),
        brain, brainKey, brainLate, brainSrc, brainDir, tc,
        truth, truthKey, truthFam, promise, laterAix, replyKind, draft, sent, exId, aixByText,
        customer: mask(custText).slice(0, 160), staffText: mask(bt).slice(0, 160), prevStaff: mask(prevStaff?.text ?? "").slice(-90),
      };
      rows.push(row);
      if (exId) exToRow.set(exId, row);
    }
  }

  // ─── 出力 ───
  {
    const byText = rows.filter((r) => r.aixByText);
    const k: Record<string, number> = {}; for (const r of byText) k[r.truthKey] = (k[r.truthKey] ?? 0) + 1;
    console.log(`【区切り6】人の文に AIX の中身＝AIX の番に数えた: ${byText.length}番（竹内さん ${byText.filter((r) => r.writer === "takeuchi").length}）${AIX_TEXT ? "" : "（--no-aix-text: 数えていない）"} ${JSON.stringify(k)}`);
  }
  const pct = (a: number, b: number) => (b ? `${a}/${b}（${Math.round((a / b) * 100)}%）` : `${a}/0`);
  const count = <T>(xs: T[], f: (x: T) => string) => { const m = new Map<string, number>(); for (const x of xs) { const k = f(x); m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
  const brainGroup = (r: Row) => (r.brain === "AIX" ? "AIX の番" : r.brain === "2段" ? "両方（2段＝約束＋AIX）" : r.brain === "返信" ? "返信の番" : r.brain === "なし" ? "連絡待ち（なし）" : "判断なし");
  const staffAct = (r: Row) => (r.truth === "AIX" ? "AIX を押した" : r.truth === "2段→AIX" ? "約束の文＋AIX" : r.truth === "2段" ? `約束の文（${r.replyKind}）` : r.truth === "返信" ? `返信（${r.replyKind}）` : "何もしない");
  const sample = (r: Row) => `    ${new Date(ms(r.at) + 9 * H).toISOString().slice(5, 16)}JST 会話 ${r.conv.slice(0, 8)} ${r.sub} 書き手=${r.writer}${r.brainLate ? "（判断が遅れ）" : ""}\n      前「${r.prevStaff.slice(-60)}」\n      客「${r.customer.slice(0, 110)}」\n      ブレイン=${r.brainKey}${r.brainSrc ? ` src=${r.brainSrc}` : ""} dir「${r.brainDir.slice(0, 50)}」\n      人=${r.truthKey}${r.replyKind ? `・${r.replyKind}` : ""}「${r.staffText.slice(0, 110)}」${r.laterAix.length ? ` 後72h の AIX=${r.laterAix.join(",")}` : ""}`;

  const report = (label: string, rs: Row[], withSamples: boolean) => {
    console.log(`\n\n################ ${label}（番 ${rs.length}）################`);
    console.log(`  書き手: ${count(rs.filter((r) => r.truth !== "なし"), (r) => r.writer).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`\n## 1. 番の分け方（ブレインの判断）× 2. スタッフの行動`);
    for (const [g, n] of count(rs, brainGroup)) {
      const xs = rs.filter((r) => brainGroup(r) === g);
      console.log(`  ■ ${g} ${n}（遅れ ${xs.filter((r) => r.brainLate).length}）`);
      for (const [k, v] of count(xs, staffAct)) console.log(`      ${k.padEnd(28)} ${pct(v, n)}`);
    }

    // ① 返信の番
    const q1 = (xs: Row[], lab: string) => {
      const withEx = xs.filter((r) => r.draft && r.sent);
      const same = withEx.filter((r) => norm(r.draft!) === norm(r.sent!));
      const chars = withEx.reduce((s, r) => s + Math.abs(norm(r.draft!).length - norm(r.sent!).length), 0);
      const dist = withEx.reduce((s, r) => s + (1 - dice(r.draft!, r.sent!)), 0);
      const tk = withEx.filter((r) => r.writer === "takeuchi");
      const tkSim = tk.reduce((s, r) => s + dice(r.draft!, r.sent!), 0);
      const tkLines = tk.reduce((s, r) => s + Math.abs(lineCount(r.draft!) - lineCount(r.sent!)), 0);
      const tkNext = tk.filter((r) => hasNextStep(r.draft!) === hasNextStep(r.sent!)).length;
      const tkSame = tk.filter((r) => norm(r.draft!) === norm(r.sent!)).length;
      const em = withEx.filter((r) => r.writer !== "takeuchi");
      console.log(`  ${lab.padEnd(26)} 下書き×送信 ${String(withEx.length).padStart(3)}｜直さず ${pct(same.length, withEx.length)}｜字の差 ${withEx.length ? (chars / withEx.length).toFixed(0) : "-"}・遠さ ${withEx.length ? (dist / withEx.length).toFixed(2) : "-"}｜竹内さん ${tk.length}: 直さず ${pct(tkSame, tk.length)}・近さ ${tk.length ? (tkSim / tk.length).toFixed(2) : "-"}・|行差| ${tk.length ? (tkLines / tk.length).toFixed(1) : "-"}・次の一手一致 ${pct(tkNext, tk.length)}｜他 ${em.length}: 直さず ${pct(em.filter((r) => norm(r.draft!) === norm(r.sent!)).length, em.length)}`);
    };
    console.log(`\n## ① 返信の番の下書きの質（スタッフが文で返した番だけ）`);
    const replyTurns = rs.filter((r) => r.brain === "返信");
    q1(replyTurns.filter((r) => r.truth === "返信" || r.truth === "2段"), "ブレイン返信×人が文");
    q1(replyTurns.filter((r) => r.truth === "返信"), "  └人も返信（約束なし）");
    q1(replyTurns.filter((r) => r.truth === "返信" && r.ack), "    └お客様が受けだけ");
    q1(replyTurns.filter((r) => r.truth === "返信" && !r.ack), "    └中身あり");
    q1(replyTurns.filter((r) => r.truth === "2段"), "  └人は約束の文");
    q1(rs.filter((r) => r.brain === "2段" && (r.truth === "2段" || r.truth === "返信" || r.truth === "2段→AIX")), "ブレイン2段×人が文");
    q1(rs.filter((r) => r.brain === "AIX" && (r.truth === "返信" || r.truth === "2段")), "ブレインAIX×人が文");
    q1(rs.filter((r) => r.brain === "判断なし" && (r.truth === "返信" || r.truth === "2段")), "判断なし×人が文");
    console.log(`  返信の番で人が文で返した時の下書きの有無: ${count(replyTurns.filter((r) => r.truth === "返信" || r.truth === "2段"), (r) => String(r.replyKind)).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  小場面ごと（ブレイン返信×人も返信・下書き×送信 n>=4）: 直さず／遠さ`);
    const rr = replyTurns.filter((r) => r.truth === "返信" && r.draft);
    for (const [s, c] of count(rr, (r) => r.sub)) { if (c < 4) continue; const xs = rr.filter((r) => r.sub === s); console.log(`    ${s.padEnd(30)} n=${String(c).padStart(3)} 直さず ${pct(xs.filter((r) => norm(r.draft!) === norm(r.sent!)).length, c)}・遠さ ${(xs.reduce((a, r) => a + 1 - dice(r.draft!, r.sent!), 0) / c).toFixed(2)}`); }

    // ② AIX の番
    console.log(`\n## ② AIX の番の当たり（ブレイン AIX）`);
    const ax = rs.filter((r) => r.brain === "AIX");
    const fam = (k: string) => famOf(k.split("/")[0]);
    const aixAct = (r: Row) => {
      const bf = fam(r.brainKey);
      if (r.truth === "AIX" || r.truth === "2段→AIX") return r.truthFam === bf ? (r.truth === "2段→AIX" ? "同じ AIX（約束の文の後）" : "同じ AIX") : "違う AIX";
      if (r.truth === "なし") return r.laterAix.includes(bf) ? "黙って後で同じ AIX" : "何もしない";
      if (r.truth === "2段") return r.laterAix.includes(bf) ? "約束の文→後で同じ AIX" : "約束の文だけ";
      return r.laterAix.includes(bf) ? "返信→後で同じ AIX" : "返信で済ませた";
    };
    for (const [k, v] of count(ax, aixAct)) console.log(`    ${k.padEnd(24)} ${pct(v, ax.length)}`);
    const pick = ax.filter((r) => r.truth === "AIX" || r.truth === "2段→AIX");
    console.log(`  押した番だけ: 同じ AIX ${pct(pick.filter((r) => r.truthFam === fam(r.brainKey)).length, pick.length)}`);
    console.log(`  違う AIX（ブレイン→人）:`);
    for (const [k, v] of count(pick.filter((r) => r.truthFam !== fam(r.brainKey)), (r) => `${fam(r.brainKey)} → ${r.truthFam}`).slice(0, 12)) console.log(`    ${k.padEnd(44)} ${v}`);
    console.log(`  AIX の種類ごと: 同じ AIX を押した／返信で済ませた（後で同じも含めず）／n`);
    for (const [k, c] of count(ax, (r) => fam(r.brainKey))) {
      const xs = ax.filter((r) => fam(r.brainKey) === k);
      console.log(`    ${k.padEnd(26)} n=${String(c).padStart(3)} 同じ ${pct(xs.filter((r) => /同じ/.test(aixAct(r))).length, c)}・返信 ${pct(xs.filter((r) => aixAct(r) === "返信で済ませた" || aixAct(r) === "約束の文だけ").length, c)}・違う ${xs.filter((r) => aixAct(r) === "違う AIX").length}`);
    }
    console.log(`  両方（2段）の番:`);
    const two = rs.filter((r) => r.brain === "2段");
    for (const [k, v] of count(two, (r) => `${r.brainKey} ← 人 ${r.truth === "AIX" || r.truth === "2段→AIX" ? `${r.truth}:${r.truthFam}` : r.truth}${(r.truth === "返信" || r.truth === "2段") && r.laterAix.length ? `（後で ${r.laterAix.join(",")}）` : ""}`).slice(0, 14)) console.log(`    ${k.padEnd(56)} ${v}`);

    // ③ 区別の外れ
    console.log(`\n## ③ 区別の外れ`);
    const a = rs.filter((r) => r.brain === "返信" && (r.truth === "AIX" || r.truth === "2段→AIX"));
    const b = rs.filter((r) => r.brain === "AIX" && (r.truth === "返信" || r.truth === "2段") && !r.laterAix.includes(fam(r.brainKey)));
    const b2 = rs.filter((r) => r.brain === "AIX" && (r.truth === "返信" || r.truth === "2段") && r.laterAix.includes(fam(r.brainKey)));
    const c2 = rs.filter((r) => r.brain === "2段" && r.truth === "返信" && !r.laterAix.length);
    const dec = rs.filter((r) => r.brain !== "判断なし" && r.truth !== "なし");
    console.log(`  判断のある・人が動いた番 ${dec.length}｜A ブレイン返信→人 AIX ${a.length}｜B ブレイン AIX→人 文で済ませた ${b.length}（＋文の後72h以内に同じ AIX ${b2.length}）｜C ブレイン2段→人 返信だけ（AIX を後で押さず）${c2.length}`);
    console.log(`  A の型（人の AIX）: ${count(a, (r) => String(r.truthFam)).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  A の型（場面）: ${count(a, (r) => r.sub).slice(0, 10).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  A の型（ブレインの返信の種類）: ${count(a, (r) => `${r.brainKey}${r.brainSrc ? `/${r.brainSrc}` : ""}`).slice(0, 8).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  A の型（人の AIX×場面）:`);
    for (const [k, v] of count(a, (r) => `${r.truthFam}｜${r.sub}`).slice(0, 12)) console.log(`    ${k.padEnd(52)} ${v}`);
    console.log(`  B の型（ブレインの AIX）: ${count(b, (r) => fam(r.brainKey)).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  B の型（場面）: ${count(b, (r) => r.sub).slice(0, 10).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  B の型（AIX×場面×人の文）:`);
    for (const [k, v] of count(b, (r) => `${fam(r.brainKey)}｜${r.sub}｜${r.truth === "2段" ? `約束:${r.promise}` : "返信"}`).slice(0, 14)) console.log(`    ${k.padEnd(60)} ${v}`);
    console.log(`  B の判断の出所: ${count(b, (r) => r.brainSrc || "-").slice(0, 8).map(([k, v]) => `${k} ${v}`).join("・")}`);
    console.log(`  B の人の文の下書き: ${count(b, (r) => String(r.replyKind)).map(([k, v]) => `${k} ${v}`).join("・")}`);
    if (withSamples) {
      console.log(`\n  --- A の見本（ブレイン返信・人 AIX）`);
      const seenA = new Set<string>();
      for (const r of a) { const k = `${r.truthFam}|${r.sub}`; if (seenA.has(k) && seenA.size < SAMPLES) continue; seenA.add(k); console.log(sample(r)); if (seenA.size >= SAMPLES) break; }
      console.log(`\n  --- B の見本（ブレイン AIX・人 文）`);
      const seenB = new Set<string>();
      for (const r of b) { const k = `${fam(r.brainKey)}|${r.sub}`; if (seenB.has(k) && seenB.size < SAMPLES) continue; seenB.add(k); console.log(sample(r)); if (seenB.size >= SAMPLES) break; }
      console.log(`\n  --- C の見本（ブレイン2段・人 返信だけ）`);
      for (const r of c2.slice(0, Math.min(3, SAMPLES))) console.log(sample(r));
    }
  };

  const all = rows.filter((r) => ms(r.at) >= SINCE);
  console.log(`# AIX と返信を分けた物差し（直近${DAYS}日・番 ${all.length}）｜除外: 申込以降 ${skipPost}・3時間以内の続き ${skipCont}・窓が開いて何もしていない ${skipOpen}・テスト/社内 ${skipTest}`);
  report(`直近${DAYS}日`, all, true);
  report(`${SINCE2}〜`, all.filter((r) => r.period2), true);

  // ④ 全体の「直さず送った」を割る（下書き側から数える＝audit-draft-vs-takeuchi の ① と同じ母数）
  for (const [lab, lo] of [[`直近${DAYS}日`, SINCE], [`${SINCE2}〜`, ms(SINCE2)]] as const) {
    const ex = exs.filter((e) => !isTestConversation(e.conversation_id) && exAt(e) >= lo && cleanDraft(e.ai_draft).text && String(e.sent_reply ?? "").trim());
    const same = (e: Ex) => norm(cleanDraft(e.ai_draft).text!) === norm(String(e.sent_reply));
    console.log(`\n## ④ 「直さず送った」を分ける（${lab}・下書き×実送信 ${ex.length}）`);
    console.log(`  全体: 直さず ${pct(ex.filter(same).length, ex.length)}`);
    const grp = (e: Ex) => { const r = exToRow.get(e.id); if (!r) return "番に結べない（申込以降・連投の途中・こちらから 等）"; return `${brainGroup(r)}／人 ${r.truth}`; };
    for (const [k, c] of count(ex, grp)) { const xs = ex.filter((e) => grp(e) === k); console.log(`    ${k.padEnd(44)} n=${String(c).padStart(4)} 直さず ${pct(xs.filter(same).length, c)}`); }
    const g2 = (e: Ex) => { const r = exToRow.get(e.id); return r ? brainGroup(r) : "番に結べない"; };
    console.log(`  ブレインの判断だけで:`);
    for (const [k, c] of count(ex, g2)) { const xs = ex.filter((e) => g2(e) === k); console.log(`    ${k.padEnd(28)} n=${String(c).padStart(4)} 直さず ${pct(xs.filter(same).length, c)}・竹内さんの番 ${pct(xs.filter((e) => exToRow.get(e.id)?.writer === "takeuchi" && same(e)).length, xs.filter((e) => exToRow.get(e.id)?.writer === "takeuchi").length)}`); }
    // 番に結べない下書きの中身（どの時刻・書き手）
  }
  if (OUT) writeFileSync(OUT, rows.map((r) => JSON.stringify({ ...r, draft: r.draft ? mask(r.draft).slice(0, 300) : null, sent: r.sent ? mask(r.sent).slice(0, 300) : null })).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
