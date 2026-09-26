// 申込中の会話（個人情報が入る期間）が DeepSeek に届いていないかを数える（読み取りのみ・件数と会話ID 先頭8桁だけを出す・本文は出さない）
//
// 2026-09-26 竹内「申込の間の部分は DeepSeek に渡さず、申込落ちてステータスを切り替えたら、切り替えたところ以降渡せば個人情報防げる」
//   = 申込中は DeepSeek に一切渡さない／否決で段階を戻したら「戻した時刻より後」のメッセージだけ渡す。Claude（ブレイン等）はそのまま。
//   仕組み: app/lib/post-apply.ts deepseekSafeCutoff（線）＋ conversations.deepseek_cutoff_at（消えない列・DB のトリガーが書く）
//           ＋ 各経路が線より前を切る ＋ 出口（llm-alt-provider）の二重の鍵（印なし・blocked は回さない／線より前のお客様の発言が残っていれば回さない）
//
// 見る物:
//   ① 本番（env=production）の DeepSeek 呼び出し（llm_usage_logs・model like deepseek%）を、その時点の線で分ける
//      （申込の記録なし＝全部／申込中＝渡してはいけない／線あり＝線より後だけ）。線は今の deepseek_cutoff_at・戻しの印のうち呼び出しより前の物
//   ② 線ありの呼び出しで、直近25件（page.tsx が generate-reply に渡す窓）に線より前のメッセージが何件入っていたか（直す前）と、
//      同じ窓に今の切り方（filterAfterCutoff＋線より前の発言への返信は Claude）を当てた時に届く件数（直した後の形・0 になるはず）
//   ③ --since=<ISO>（本番に出した時刻）: その後の本番の DeepSeek 呼び出しで「申込中」「線より前の発言への返信」が0か（後日の確認手順）
//   ④ 今の status は申込前なのに「申込以降」扱い（線が引けない＝下書きも止まる）の会話
//   ⑤ 申込期間のまとめ（apply_period_summaries・2026-09-27）: 線のある会話にまとめがあるか・渡している（ok）まとめに
//      個人情報の語・名前・電話等・保証会社の名前が入っていないか（作った時と同じ検査をもう一度当てる。本文は出さない）
//   ⚠ その時点の status は履歴が無い（conversation_stage_history は 9/14 以降の手の変更だけ）ので、①の「申込中」には status だけで申込中だった回は入らない
//   ⚠ 会話IDが残らない経路（property_image_read / property_image_detail / property_rank 等）と、llm_usage_logs に記録しない経路
//     （/api/evaluate-property・token-resolve・resolve-area）はここでは数えられない（evaluate-property は同じ線で要約を切る＝コードで確認）
//
// 実行: npx tsx --env-file=.env.local scripts/audit-deepseek-pii.ts [--days=30] [--since=2026-09-27T12:00:00+09:00]
import { createClient } from "@supabase/supabase-js";
import { DRAFT_SKIP_STATUSES } from "../app/lib/conversation-status";
import { piiReasons, checkApplySummary, type ApplyPeriodSummary } from "../app/lib/apply-period-summary";
import { resolvePostApply, deepseekSafeCutoff, cutoffMs, filterAfterCutoff, isAfterCutoff, NO_CUTOFF, type DeepseekCutoff } from "../app/lib/post-apply";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=").slice(1).join("=") ?? null;
const days = Number(arg("days") ?? 30) || 30;
const since = arg("since");
const WINDOW = 25;
/** 申込以降の歯止め（post-apply.ts の記録ベース）を本番に出した時刻 2026-09-23 12:00 JST（申込中の回をこの前後で分ける） */
const GUARD_AT = Date.parse("2026-09-23T03:00:00Z");
const PII_WORDS = /勤務先|勤続|年収|月収|手取り|緊急連絡先|連帯保証|保証人|生年月日|会社名|在籍|源泉|住民票|本籍|免許証|保険証|マイナンバー|健康保険|続柄|現住所/;
const T = (s: string | null | undefined) => (s ? new Date(s).getTime() : NaN);
/** 会話の本文が入る経路（会話ID が無いのに来たら出口の鍵をすり抜けた疑い） */
const CONVERSATION_ACTIONS = new Set(["reply_generate", "property_send", "property_recommendation", "property_check_result", "greeting_viewing", "zenryoku_support", "cost_breakdown", "estimate_sheet", "pickup_image_analysis_auto"]);

async function all<T>(b: (a: number, z: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < 100; p++) {
    const { data, error } = await b(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as T[]; out.push(...r); if (r.length < 1000) break;
  }
  return out;
}

type Conv = { id: string; status: string | null; is_post_apply: boolean | null; status_manual_back_at: string | null; deepseek_cutoff_at: string | null };

async function main() {
  const from = since ?? new Date(Date.now() - days * 864e5).toISOString();
  const alt = await all<{ created_at: string; action: string | null; conversation_id: string | null }>((a, z) => sb.from("llm_usage_logs").select("created_at, action, conversation_id").ilike("model", "%deepseek%").eq("env", "production").gte("created_at", from).order("created_at").range(a, z));
  const convs = await all<Conv>((a, z) => sb.from("conversations").select("id, status, is_post_apply, status_manual_back_at, deepseek_cutoff_at").range(a, z));
  const pushes = await all<{ conversation_id: string; created_at: string }>((a, z) => sb.from("aix_usage_logs").select("conversation_id, created_at").eq("aix_type", "application_push").range(a, z));
  const docs = await all<{ conversation_id: string; created_at: string }>((a, z) => sb.from("messages").select("conversation_id, created_at").in("image_type", ["id_document", "income_document"]).eq("sender", "customer").range(a, z));
  const byId = new Map(convs.map((c) => [c.id, c]));
  const recs = new Map<string, number[]>();
  for (const r of [...pushes, ...docs]) { const a = recs.get(r.conversation_id) ?? []; a.push(T(r.created_at)); recs.set(r.conversation_id, a); }

  /** 呼び出しの時点 t の線（記録・線の列は t より前の物だけ。status は今の値＝その時点の status は分からない） */
  const cutoffAt = (c: Conv | undefined, cid: string, t: number): DeepseekCutoff => {
    const before = (recs.get(cid) ?? []).filter((x) => x < t);
    const iso = (v: number | null) => (v === null ? null : new Date(v).toISOString());
    const upTo = (s: string | null | undefined) => { const v = T(s); return Number.isFinite(v) && v < t ? s! : null; };
    return deepseekSafeCutoff({
      status: DRAFT_SKIP_STATUSES.has(c?.status ?? "") ? "proposing" : c?.status ?? null, // 今の status は使わない（その時点では分からない）
      isPostApply: false,
      applicationPushAt: iso(before.length ? Math.max(...before) : null),
      idDocumentAt: null,
      statusManualBackAt: upTo(c?.status_manual_back_at),
      deepseekCutoffAt: upTo(c?.deepseek_cutoff_at),
    });
  };

  console.log(`=== ① 本番の DeepSeek 呼び出し（${since ? `${since} 以降` : `直近${days}日`}・${alt.length}回）を、その時点の線で分ける ===`);
  type Bucket = { n: number; convs: Set<string>; byAct: Map<string, number> };
  const cat = new Map<string, Bucket>();
  const add = (k: string, cid: string, act: string) => { const e = cat.get(k) ?? { n: 0, convs: new Set<string>(), byAct: new Map<string, number>() }; e.n++; if (cid) e.convs.add(cid); e.byAct.set(act, (e.byAct.get(act) ?? 0) + 1); cat.set(k, e); };
  const cutCalls: Array<{ cid: string; t: number; line: string; act: string }> = [];
  let noConvConversational = 0;
  for (const r of alt) {
    const act = r.action ?? "?"; const cid = r.conversation_id ?? "";
    if (!cid) { add("会話IDなし（紐付けできない）", "", act); if (CONVERSATION_ACTIONS.has(act)) noConvConversational++; continue; }
    const t = T(r.created_at);
    const line = cutoffAt(byId.get(cid), cid, t);
    if (line === null) add(`申込中（渡してはいけない）・${t >= GUARD_AT ? "9/23 の歯止めの後" : "歯止めの前"}`, cid, act);
    else if (line === NO_CUTOFF) add("申込の記録なし（全部渡してよい）", cid, act);
    else { add("線あり（線より後だけ渡してよい）", cid, act); cutCalls.push({ cid, t, line: line as string, act }); }
  }
  for (const [k, e] of cat) console.log(`   ${k}: ${e.n}回・${e.convs.size}会話  [${[...e.byAct].map(([a, n]) => `${a}:${n}`).join(" ")}]${k.startsWith("申込中") || k.startsWith("線あり") ? `  会話: ${[...e.convs].map((x) => x.slice(0, 8)).join(",")}` : ""}`);
  console.log(`   会話の本文が入る経路なのに会話IDなし: ${noConvConversational}回`);

  console.log(`\n=== ② 線ありの呼び出しの直近${WINDOW}件: 直す前に入っていた線より前のメッセージ ／ 今の切り方を当てた時に届く件数 ===`);
  let totalBefore = 0, totalAfter = 0, blocked = 0;
  for (const cid of [...new Set(cutCalls.map((x) => x.cid))]) {
    const msgs = await all<{ created_at: string; text: string | null; image_type: string | null; sender: string }>((a, z) => sb.from("messages").select("created_at, text, image_type, sender").eq("conversation_id", cid).order("created_at").range(a, z));
    const calls = cutCalls.filter((x) => x.cid === cid);
    let inWin = 0, pii = 0, idd = 0, after = 0, blk = 0;
    for (const call of calls) {
      const win = msgs.filter((m) => T(m.created_at) < call.t).slice(-WINDOW);
      const pre = win.filter((m) => !isAfterCutoff(m.created_at, call.line));
      inWin += pre.length; pii += pre.filter((m) => PII_WORDS.test(m.text ?? "")).length; idd += pre.filter((m) => m.image_type === "id_document" || m.image_type === "income_document").length;
      // 今の形: 返信生成は最後のお客様発言が線より前なら Claude（blocked）。それ以外は線より後だけ
      const lastCust = [...win].reverse().find((m) => m.sender === "customer");
      if (call.act === "reply_generate" && !isAfterCutoff(lastCust?.created_at ?? null, call.line)) { blk++; continue; }
      after += filterAfterCutoff(win, (m) => m.created_at, call.line).filter((m) => !isAfterCutoff(m.created_at, call.line)).length;
    }
    totalBefore += inWin; totalAfter += after; blocked += blk;
    console.log(`   ${cid.slice(0, 8)} 呼び出し${calls.length}回: 直す前 線より前 延べ${inWin}件（個人情報の語 ${pii}件・証明書類の印 ${idd}件）→ 今の形 ${after}件（Claude に戻す ${blk}回）`);
  }
  console.log(`   合計: 直す前 ${totalBefore}件 → 今の形 ${totalAfter}件（線より前の発言への返信で Claude に戻す ${blocked}回）`);

  if (since) {
    console.log(`\n=== ③ ${since} 以降（本番に出した後）の確認 ===`);
    const bad = [...cat].filter(([k]) => k.startsWith("申込中")).reduce((a, [, e]) => a + e.n, 0);
    console.log(`   申込中の DeepSeek 呼び出し: ${bad}回（0 であること）`);
    let viol = 0;
    for (const call of cutCalls.filter((c) => c.act === "reply_generate")) {
      const { data } = await sb.from("messages").select("created_at").eq("conversation_id", call.cid).eq("sender", "customer").lt("created_at", new Date(call.t).toISOString()).order("created_at", { ascending: false }).limit(1);
      const last = (data ?? [])[0] as { created_at?: string } | undefined;
      if (!isAfterCutoff(last?.created_at ?? null, call.line)) viol++;
    }
    console.log(`   線より前の発言への返信を DeepSeek で作った回: ${viol}回（0 であること）`);
    console.log(`   会話の本文が入る経路なのに会話IDなし: ${noConvConversational}回（0 であること）`);
    console.log(`   ※ 本文そのものは残していない。出口の網で止めた回は Vercel のログ「[llm-alt] 線より前のお客様の発言が本文に残っている」、`);
    console.log(`     入口で切った回は「deepseek-cutoff:cut」「deepseek-cutoff:aix-history」、Claude に戻した回は「deepseek-cutoff:blocked」で数える`);
  }

  console.log(`\n=== ④ 今の status は申込前なのに「申込以降」扱い（線が引けない＝下書きも止まる）会話 ===`);
  const lost = new Map<string, string[]>();
  for (const c of convs) {
    const rs = recs.get(c.id); if (!rs || DRAFT_SKIP_STATUSES.has(c.status ?? "") || c.is_post_apply) continue;
    const f = { status: c.status, isPostApply: c.is_post_apply, applicationPushAt: new Date(Math.max(...rs)).toISOString(), idDocumentAt: null, statusManualBackAt: c.status_manual_back_at, deepseekCutoffAt: c.deepseek_cutoff_at };
    const k = resolvePostApply(f).postApply ? `status=${c.status}・申込の記録より後の切り替えなし（申込へ押下・書類の後に戻していない）` : `status=${c.status}・線あり（${cutoffMs(deepseekSafeCutoff(f)) === null ? "?" : "線より後だけ"}）`;
    const a = lost.get(k) ?? []; a.push(c.id.slice(0, 8)); lost.set(k, a);
  }
  for (const [k, v] of lost) console.log(`   ${k}: ${v.length}会話`);

  console.log(`\n=== ⑤ 申込期間のまとめ（個人情報なし）: 線のある会話ごとの状態と、渡しているまとめの再検査 ===`);
  const sums = await all<{ conversation_id: string; cutoff_at: string; status: string; block: string | null; summary_json: ApplyPeriodSummary | null; reject_reasons: string[] | null; input_tokens: number | null; output_tokens: number | null }>((a, z) => sb.from("apply_period_summaries").select("conversation_id, cutoff_at, status, block, summary_json, reject_reasons, input_tokens, output_tokens").range(a, z));
  const sumBy = new Map(sums.map((r) => [r.conversation_id, r]));
  const lined = convs.filter((c) => c.deepseek_cutoff_at);
  const st = new Map<string, string[]>();
  for (const c of lined) {
    const r = sumBy.get(c.id);
    const k = !r ? "まとめ無し（sweep 待ち）" : T(r.cutoff_at) !== T(c.deepseek_cutoff_at) ? "古い線のまとめ（作り直し待ち）" : r.status;
    const a = st.get(k) ?? []; a.push(c.id.slice(0, 8)); st.set(k, a);
  }
  for (const [k, v] of st) console.log(`   ${k}: ${v.length}会話  ${v.join(",")}`);
  const rejected = sums.filter((r) => r.status === "rejected");
  if (rejected.length) console.log(`   検査で止めた理由（種類だけ）: ${[...new Set(rejected.flatMap((r) => r.reject_reasons ?? []))].join(" ")}`);
  let bad = 0;
  for (const r of sums.filter((x) => x.status === "ok")) {
    const conv = await sb.from("conversations").select("customer_name").eq("id", r.conversation_id).maybeSingle();
    const ctx = { conversationId: r.conversation_id, customerName: (conv.data as { customer_name?: string } | null)?.customer_name ?? null };
    const reasons = new Set<string>([
      ...(r.summary_json ? checkApplySummary(r.summary_json, ctx) : ["summary_json なし"]),
      // ブロックの本文そのもの（見出しと注意書きの定型を除いた行）にも当てる
      ...piiReasons((r.block ?? "").split("\n").filter((l) => l.startsWith("・")).join("\n"), ctx, { names: true, family: true }),
    ]);
    if (reasons.size) { bad++; console.log(`   ⚠ ${r.conversation_id.slice(0, 8)}: ${[...reasons].join(" ")}`); }
  }
  const tok = sums.filter((r) => r.input_tokens);
  console.log(`   渡しているまとめ ${sums.filter((x) => x.status === "ok").length}件のうち個人情報の検査に当たる物: ${bad}件（0 であること）`);
  if (tok.length) console.log(`   1件あたり 入力 平均${Math.round(tok.reduce((a, r) => a + (r.input_tokens ?? 0), 0) / tok.length)}・出力 平均${Math.round(tok.reduce((a, r) => a + (r.output_tokens ?? 0), 0) / tok.length)} トークン（${tok.length}件）`);
}
main().catch((e) => { console.error(e); process.exit(1); });
