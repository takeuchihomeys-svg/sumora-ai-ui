// 読むだけ（LLM なし）: 「もっと初期費用を安くできないか」の読み取りの監査（2026-10-08 竹内さん⑥）。
//   その物件に対する「更に安く」の依頼＝代表確認／物件を指さない一般の願い＝安いお部屋を探す形／お客様が新しく送ってきた物件の「安くなりますか」＝見積書。
//   365日のお客様の発言（御見積書の後 14日以内・値下げ・割引の広い語）ごとに、further-discount の判定（今の線）と人の次の一手（送信の本文＋押した AIX）を並べ、
//   足りない読み取り（直前に送った見積書・物件への指し示し・画像の後 等）を目で読んで分類する材料にする。
// 実行: npx tsx --env-file=.env.local scripts/audit-further-discount-reading.ts [--days=365] [--all]
import { createClient } from "@supabase/supabase-js";
import { customerAsksFurtherDiscount, furtherDiscountDaihyo } from "../app/lib/further-discount";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=365").split("=")[1]);
const ALL = process.argv.includes("--all");
const WIDE = /安く|安い|抑え|下げ|値引|割引|値下|まけ|安(?:さ|め)/;
const EST_RE = /御見積書|お見積書|お見積り書|初期費用[:：]\s*[0-9,]+円/;
const CUST_PROP_RE = /https?:\/\/|^\s*\[画像\]/;

type Msg = { sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null };

function humanLabel(staff: string, aix: string[]): string {
  if (aix.includes("acknowledge_check") || /代表|申請|最安|これ以上(?:の)?(?:値引|割引|お安|安く)|限界|上限|交渉/.test(staff)) return "人=代表・最安の答え";
  if (aix.includes("estimate_sheet") || /(?:御見積書|お見積書|見積)[^\n。]{0,12}(?:お送り|作成)|募集状況/.test(staff)) return "人=見積書・物件確認";
  if (aix.some((a) => /property_(?:send|recommendation)/.test(a)) || /ピックアップ|お探し|探させ|抑えられるお部屋|安いお部屋/.test(staff)) return "人=お部屋を探す";
  return "人=その他";
}

(async () => {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const cust: Array<Msg & { conversation_id: string }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db.from("messages").select("conversation_id, created_at, text, sender").eq("sender", "customer").gte("created_at", since)
      .or("text.ilike.%安く%,text.ilike.%安い%,text.ilike.%抑え%,text.ilike.%下げ%,text.ilike.%値引%,text.ilike.%割引%,text.ilike.%値下%,text.ilike.%まけ%")
      .order("created_at").range(off, off + 999);
    if (error) throw error;
    cust.push(...((data ?? []) as never[])); if (!data || data.length < 1000) break;
  }
  const changed: string[] = []; const rows: string[] = []; const tally: Record<string, number> = {};
  for (const m of cust) {
    if (m.conversation_id === YUMA_CONVERSATION_ID) continue;
    if (!WIDE.test(m.text ?? "") || /^\s*\[/.test(m.text ?? "")) continue;
    const atMs = Date.parse(m.created_at);
    const { data: prev } = await db.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", m.conversation_id)
      .lt("created_at", m.created_at).gte("created_at", new Date(atMs - 14 * 86400000).toISOString()).order("created_at");
    const prevs = (prev ?? []) as Msg[];
    const estMsgs = prevs.filter((p) => p.sender !== "customer" && EST_RE.test(p.text ?? ""));
    if (!estMsgs.length) continue;
    const lastEstAt = Date.parse(estMsgs[estMsgs.length - 1].created_at);
    const custPropAfterEst = prevs.some((p) => p.sender === "customer" && Date.parse(p.created_at) > lastEstAt && CUST_PROP_RE.test(p.text ?? ""));
    const lastSender = prevs.at(-1)?.sender ?? "-";
    const { data: nx } = await db.from("messages").select("sender, text, created_at").eq("conversation_id", m.conversation_id).gt("created_at", m.created_at).order("created_at").limit(4);
    const staff = ((nx ?? []) as Msg[]).filter((x) => x.sender === "staff").slice(0, 2);
    const st = staff.map((x) => String(x.text)).join(" ⏎⏎ ");
    const { data: ax } = await db.from("aix_usage_logs").select("aix_type, picker_choices, created_at").eq("conversation_id", m.conversation_id)
      .gt("created_at", m.created_at).lt("created_at", new Date(atMs + 2 * 86400000).toISOString()).order("created_at").limit(3);
    const aix = ((ax ?? []) as Array<{ aix_type: string }>).map((a) => a.aix_type);
    const human = humanLabel(st, aix);
    const asks = customerAsksFurtherDiscount(m.text);
    const recent = [...prevs, { sender: "customer", text: m.text, created_at: m.created_at }];
    const v = furtherDiscountDaihyo({ turnText: m.text, estimateSent: true, postApply: false, recent }) ? "代表確認" : asks ? "外す(物件)" : "外す";
    // 旧の線（10/08 の直しの前）: 広い言い方なし・持ち込みの読み取りなし
    process.env.FURTHER_DISCOUNT_ASK_WIDE = "off";
    const old = furtherDiscountDaihyo({ turnText: m.text, estimateSent: true, postApply: false, env: { FURTHER_DISCOUNT_NEW_PROPERTY: "off" } }) ? "代表確認" : "外す";
    delete process.env.FURTHER_DISCOUNT_ASK_WIDE;
    if ((old === "代表確認") !== (v === "代表確認")) changed.push(`${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} 旧=${old} → 新=${v} [${human}]\n   客: ${String(m.text).replace(/\n/g, " ⏎ ").slice(0, 140)}\n   人: ${st.replace(/\n/g, " ⏎ ").slice(0, 160)}`);
    const k = `${v}|${human}`; tally[k] = (tally[k] ?? 0) + 1;
    const interesting = ALL || (v === "代表確認") !== (human === "人=代表・最安の答え");
    if (interesting) rows.push(`${m.created_at.slice(0, 10)} ${m.conversation_id.slice(0, 8)} [${v}] [${human}] 見積後の持ち込み=${custPropAfterEst ? "あり" : "なし"} 直前=${lastSender} AIX=${aix.join(",") || "-"}\n   客: ${String(m.text).replace(/\n/g, " ⏎ ").slice(0, 160)}\n   人: ${st.replace(/\n/g, " ⏎ ").slice(0, 200)}`);
  }
  console.log(rows.join("\n"));
  console.log(`\n=== 旧の線から変わった番 ${changed.length} ===\n${changed.join("\n")}`);
  console.log("\n集計（判定|人）", tally);
})();
