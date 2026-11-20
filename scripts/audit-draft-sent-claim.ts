// scripts/audit-draft-sent-claim.ts — AI の返信の下書きが「送った体の文」（ピックアップ／お送りさせて頂きました・ご査収ください）を書いたのに、
//   その番でこちらが物件・見積を送っていない（AIX の送付も資料の画像も無い）番を数える（読むだけ・LLM なし・DB に書かない）
//
// 2026-11-21 作業員K2（統括役: 竹内さんの「同じ事を何度も言う」の調べから見つかった重い外れ。お客様に事実と違う事を言う）。
//   見つけた実物: d88bc551 10/22・36bb96d9 10/29・5f0befb7 10/26 ＝ 約束の後にお客様が「かしこまりました／お願いします」だけの番で、
//   AI の下書きは物件を送らずに「〜ピックアップさせて頂きました・ご査収ください」。竹内さんは AIX【ピックアップ】で送って果たした。
//   今の守り（final-check の PROMISE_ECHO_MISMATCH）は「会話で物件を1件も送っていない」時だけ・warning＝前に別の束を送った会話では当たらない。
//   数える物: ai_reply_examples（AI の下書きとスタッフが送った文）。その番（お客様の発言の後〜次のお客様の発言まで）にこちらの AIX の送付か画像があったか。
//   出力: 下書きに送った体の文がある番・そのうち資料の実体（🌟・号室・見積書・URL）が下書きに無い番・その番の実際（AIX で送った／画像を送った／送らなかった）
//     ・スタッフが送った文に同じ形が残ったか。--show で伏せた抜き出し。
// 実行（夜の軽い読み）: npx tsx --env-file=<鍵のある .env> scripts/audit-draft-sent-claim.ts [--days=30] [--show=0]
import { createClient } from "@supabase/supabase-js";
import { COMPLETED_SEND_RE, ATTACHED_DELIVERABLE_RE } from "../app/lib/action-ledger";
import { isTestConversation } from "../app/lib/test-conversations";
import { maskPII } from "../app/lib/pii-mask";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const DAYS = Number(arg("days", "30"));
const SHOW = Number(arg("show", "0"));

(async () => {
  const since = new Date(Date.now() - DAYS * 86400e3).toISOString();
  const ex: Array<{ conversation_id: string; sent_at: string; ai_draft: string; sent_reply: string }> = [];
  for (let f = 0; ; f += 1000) {
    const { data, error } = await sb.from("ai_reply_examples").select("conversation_id, sent_at, ai_draft, sent_reply").gte("sent_at", since).not("ai_draft", "is", null).order("sent_at").range(f, f + 999);
    if (error) throw new Error(error.message);
    ex.push(...((data ?? []) as typeof ex)); if ((data ?? []).length < 1000) break;
  }
  const hits = ex.filter((e) => !isTestConversation(e.conversation_id) && COMPLETED_SEND_RE.test(e.ai_draft ?? "") && !ATTACHED_DELIVERABLE_RE.test(e.ai_draft ?? ""));
  const tally: Record<string, number> = {}; const shows: string[] = [];
  for (const e of hits) {
    // その番: 送った文の前の最後のお客様の発言〜次のお客様の発言
    const t = Date.parse(e.sent_at);
    const { data: before } = await sb.from("messages").select("created_at").eq("conversation_id", e.conversation_id).eq("sender", "customer").lte("created_at", new Date(t).toISOString()).order("created_at", { ascending: false }).limit(1);
    const from = (before?.[0] as { created_at?: string } | undefined)?.created_at ?? new Date(t - 3600e3).toISOString();
    const { data: after } = await sb.from("messages").select("sender, text, image_url, is_aix_generated, created_at").eq("conversation_id", e.conversation_id).gt("created_at", from).order("created_at").limit(30);
    const ms = (after ?? []) as Array<{ sender: string; text: string | null; image_url: string | null; is_aix_generated: boolean | null }>;
    const ci = ms.findIndex((m) => m.sender === "customer"); const blk = ci >= 0 ? ms.slice(0, ci) : ms;
    const aixSent = blk.some((m) => m.is_aix_generated && (m.image_url || ATTACHED_DELIVERABLE_RE.test(m.text ?? "")));
    const imgSent = blk.some((m) => !m.is_aix_generated && m.image_url);
    const actual = aixSent ? "AIX で送った" : imgSent ? "手で画像を送った" : "送っていない";
    const sentKeeps = COMPLETED_SEND_RE.test(e.sent_reply ?? "") && !ATTACHED_DELIVERABLE_RE.test(e.sent_reply ?? "");
    const k = `${actual}｜送った文にも送った体の文=${sentKeeps ? "残った" : "消した"}`;
    tally[k] = (tally[k] ?? 0) + 1;
    if (shows.length < SHOW && !aixSent && !imgSent) shows.push(`${e.conversation_id.slice(0, 8)} ${e.sent_at.slice(0, 16)}｜下書き: ${maskPII(e.ai_draft).replace(/\s+/g, " ").slice(0, 90)}｜送った: ${maskPII(e.sent_reply ?? "").replace(/\s+/g, " ").slice(0, 70)}`);
  }
  console.log(`=== ${DAYS}日・AI の下書き ${ex.length}・送った体の文があり資料の実体が無い下書き ${hits.length}`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  for (const s of shows) console.log(s.replace(/[A-Za-z0-9_-]+さん|[^\s！!、。｜]{1,6}さん/g, "〇〇さん"));
})().catch((e) => { console.error(e); process.exit(1); });
