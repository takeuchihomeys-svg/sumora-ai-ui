// AIX のピッカー（画面で選ぶ選択肢）の実数と、ブレインがピッカーの意味を分かって判断しているかの監査（読み取りのみ・LLM は呼ばない・本文はマスク）
// 2026-09-27 竹内「初期費用しりたいはAIXの初期費用おくるから見積書おくってる／物件なければ物件確認したの募集終了していたのピッカーから／
//   それぞれのピッカーを理解したらもっと意味が分かる」（memory feedback_cost_request_estimate_or_ended）
//
// ① 実送信（aix_usage_logs・DAYS 日・グループと YUMA を除く）で、AIX × ピッカーの値（check_pattern / send_mode / app_sub_mode /
//    picker_choices の主な鍵）ごとの件数と、押す直前のお客様の連投の型（費用・見積の依頼／空き／内覧／室内写真／条件の質問／持ち込み物件／申込／他）
// ② ブレイン（brain_decision_logs・BRAIN_DAYS 日）× スタッフが押した 物件確認した のピッカー: 押した時刻の前24時間の最新の判断と比べる。
//    比べる単位は話題（checkPatternTopic: 募集状況／室内写真／入居日／条件）。募集状況の結果（あった・なかった）はスタッフが確認して選ぶので
//    ブレインの null＝募集状況と同じ扱い。今のコード（resolveBrainCheckPattern）で当て直した値も並べる（保存済みの場面の証拠を使う）
// 一覧の定義は app/lib/aix-pickers.ts（AIX_PICKERS）
// 実行: npx tsx --env-file=.env.local scripts/audit-aix-pickers.ts   （DAYS=180・BRAIN_DAYS=30・SHOW=6）
import { createClient } from "@supabase/supabase-js";
import { AIX_PICKERS, checkPatternTopic, pickerOptionLabel } from "../app/lib/aix-pickers";
import { propertySpecifiedBy, type AixSceneEvidence } from "../app/lib/aix-scene-evidence";
import { detectPropertyCheckPattern } from "../app/lib/aix-taxonomy";
import { resolveBrainCheckPattern } from "../app/lib/brain-aix-feedback";
import { FOCUSED_ESTIMATE_ASK_RE, VACANCY_ASK_RE } from "../app/lib/focused-estimate-request";
import { VIEWING_INTENT_RE } from "../app/lib/scene-patterns";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const DAYS = Number(process.env.DAYS ?? 180);
const BRAIN_DAYS = Number(process.env.BRAIN_DAYS ?? 30);
const SHOW = Number(process.env.SHOW ?? 6);
const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
const mask = (s: string) => s.replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "[電話]").replace(/https?:\/\/\S+/g, "[URL]").replace(/\[画像\][^\n]*/g, "[画像]").replace(/[^\s、。！!？?「」（）()\n:：]{1,8}(さん|様)/g, "〇〇$1").replace(/\s+/g, " ");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
async function page(table: string, cols: string, s: string, tcol = "created_at"): Promise<Row[]> {
  const out: Row[] = [];
  for (let p = 0; p < 400; p++) {
    const { data, error } = await sb.from(table).select(cols).gte(tcol, s).order(tcol).range(p * 1000, p * 1000 + 999);
    if (error) { console.error(table, error.message); break; }
    out.push(...(data ?? [])); if ((data ?? []).length < 1000) break;
  }
  return out;
}

const PHOTO_RE = /(?:室内|お?部屋(?:の中)?|中)の?(?:写真|画像|動画|様子)|室内イメージ|内見の動画/;
const APPLY_RE = /申(?:し)?込(?:み)?(?:ます|したい|させて|お願い)|ここに決め|こちらに決め|契約(?:したい|します)|【お申込者様記入欄】/;
/** 押す直前のお客様の連投の型（1つ・上から順に） */
function turnKind(text: string, hasImage: boolean): string {
  const spec = propertySpecifiedBy(text, { hasCustomerImage: hasImage });
  const brought = spec === "image" || spec === "url";
  if (PHOTO_RE.test(text)) return "室内写真の依頼";
  if (APPLY_RE.test(text)) return "申込の意思・申込書";
  if (FOCUSED_ESTIMATE_ASK_RE.test(text)) return brought ? "持ち込み＋費用・見積" : "費用・見積の依頼";
  if (VACANCY_ASK_RE.test(text)) return brought ? "持ち込み＋空き" : "空きの質問";
  if (detectPropertyCheckPattern(text)) return brought ? "持ち込み＋条件の質問" : "条件の質問";
  if (VIEWING_INTENT_RE.test(text)) return "内覧の希望";
  if (brought) return "持ち込み物件だけ";
  if (!text.trim()) return "（文なし）";
  return "他";
}

async function main() {
  const convs: Row[] = [];
  for (let p = 0; p < 20; p++) { const { data } = await sb.from("conversations").select("id, line_source_type").range(p * 1000, p * 1000 + 999); convs.push(...(data ?? [])); if ((data ?? []).length < 1000) break; }
  const ok = new Set<string>(convs.filter((c) => c.id !== YUMA && c.line_source_type !== "group").map((c) => c.id));
  const msgs = (await page("messages", "conversation_id, sender, text, created_at", new Date(Date.parse(since) - 3 * 86400e3).toISOString())).filter((m) => ok.has(m.conversation_id));
  const logs = (await page("aix_usage_logs", "conversation_id, aix_type, check_pattern, send_mode, app_sub_mode, picker_choices, created_at, sent_at", since)).filter((a) => a.sent_at && ok.has(a.conversation_id));
  const byConv = new Map<string, Row[]>(); for (const m of msgs) { const a = byConv.get(m.conversation_id) ?? []; a.push(m); byConv.set(m.conversation_id, a); }
  const turnBefore = (cid: string, atIso: string): { text: string; hasImage: boolean } => {
    const t = Date.parse(atIso);
    const list = (byConv.get(cid) ?? []).filter((m) => Date.parse(m.created_at) < t);
    let i = list.length - 1;
    while (i >= 0 && list[i].sender !== "customer") i--;
    if (i < 0 || t - Date.parse(list[i].created_at) > 48 * 3600e3) return { text: "", hasImage: false };
    const turn: string[] = []; let img = false;
    for (; i >= 0 && list[i].sender === "customer"; i--) { const tx = (list[i].text ?? "").trim(); if (/^\[画像\]/.test(tx)) img = true; if (tx) turn.unshift(tx); }
    return { text: turn.join("\n"), hasImage: img };
  };

  // ① AIX × ピッカーの値
  console.log(`\n══ ① 実送信のピッカー（${DAYS}日・グループと YUMA を除く・${logs.length}件）`);
  type Cell = { n: number; kinds: Record<string, number>; ex: string[] };
  const cells = new Map<string, Cell>();
  const bump = (k: string, kind: string, ex: string) => { const c = cells.get(k) ?? { n: 0, kinds: {}, ex: [] }; c.n++; c.kinds[kind] = (c.kinds[kind] ?? 0) + 1; if (c.ex.length < SHOW) c.ex.push(ex); cells.set(k, c); };
  for (const l of logs) {
    const turn = turnBefore(l.conversation_id, l.created_at);
    const kind = turnKind(turn.text, turn.hasImage);
    const ex = `${l.created_at.slice(0, 10)} ${l.conversation_id.slice(0, 8)} 「${mask(turn.text).slice(0, 70)}」`;
    const aix = String(l.aix_type ?? "");
    const val = l.check_pattern ? `check_pattern=${l.check_pattern}（${pickerOptionLabel(aix, "check_pattern", l.check_pattern)}）`
      : l.send_mode ? `send_mode=${l.send_mode}（${pickerOptionLabel(aix, "send_mode", l.send_mode)}）`
      : l.app_sub_mode ? `app_sub_mode=${l.app_sub_mode}（${pickerOptionLabel(aix, "app_sub_mode", l.app_sub_mode)}）`
      : "（ピッカーの記録なし）";
    bump(`${aix}｜${val}`, kind, ex);
    const pc = (l.picker_choices ?? null) as Record<string, unknown> | null;
    if (pc) for (const [k, v] of Object.entries(pc)) if (typeof v === "string") bump(`${aix}｜picker_choices.${k}=${v}`, kind, ex);
  }
  for (const k of [...cells.keys()].sort()) {
    const c = cells.get(k)!;
    console.log(`\n■ ${k}  ${c.n}件  直前の連投: ${Object.entries(c.kinds).sort((a, b) => b[1] - a[1]).map(([a, b]) => `${a} ${b}`).join("・")}`);
    c.ex.forEach((e) => console.log("   " + e));
  }
  const withPc = logs.filter((l) => l.picker_choices).length;
  console.log(`\n（picker_choices が入っている行: ${withPc}/${logs.length}・2026-09-27 に列を追加）`);
  const noPicker = Object.keys(AIX_PICKERS).filter((a) => !logs.some((l) => l.aix_type === a));
  if (noPicker.length) console.log(`（この期間に送信の無い AIX: ${noPicker.join("・")}）`);

  // ② ブレイン × スタッフの 物件確認した のピッカー
  const bSince = new Date(Date.now() - BRAIN_DAYS * 86400e3).toISOString();
  const decs = (await page("brain_decision_logs", "conversation_id, created_at, suggested_action, suggested_check_pattern, decision_source, scene_evidence", bSince)).filter((d) => ok.has(d.conversation_id));
  const decBy = new Map<string, Row[]>(); for (const d of decs) { const a = decBy.get(d.conversation_id) ?? []; a.push(d); decBy.set(d.conversation_id, a); }
  const presses = logs.filter((l) => l.created_at >= bSince && String(l.aix_type ?? "").startsWith("property_check_result"));
  let n = 0, actOk = 0, topicOld = 0, topicNew = 0, noDec = 0;
  const pairs: Record<string, number> = {}; const changed: string[] = []; const misses: string[] = [];
  for (const p of presses) {
    const t = Date.parse(p.created_at);
    const d = (decBy.get(p.conversation_id) ?? []).filter((x) => Date.parse(x.created_at) < t && t - Date.parse(x.created_at) < 24 * 3600e3).pop();
    if (!d) { noDec++; continue; }
    n++;
    const staffTopic = checkPatternTopic(p.check_pattern);
    const isPcr = String(d.suggested_action ?? "").startsWith("property_check_result");
    const key = `ブレイン=${d.suggested_action || "なし"}(${d.suggested_check_pattern ?? "-"}) → スタッフ=${p.check_pattern ?? "-"}（${pickerOptionLabel("property_check_result", "check_pattern", p.check_pattern)}）`;
    pairs[key] = (pairs[key] ?? 0) + 1;
    if (!isPcr) continue;
    actOk++;
    const oldTopic = checkPatternTopic(d.suggested_check_pattern);
    if (oldTopic === staffTopic) topicOld++;
    // 今のコードで当て直す（判断の時刻の未返信の連投＋保存済みの場面の証拠。信号で決まった値は decision_source=signal:* の時だけそのまま）
    const turn = turnBefore(p.conversation_id, new Date(Date.parse(d.created_at) + 1000).toISOString());
    const se = d.scene_evidence as { scene?: string; check_pattern?: string | null } | null;
    const ev = se?.scene ? ({ scene: se.scene, checkPattern: se.check_pattern ?? null } as unknown as AixSceneEvidence) : null;
    const signalCp = String(d.decision_source ?? "").startsWith("signal:") ? (d.suggested_check_pattern ?? null) : null;
    const turnText = turn.text.replace(/^\[画像\][^\n]*$/gm, "").trim();
    const k2 = resolveBrainCheckPattern("property_check_result", ev, signalCp, turnText, { hasImage: turn.hasImage });
    const newCp = k2?.check_pattern || null;
    const newTopic = checkPatternTopic(newCp);
    if (newTopic === staffTopic) topicNew++;
    const line = `${p.created_at.slice(5, 16)} ${p.conversation_id.slice(0, 8)} 旧=${d.suggested_check_pattern ?? "-"} 新=${newCp ?? "-"}（${k2?.ui_button ?? "-"}） スタッフ=${p.check_pattern} 「${mask(turn.text).slice(0, 70)}」`;
    if ((d.suggested_check_pattern ?? null) !== newCp) changed.push(line);
    if (newTopic !== staffTopic) misses.push(line);
  }
  console.log(`\n══ ② ブレイン × スタッフが押した 物件確認した（${BRAIN_DAYS}日・押した${presses.length}回・前24時間に判断あり ${n}・なし ${noDec}）`);
  Object.entries(pairs).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${v} ${k}`));
  console.log(`\n  ボタン（物件確認した）が一致 ${actOk}/${n}`);
  console.log(`  ボタンが一致した中でピッカーの話題が一致: 保存済みの判断 ${topicOld}/${actOk} → 今のコードで当て直し ${topicNew}/${actOk}`);
  console.log(`\n── 当て直しで変わった判断（目で読む）`); changed.forEach((l) => console.log("   " + l));
  console.log(`\n── 当て直しでも話題がずれる判断`); misses.forEach((l) => console.log("   " + l));
}
main();
