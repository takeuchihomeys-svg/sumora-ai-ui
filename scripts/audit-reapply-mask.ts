// 出口の網「Claude に戻す」→「値を伏せてから DeepSeek」の前後比べ（読み取りのみ・LLM なし・件数と会話ID 先頭8桁だけ・本文は出さない）
//
// 2026-10-21 竹内さんの決定（414dc9d4・ec4d5990）:
//   ① 申込歴あり（再探し）の会話（resolveReapply）＋ 2番手で申込中（並行で探す）の会話で、出口に届く呼び出しを作り物で組み立て（お客様の発言ごとに直近25件の窓・入口の伏せ maskPII）、
//      旧（網に当たれば Claude）と新（maskAltBody で伏せ → 値が残る時だけ Claude）で DeepSeek に残る呼び出しの数を比べる。
//   ② 新で DeepSeek に送る本文に値が残っていないかを、出口の網とは別の網（piiValueSignal・altPiiValuesRemain・書類の読み取り）でもう一度確かめる。
//   ③ 本番の記録（llm_usage_logs の alt_skipped_pii）でこれらの会話が網で Claude に戻った回数（参考）。
// 実行: npx tsx --env-file=.env.local scripts/audit-reapply-mask.ts [--extra=<会話ID先頭8桁,...>]
import { createClient } from "@supabase/supabase-js";
import { loadPostApplyFacts, deepseekSafeCutoff, cutoffMs, NO_CUTOFF, parallelSecondActive, parallelEligible, loadParallelSecondState, parallelSecondCutoff } from "../app/lib/post-apply";
import { resolveReapply } from "../app/lib/reapply-customer";
import { altPiiSignal, altPiiSignalReapply, altPiiSignalReapplyValues, maskAltBody, altPiiValuesRemain } from "../app/lib/alt-pii-gate";
import { piiValueSignal } from "../app/lib/test-pii-guard";
import { screeningSensitiveSignal } from "../app/lib/screening-sensitive";
import { maskPII } from "../app/lib/pii-mask";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const id8 = (s: string) => s.slice(0, 8);
// --as-parallel=…: スタッフが「はい」を選んだと仮定して並行で数える会話（10/21 確かめ役の後: 線＝申込の記録・2番手の時刻の遅い方より後だけ・REAPPLY_PARALLEL_DEEPSEEK=on の時の形）
const asParallel = (process.argv.find((a) => a.startsWith("--as-parallel="))?.slice(14) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
// 別の網（出口の網とは独立）: お客様の行に残る住所らしい形・カナの氏名・7桁の郵便番号・100万以上の金額（年収）
const LOOSE: Array<[string, RegExp]> = [
  ["住所らしい形", /[一-龯]{1,4}(?:市|区|町|村)[一-龯ぁ-んァ-ヶ0-9０-９]{0,12}\d{1,4}[-－]\d{1,4}/],
  // 氏名と読み（「〇〇 〇〇（カナ カナ）」「〇〇 〇〇 カナ カナ」）。カナの語の並びだけ（物件名「シャーメゾン 〇〇」）は 10/21 の目視で全部物件名だったので数えない
  ["氏名と読み", /[一-龯々ぁ-ん]{2,5}[\s　]*[（(][ァ-ヶー]+[\s　][ァ-ヶー]+[）)]|[一-龯々]{1,4}[\s　][一-龯々]{1,4}[\s　]+[ァ-ヶー]{2,}[\s　][ァ-ヶー]{2,}/],
  // 不動産・自社・管理会社でない法人名（勤め先）
  ["法人名", /(?<!管理会社(?:は|：|:)?|提携会社の)[^\s、。]{0,12}(?:株式会社|有限会社|合同会社|社団法人|カブシキガイシャ|ホウジン)(?![^\s、。]{0,12}(?:不動産|レオパレス|管理))/],
  ["7桁の郵便番号", /(?<!\d)\d{7}(?!\d)/],
  ["100万以上の金額", /(?<![\d,])\d{3,4}\s*万/],
];
function looseNet(masked: string): string | null {
  // スタッフの行・物件の文の行（交通・所在地・号室・マンション名…）・URL は見ない（物件名・物件の住所・URL の数字で当たるだけ）
  const cust = masked.split("\n").filter((l) => !/^スタッフ:/.test(l) && !/交通|徒歩|駅|所在地|物件|間取り|賃料|家賃|築|号室|管理費|マンション|アパート|ハイツ|レジデンス|【/.test(l))
    .map((l) => l.replace(/https?:\/\/\S+/g, " ")).join("\n");
  // 自社・提携の不動産会社の名乗り（「蓮産業株式会社の竹内です」）は個人の値ではない
  const c2 = cust.replace(/蓮産業株式会社|[^\s、。]{0,12}不動産株式会社|株式会社[^\s、。]{0,12}不動産/g, " ");
  for (const [k, re] of LOOSE) if (re.test(c2)) return k;
  return null;
}
// 10/21 確かめ役が見つけた穴の網（出口の網とは別に書いた形・送る本文のどの行でも見る・URL は除く）
const HOLES: Array<[string, RegExp]> = [
  ["①「・」の後の生年月日", /[・･]\s*(?:(?:19\d{2}|200\d)\s*[./\-年]\s*\d{1,2}\s*[./\-月]\s*\d{1,2}|(?:昭和|平成)\s*(?:\d{1,2}|元)\s*年\s*\d{1,2}\s*[/.月]\s*\d{1,2})/],
  ["①' 古い年の年月日（区切りが . / -）", /(?<!\d)(?:19[2-9]\d|200\d)\s*[./\-]\s*\d{1,2}\s*[./\-]\s*\d{1,2}(?!\d)/],
  ["② 全角空白の見出し＋値", /(?:住[ 　]+所|氏[ 　]+名|生[ 　]*年[ 　]*月[ 　]*日|フ[ 　]+リ[ 　]*ガ[ 　]*ナ)[ 　]*[:：]?[ 　]*(?![［[〇○\s、。:：をのはがにへ])\S/],
  ["③ ファイル名の中の名前", /[_＿][一-龯々ぁ-ん]{1,5}[_＿][一-龯々ぁ-ん]{1,5}[_＿.]|[一-龯々]{1,4}[_＿][一-龯々]{1,4}[_＿](?:給与|源泉|在籍|住民|免許|保険|課税|所得)/],
  ["④ 読みの文", /(?:フリガナ|ふりがな|読み方?|よみかた|カナ)\s*(?:は|が|：|:|＝)\s*[ァ-ヶーぁ-ん]{2,}/],
  ["⑤ 丁目・番地の数字", /(?<![\d/.:])(?!(?:19|20)\d{2}[-－‐ー−]\d)\d{1,4}[-－‐ー−]\d{1,4}[-－‐ー−]\d{1,4}(?!\d)|\d{1,3}丁目\s*\d{1,4}|\d{1,4}番地/],
  ["⑥ 在籍・勤務先の行の法人名", /(?:在籍|勤務先|会社名|お勤め|勤め先)[^\n]{0,40}(?:株式会社|有限会社|合同会社|（株）|\(株\))|(?:株式会社|有限会社|合同会社|（株）|\(株\))[^\n]{0,40}(?:在籍|勤務先|会社名)/],
];
function holeKinds(body: string): string[] {
  const t = body.replace(/https?:\/\/\S+/g, " ").replace(/\[(?:電話番号|メールアドレス|郵便番号)非表示\]/g, " ");
  return HOLES.filter(([, re]) => re.test(t)).map(([k]) => k);
}
const extra = (process.argv.find((a) => a.startsWith("--extra="))?.slice(8) ?? "d46290ff").split(",").map((s) => s.trim()).filter(Boolean);
type Msg = { sender: string; text: string | null; created_at: string };

async function main() {
  // 対象: 戻しの印・切り替えの時刻のある会話（申込歴あり）＋ 申込中の会話（2番手で並行）＋ 指定の会話
  const rows: Array<{ id: string }> = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data, error } = await sb.from("conversations").select("id")
      .or("status_manual_back_at.not.is.null,deepseek_cutoff_at.not.is.null,status.in.(applying,application,screening)").order("id").range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  for (const e of [...extra, ...asParallel]) {
    if (rows.some((r) => r.id.startsWith(e))) continue;
    const { data } = await sb.from("conversations").select("id").like("id", `${e}%`).limit(1);
    if (data?.[0]) rows.push(data[0] as { id: string });
  }
  type Target = { id: string; kind: "reapply" | "parallel"; cut: number };
  const targets: Target[] = [];
  for (const r of rows) {
    const f = await loadPostApplyFacts(sb, r.id).catch(() => null);
    if (!f) continue;
    if (asParallel.some((p) => r.id.startsWith(p)) && parallelEligible(f)) { const pl = cutoffMs(parallelSecondCutoff({ ...f, parallel2nd: true })); if (pl !== null) targets.push({ id: r.id, kind: "parallel", cut: pl }); continue; }
    if (resolveReapply(f).reapply) {
      const line = cutoffMs(deepseekSafeCutoff(f, { reapply: true }));
      if (line !== null) targets.push({ id: r.id, kind: "reapply", cut: line });
      continue;
    }
    if (parallelEligible(f)) {
      const st = await loadParallelSecondState(sb, r.id, f).catch(() => null);
      const pl = cutoffMs(parallelSecondCutoff({ ...f, parallel2nd: true, parallel2ndAt: st?.at ?? null }));
      if (st?.parallel && parallelSecondActive({ ...f, parallel2nd: true }) && pl !== null) targets.push({ id: r.id, kind: "parallel", cut: pl });
    }
  }
  console.log(`── 対象: 申込歴あり ${targets.filter((t) => t.kind === "reapply").length}・2番手で並行 ${targets.filter((t) => t.kind === "parallel").length}`,
    targets.map((t) => `${id8(t.id)}${t.kind === "parallel" ? "(並行)" : ""}`).join(" "));

  let calls = 0, oldDs = 0, newDs = 0, newClaude = 0, remainAfter = 0, otherNetHits = 0, sens = 0;
  const holeHits: Record<string, number> = {}; let holeCalls = 0;
  const oldWhy: Record<string, number> = {}, newWhy: Record<string, number> = {}, otherKinds: Record<string, number> = {};
  const perConv: string[] = [];
  for (const t of targets) {
    const { data } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", t.id).order("created_at", { ascending: false }).limit(300);
    const all = ((data ?? []) as Msg[]).reverse().filter((m) => t.cut === NO_CUTOFF || Date.parse(m.created_at) > t.cut);
    const { data: sum } = await sb.from("apply_period_summaries").select("status, block").eq("conversation_id", t.id).maybeSingle();
    const s = sum as { status?: string; block?: string | null } | null;
    const sys = `【会話の材料】\n${s?.status === "ok" && t.kind === "reapply" ? s.block ?? "" : ""}`;
    const turns = all.map((m, i) => ({ m, i })).filter((x) => x.m.sender === "customer").slice(-20);
    let cOld = 0, cNew = 0;
    for (const { i } of turns) {
      const win = all.slice(Math.max(0, i - 24), i + 1);
      const msgs = win.map((m) => `${m.sender === "customer" ? "お客様" : "スタッフ"}: ${maskPII(String(m.text ?? ""), [])}`).join("\n");
      calls++;
      const sensHit = screeningSensitiveSignal(win.filter((m) => m.sender === "customer").map((m) => m.text).join("\n"));
      // 旧: 網に当たれば Claude
      const o = altPiiSignal(`${sys}\n${msgs}`) ?? altPiiSignalReapply(msgs) ?? altPiiSignalReapplyValues(sys) ?? (sensHit ? "審査の事情" : null);
      if (o) oldWhy[o] = (oldWhy[o] ?? 0) + 1; else { oldDs++; cOld++; }
      // 新: 伏せてから → 値が残る時だけ Claude（審査の事情は Claude のまま）
      const mk = maskAltBody({ system: sys, messages: [{ role: "user", content: msgs }] });
      const n = mk.remain ?? altPiiSignal(`${mk.masked.system}\n${mk.masked.messages![0].content}`) ?? (sensHit ? "審査の事情" : null);
      if (sensHit) sens++;
      if (n) { newWhy[n] = (newWhy[n] ?? 0) + 1; newClaude++; if (mk.remain) remainAfter++; continue; }
      newDs++; cNew++;
      // 別の網でもう一度（送る本文）
      const body = `${mk.masked.system}\n${mk.masked.messages![0].content}`;
      const hk = holeKinds(body);
      if (hk.length) { holeCalls++; for (const k of hk) holeHits[k] = (holeHits[k] ?? 0) + 1; }
      const k = piiValueSignal(body) ?? altPiiValuesRemain(String(mk.masked.messages![0].content), { docs: true }) ?? altPiiValuesRemain(String(mk.masked.system)) ?? looseNet(String(mk.masked.messages![0].content));
      if (k) { otherNetHits++; otherKinds[k] = (otherKinds[k] ?? 0) + 1; }
    }
    perConv.push(`${id8(t.id)}${t.kind === "parallel" ? "(並行)" : ""}: 呼び出し${turns.length}・DeepSeek 旧${cOld}→新${cNew}`);
  }
  console.log(`── ① 呼び出し ${calls}: DeepSeek に残る 旧 ${oldDs} → 新 ${newDs}（新で Claude ${newClaude}・うち伏せても値が残った ${remainAfter}・審査の事情の窓 ${sens}）`);
  console.log("   旧で Claude に戻した理由:", JSON.stringify(oldWhy));
  console.log("   新で Claude に戻した理由:", JSON.stringify(newWhy));
  console.log(`── ② 新で送る本文に別の網で値が見つかった呼び出し: ${otherNetHits} ${JSON.stringify(otherKinds)}`);
  console.log(`── ②' 新で送る本文に穴の形が残る呼び出し: ${holeCalls} ${JSON.stringify(holeHits)}`);
  for (const l of perConv) console.log("   ", l);

  // ③ 本番の記録（参考）
  const ids = targets.map((t) => t.id);
  if (ids.length) {
    const { data, error } = await sb.from("llm_usage_logs").select("conversation_id, action").gte("created_at", new Date(Date.now() - 30 * 86_400_000).toISOString()).eq("error_type", "alt_skipped_pii").in("conversation_id", ids).limit(2000);
    if (error) console.log("── ③ llm_usage_logs 読めない:", error.message);
    else {
      const by: Record<string, number> = {};
      for (const r of (data ?? []) as Array<{ conversation_id: string; action: string | null }>) by[id8(r.conversation_id)] = (by[id8(r.conversation_id)] ?? 0) + 1;
      console.log(`── ③ 本番30日で網に当たり Claude に戻った回数（alt_skipped_pii）: ${(data ?? []).length}`, JSON.stringify(by));
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
