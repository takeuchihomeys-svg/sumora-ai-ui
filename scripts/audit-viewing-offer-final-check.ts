// 読むだけ（LLM なし）: 最終チェックの決定論（PHOTO_NO_PREMISE／PHOTO_REPLACES_VIEWING）を、人の実送信で「撮影・オンライン内見」を含む通に当て、
//   final-check-viewing-offer の直しの前（FINAL_CHECK_VIEWING_OFFER=off）と後で何通に指摘が付くかを数える（2026-10-08 竹内さん①）。
//   人の実送信は正しい文＝指摘が付く通は「誤って落とす」通。後で増えた通（＝直しで新しく止める通）が無い事・減った通が全部 申し出の文 である事を目で読む。
//   LLM の指摘の外し（isViewingOfferFlag）は、引用＝申し出の文として同じ通に当てて、外れる通を並べる（来られない事情が無い通は外さない事を確かめる）。
// 実行: npx tsx --env-file=.env.local scripts/audit-viewing-offer-final-check.ts [--days=365]
import { createClient } from "@supabase/supabase-js";
import { runVocabSemanticChecks, type FinalCheckContext } from "../app/lib/final-check";
import { isViewingOfferFlag, isViewingOfferSentence, customerCannotCome } from "../app/lib/final-check-viewing-offer";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=365").split("=")[1]);
type Msg = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null };
const PHOTO_CODES = new Set(["PHOTO_NO_PREMISE", "PHOTO_REPLACES_VIEWING"]);

(async () => {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const sent: Array<Msg & { conversation_id: string; staff_writer?: string | null }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db.from("messages").select("conversation_id, created_at, text, sender, is_aix_generated, staff_writer").eq("sender", "staff").gte("created_at", since)
      .or("text.ilike.%撮影%,text.ilike.%オンライン内%").order("created_at").range(off, off + 999);
    if (error) throw error;
    sent.push(...((data ?? []) as never[])); if (!data || data.length < 1000) break;
  }
  let n = 0, before = 0, after = 0, offerN = 0, llmDrop = 0;
  const changed: string[] = [], stillFlagged: string[] = [], llmRows: string[] = [];
  for (const m of sent) {
    if (m.conversation_id === YUMA_CONVERSATION_ID || m.is_aix_generated) continue;
    const text = String(m.text ?? "");
    if (!/撮影|オンライン内/.test(text)) continue;
    const { data: prev } = await db.from("messages").select("sender, text, created_at").eq("conversation_id", m.conversation_id)
      .lt("created_at", m.created_at).order("created_at", { ascending: false }).limit(12);
    const recent = ((prev ?? []) as Msg[]).reverse();
    const lastCust = [...recent].reverse().find((x) => x.sender === "customer")?.text ?? "";
    const ctx: FinalCheckContext = { lastCustomerMessage: lastCust, recentMessages: recent.map((x) => ({ sender: x.sender === "staff" ? "staff" : "customer", text: x.text ?? "" })), customerName: "〇〇" };
    n++;
    process.env.FINAL_CHECK_VIEWING_OFFER = "off";
    const b = runVocabSemanticChecks(text, ctx).filter((i) => PHOTO_CODES.has(i.code));
    delete process.env.FINAL_CHECK_VIEWING_OFFER;
    const a = runVocabSemanticChecks(text, ctx).filter((i) => PHOTO_CODES.has(i.code));
    if (b.length) before++;
    if (a.length) after++;
    const head = `${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} ${m.staff_writer ?? "-"}`;
    const custs = recent.filter((x) => x.sender === "customer").slice(-4).map((x) => x.text ?? "").join("\n");
    const line = `${head}\n   客: ${custs.replace(/\n/g, " ⏎ ").slice(-160)}\n   人: ${text.replace(/\n/g, " ⏎ ").slice(0, 200)}`;
    if (b.length !== a.length) changed.push(`[${b.map((i) => i.code).join(",")} → ${a.map((i) => i.code).join(",") || "なし"}] ${line}`);
    else if (a.length) stillFlagged.push(`[${a.map((i) => i.code).join(",")}] ${line}`);
    // LLM の外し: 本文の申し出の文を引用に見立てる
    const offers = (text.match(/[^。！!？?\n]+[。！!？?😊😌]*/g) ?? []).filter(isViewingOfferSentence);
    if (offers.length) offerN++;
    for (const s of offers) {
      if (isViewingOfferFlag("AIX_BOUNDARY_PROMISE", s, text, [lastCust, ...recent.filter((x) => x.sender === "customer").map((x) => x.text ?? "")].join("\n"))) {
        llmDrop++; llmRows.push(`${head} 来られない事情=${customerCannotCome(custs) ? "あり" : "なし"}\n   客: ${custs.replace(/\n/g, " ⏎ ").slice(-140)}\n   申し出: ${s}`); break;
      }
    }
  }
  console.log(`人の実送信（撮影・オンライン内見を含む・AIX 除く）${n}通 ／ 決定論の PHOTO_* が付く通: 前 ${before} → 後 ${after} ／ 申し出の文がある通 ${offerN}`);
  console.log(`\n=== 前と後で変わった通 ${changed.length}（増えた通が無い事・減った通が申し出である事を読む） ===\n${changed.join("\n")}`);
  console.log(`\n=== 後も PHOTO_* が付く通 ${stillFlagged.length}（人の文に付く＝この直しの外の誤り候補・報告用） ===\n${stillFlagged.join("\n")}`);
  console.log(`\n=== LLM の指摘を外す通（申し出の文を引用に見立てて）${llmDrop} ===\n${llmRows.join("\n")}`);
})();
