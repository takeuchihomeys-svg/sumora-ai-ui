// 場面 S5「内覧の日程調整（内見できますか・何時から・オンライン内見）」の今月の実物を集める（読み取りのみ）
//
// 2026-09-23 竹内「実際の成約データや直近の今月のLINEをお手本にして 生成される文にギャップが生まれないか確認する」
//
// 集める物（実物ごと）:
//   お客様の発言 → 3時間以内のスタッフ実送信（AIX 由来か）→ 押した AIX（aix_usage_logs・3時間以内）
//   → その時の下書き（ai_reply_examples.ai_draft・was_ai_used）→ その時のブレイン判断（brain_decision_logs.analyzed_msg_ts が一致）
//   → 会話の status・申込以降まで進んだか（成約側）
// 出力は本名・電話・URL を伏せる（呼び名は〈お客様〉）。
// 実行: npx tsx --env-file=.env.local scripts/audit-scene-s5-viewing.ts [SINCE=2026-09-01] [LIMIT=60]
import { createClient } from "@supabase/supabase-js";
import { classifySentKind } from "../app/lib/sent-shape";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const YUMA = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";
const SINCE = `${process.env.SINCE ?? "2026-09-01"}T00:00:00+09:00`;

/** S5: 内覧の日程調整（内見できますか／何時から／オンライン内見） */
const S5_RE = /(内覧|内見|見学|お部屋を見|部屋を見|オンライン内見)/;
const S5_ASK_RE = /(でき|出来|可能|したい|希望|お願い|いつ|何時|何日|日程|都合|[?？]|行けます|行きたい|大丈夫|空い)/;
/** 具体的な日時（監査 audit-plain-reply-shape と同じ形） */
const HAS_DATETIME = /\d{1,2}\s*[\/／月]\s*\d{1,2}[日]?[^\n]{0,8}(\d{1,2}\s*[:：時])|\d{1,2}\s*[:：]\s*\d{2}|(明日|本日|明後日|今週|来週|土曜|日曜|月曜|火曜|水曜|木曜|金曜)[^\n]{0,12}\d{1,2}\s*[:：時]/;
const HAS_DATE_ONLY = /\d{1,2}\s*[\/／月]\s*\d{1,2}\s*日?|(明日|本日|明後日|今週|来週)/;
const ASK_CONVENIENT = /ご都合[^\n]{0,14}(お日にち|日程|よろしい|いかが)/;
const PROMISE_RE = /([^\n。！!]{0,30}(確認|お調べ|交渉|お送り|ご案内|ご連絡|調整)(させて(頂|いただ)き|いたし|し)ます)/g;
const APPLY_CTA = /お申込|申込へ|申込み(を|に)|ご契約/;

type Msg = { id: string; conversation_id: string; sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null; image_url: string | null };
type Conv = { id: string; customer_name: string | null; status: string | null; is_post_apply: boolean | null; line_source_type: string | null; property_customer_id: string | null };

const WON_STATUSES = new Set(["applying", "screening", "approved", "contract", "contracted", "moved_in", "closed_won", "won"]);
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");

function mask(t: string | null | undefined, names: string[]): string {
  let s = String(t ?? "");
  for (const n of names) if (n && n.length >= 2) s = s.split(n).join("〈お客様〉");
  s = s.replace(/https?:\/\/\S+/g, "〈URL〉").replace(/0\d{1,4}[-‐ー]?\d{1,4}[-‐ー]?\d{3,4}/g, "〈電話〉");
  return s;
}

async function main() {
  const limit = Number(process.env.LIMIT ?? 80);
  // ① 今月のお客様発言のうち S5 に当たる物
  const cand: Msg[] = [];
  for (let p = 0; p < 10; p++) {
    const { data, error } = await sb.from("messages").select("id, conversation_id, sender, text, created_at, is_aix_generated, image_url")
      .eq("sender", "customer").gte("created_at", SINCE).order("created_at", { ascending: true }).range(p * 1000, p * 1000 + 999);
    if (error) { console.error(error.message); break; }
    const r = (data ?? []) as Msg[];
    for (const m of r) {
      const t = m.text ?? "";
      if (m.conversation_id === YUMA) continue;
      // 物件サイトの画像の読み取り文（「無料 内見予約」）は S5 ではない
      if (/^\s*\[画像\]/.test(t) || /内見予約|お問い合わせ\s*$/m.test(t)) continue;
      if (S5_RE.test(t) && S5_ASK_RE.test(t) && t.length <= 400) cand.push(m);
    }
    if (r.length < 1000) break;
  }
  console.log(`=== S5 候補（今月・お客様発言）${cand.length}件 ===\n`);
  const convIds = [...new Set(cand.map((c) => c.conversation_id))];
  const { data: convs } = await sb.from("conversations").select("id, customer_name, status, is_post_apply, line_source_type, property_customer_id").in("id", convIds);
  const convMap = new Map(((convs ?? []) as Conv[]).map((c) => [c.id, c]));

  let n = 0, aixHit = 0, won = 0, sentDatetime = 0, sentDateOnly = 0, sentAskConv = 0, draftDatetime = 0, draftAsk = 0, drafts = 0, wasUsed = 0, sentApply = 0, draftApply = 0;
  const rows: Array<Record<string, unknown>> = [];
  for (const m of cand.slice(0, limit)) {
    const conv = convMap.get(m.conversation_id);
    if (!conv) continue;
    const t0 = Date.parse(m.created_at);
    const t3 = new Date(t0 + 3 * 3600_000).toISOString();
    const [staffRes, aixRes, exRes, brainRes] = await Promise.all([
      sb.from("messages").select("id, sender, text, created_at, is_aix_generated, image_url").eq("conversation_id", m.conversation_id).gt("created_at", m.created_at).lte("created_at", t3).order("created_at", { ascending: true }).limit(12),
      sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, generated_text").eq("conversation_id", m.conversation_id).gte("created_at", m.created_at).lte("created_at", t3).order("created_at", { ascending: true }),
      sb.from("ai_reply_examples").select("ai_draft, sent_reply, was_ai_used, ai_similarity, aix_action, created_at, reply_context_snapshot").eq("conversation_id", m.conversation_id).gte("created_at", m.created_at).lte("created_at", t3).order("created_at", { ascending: true }).limit(3),
      sb.from("brain_decision_logs").select("suggested_action, suggested_reply_mode, decision_source, scene_evidence, digest, created_at, analyzed_msg_ts").eq("conversation_id", m.conversation_id).eq("analyzed_msg_ts", m.created_at).order("created_at", { ascending: false }).limit(1),
    ]);
    const after = ((staffRes.data ?? []) as Msg[]);
    // 次のお客様発言までのスタッフ送信（＝この発言への返し）
    const staffReplies: Msg[] = [];
    for (const a of after) { if (a.sender === "customer") break; if (a.sender === "staff") staffReplies.push(a); }
    const sentText = staffReplies.map((s) => s.text ?? (s.image_url ? "[画像]" : "")).join("\n---\n");
    const aix = (aixRes.data ?? []) as Array<{ aix_type: string; check_pattern: string | null; created_at: string }>;
    const ex = ((exRes.data ?? []) as Array<Record<string, unknown>>)[0];
    const br = ((brainRes.data ?? []) as Array<Record<string, unknown>>)[0];
    const isWon = !!conv.is_post_apply || WON_STATUSES.has(String(conv.status ?? ""));
    n++;
    if (aix.length) aixHit++;
    if (isWon) won++;
    if (HAS_DATETIME.test(sentText)) sentDatetime++; else if (HAS_DATE_ONLY.test(sentText)) sentDateOnly++;
    if (ASK_CONVENIENT.test(sentText)) sentAskConv++;
    if (APPLY_CTA.test(sentText)) sentApply++;
    const draft = String(ex?.ai_draft ?? "");
    const realDraft = draft && !/^\s*(\[AIX誘導中\]|__SHOWN__|\[返信不要\]|（AI返信の生成に失敗)/.test(draft);
    if (realDraft) { drafts++; if (HAS_DATETIME.test(draft)) draftDatetime++; if (ASK_CONVENIENT.test(draft)) draftAsk++; if (APPLY_CTA.test(draft)) draftApply++; if (ex?.was_ai_used) wasUsed++; }
    const names = [conv.customer_name ?? ""];
    const se = br?.scene_evidence ? (typeof br.scene_evidence === "string" ? JSON.parse(String(br.scene_evidence)) : br.scene_evidence) as Record<string, unknown> : null;
    const snap = ex?.reply_context_snapshot as Record<string, unknown> | null;
    const tp = snap?.turnPair as Record<string, unknown> | null;
    console.log(`#${n} [${jst(m.created_at)}] conv=${m.conversation_id.slice(0, 8)} status=${conv.status}${isWon ? " ★成約側" : ""} src=${conv.line_source_type ?? "-"} pc=${conv.property_customer_id ? "紐付き" : "なし"}`);
    console.log(`  客: ${mask(m.text, names).replace(/\n/g, " / ").slice(0, 140)}`);
    for (const s of staffReplies.slice(0, 3)) console.log(`  店${s.is_aix_generated ? "/AIX" : ""}[${jst(s.created_at)}] (${classifySentKind(s.text)}): ${mask(s.text ?? (s.image_url ? "[画像]" : ""), names).replace(/\n/g, " / ").slice(0, 220)}`);
    if (!staffReplies.length) console.log(`  店: （3時間以内に返信なし）`);
    console.log(`  押したAIX(3h): ${aix.map((a) => `${a.aix_type}${a.check_pattern ? `/${a.check_pattern}` : ""}@${jst(a.created_at)}`).join(", ") || "なし"}`);
    console.log(`  ブレイン: action=${br?.suggested_action ?? "(行なし)"} mode=${br?.suggested_reply_mode ?? "-"} src=${br?.decision_source ?? "-"} scene=${se?.scene ?? "-"} dir=${mask(String((br?.digest as Record<string, unknown> | null)?.dir ?? ""), names).slice(0, 100)}`);
    console.log(`  下書き: ${realDraft ? `そのまま=${ex?.was_ai_used ? "はい" : "いいえ"} 似=${ex?.ai_similarity ?? "-"} aix=${ex?.aix_action ?? "-"} cell=${tp?.ruleId ?? "-"} tier=${JSON.stringify(snap?.tier ?? null)}` : draft ? `印=${draft.slice(0, 20)}` : "（記録なし）"}`);
    if (realDraft) console.log(`      ${mask(draft, names).replace(/\n/g, " / ").slice(0, 220)}`);
    const promises = [...sentText.matchAll(PROMISE_RE)].map((x) => x[0].trim());
    if (promises.length) console.log(`  実送信の宣言: ${promises.map((p) => mask(p, names)).join(" ／ ").slice(0, 200)}`);
    console.log("");
    rows.push({ id: m.id, conv: m.conversation_id, at: m.created_at, status: conv.status, won: isWon, aix: aix.map((a) => a.aix_type), hasDraft: realDraft, used: !!ex?.was_ai_used });
  }
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  console.log(`=== まとめ（${n}件）===`);
  console.log(`  成約側 ${won}（${pct(won, n)}）／ 3時間以内に AIX を押した ${aixHit}（${pct(aixHit, n)}）`);
  console.log(`  実送信: 具体日時あり ${sentDatetime}（${pct(sentDatetime, n)}）／ 日付だけ ${sentDateOnly}／ ご都合を聞く ${sentAskConv}（${pct(sentAskConv, n)}）／ 申込CTA ${sentApply}（${pct(sentApply, n)}）`);
  console.log(`  下書きあり ${drafts}: 具体日時 ${draftDatetime}（${pct(draftDatetime, drafts)}）／ ご都合を聞く ${draftAsk}（${pct(draftAsk, drafts)}）／ 申込CTA ${draftApply}（${pct(draftApply, drafts)}）／ そのまま送信 ${wasUsed}（${pct(wasUsed, drafts)}）`);
  console.log(`\n候補ID一覧（YUMA 再現用）: ${rows.filter((r) => r.hasDraft).map((r) => `${String(r.id)}${r.won ? "★" : ""}`).join(", ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
