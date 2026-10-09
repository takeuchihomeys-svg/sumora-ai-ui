// 読むだけ（LLM なし）: 「刺さっているか」の線を実データで決める（2026-10-08 竹内さん④）。
//   お客様が「すぐ来られない」（今週は無理・予定が詰まって・出張・しばらく・〇日以降・遠方）と言った番で、人が
//     抑える提案（お申込みでお部屋を抑えた状態で…）／撮影・オンライン内見／内覧調整（AIX 内覧調整・ご都合よろしいお日にち）
//   のどれをしたかと、その物件の採点（property_pickups・recommend-cta.appealFromPickup）・お客様の反応（property-appeal-fit の信号）・申込到達（deal_outcomes.applied_at）を並べる。
//   ※ 物件オススメ（🌟）を送った後の番だけ（物件が決まらないと刺さりは測れない）。
// 実行: npx tsx --env-file=.env.local scripts/audit-appeal-fit-hold.ts [--days=365] [--rows] [--any-turn]
//   --any-turn: すぐ来られない番に限らず、🌟の後のお客様の番すべて（抑える提案をした番 vs 内覧の誘い・調整の番の比べ）
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { appealFromPickup, headOfFirstMessage, pickupForFirstMessage, type PickupLookupRow } from "../app/lib/recommend-cta";
import { APPLY_APPEAL_RE } from "../app/lib/appeal-timing";
import { extractCircumstances } from "../app/lib/customer-circumstances";
import { readAppealReaction, resolvePropertyAppealFit } from "../app/lib/property-appeal-fit";
import { YUMA_CONVERSATION_ID } from "../app/lib/test-conversations";

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!);
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=365").split("=")[1]);
const ROWS = process.argv.includes("--rows");
const ANY = process.argv.includes("--any-turn");
type Msg = { id?: string; sender: string; text: string | null; created_at: string; is_aix_generated?: boolean | null; staff_writer?: string | null };
const SOON_WIDE = /今週|予定|出張|しばらく|当分|以降|以後|遠方|在住|住んで|行けな|伺え|来れな|来られな|忙し/;

function staffAction(staff: string, aix: string[]): string {
  if (aix.includes("application_push") || APPLY_APPEAL_RE.test(staff)) return "抑える提案";
  if (/撮影|オンライン内/.test(staff)) return "撮影・オンライン内見";
  if (aix.includes("viewing_invite") || aix.includes("meeting_place") || /ご都合(?:の)?よろしいお日にち|ご案内させて|ご内覧頂け|[0-9]{1,2}[\/／月][0-9]{1,2}[^\n]{0,8}(?:ご案内|空いて|いかが)/.test(staff)) return "内覧調整";
  return "その他";
}

(async () => {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  // 🌟を送った会話（365日）
  const stars: Array<Msg & { conversation_id: string }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await db.from("messages").select("conversation_id, created_at, text, sender").eq("sender", "staff").gte("created_at", since).like("text", "%🌟%").order("created_at").range(off, off + 999);
    if (error) throw error;
    stars.push(...((data ?? []) as never[])); if (!data || data.length < 1000) break;
  }
  const convs = [...new Set(stars.map((s) => s.conversation_id))].filter((c) => c !== YUMA_CONVERSATION_ID);
  console.error(`🌟のある会話 ${convs.length}`);
  const out: Array<Record<string, unknown>> = [];
  let k = 0;
  for (const cid of convs) {
    if (++k % 50 === 0) console.error(`  ${k}/${convs.length}`);
    const { data: msgsRaw } = await db.from("messages").select("sender, text, created_at, is_aix_generated, staff_writer").eq("conversation_id", cid).gte("created_at", since).order("created_at").limit(3000);
    const msgs = (msgsRaw ?? []) as Msg[];
    const { data: picks } = await db.from("property_pickups").select("property_name, room_no, verdict, reason_codes, created_at").eq("conversation_id", cid).limit(500);
    const { data: aixRaw } = await db.from("aix_usage_logs").select("aix_type, created_at").eq("conversation_id", cid).order("created_at");
    const { data: deals } = await db.from("deal_outcomes").select("applied_at, applied_at_estimated, episode_no").eq("conversation_id", cid);
    const applied = ((deals ?? []) as Array<{ applied_at: string | null }>).map((d) => d.applied_at).filter((x): x is string => !!x).map(Date.parse);
    // お客様の「番」（連投をまとめる）: 次のスタッフの発言の直前まで
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.sender !== "customer") continue;
      if (i + 1 < msgs.length && msgs[i + 1].sender === "customer") continue; // 番の最後の通で見る
      let j = i; while (j - 1 >= 0 && msgs[j - 1].sender === "customer") j--;
      const turn = msgs.slice(j, i + 1);
      const turnText = turn.map((x) => x.text ?? "").join("\n");
      const atMs = Date.parse(m.created_at);
      // 申込以降は見ない
      if (applied.some((a) => a <= atMs)) continue;
      const before = msgs.slice(0, j);
      const starIdx = [...before.keys()].reverse().find((x) => before[x].sender === "staff" && /🌟/.test(before[x].text ?? ""));
      if (starIdx == null) continue;
      const star = before[starIdx];
      if (atMs - Date.parse(star.created_at) > 14 * 86400000) continue;
      let soonKind: string | null = null;
      if (SOON_WIDE.test(turnText)) {
        const cs = extractCircumstances(turn.map((x) => ({ text: x.text, createdAt: x.created_at })), Date.parse(turn[0].created_at));
        const c = cs.find((x) => x.kind === "cannot_come_soon" || x.kind === "available_from" || x.kind === "remote");
        if (c) soonKind = c.kind === "available_from" && c.fromDayMs != null ? `from+${Math.round((c.fromDayMs - atMs) / 86400000)}d` : c.kind;
        else if (/今週は?[^。\n]{0,6}(?:無理|難し|厳し|行けな)/.test(turnText)) soonKind = "this_week";
      }
      if (!ANY && !soonKind) continue;
      const after = msgs.slice(i + 1, i + 6);
      const staffMsgs = after.filter((x) => x.sender === "staff").slice(0, 3);
      if (!staffMsgs.length) continue;
      const staffText = staffMsgs.map((x) => x.text ?? "").join("\n");
      const aix = ((aixRaw ?? []) as Array<{ aix_type: string; created_at: string }>).filter((a) => Date.parse(a.created_at) > atMs && Date.parse(a.created_at) < atMs + 2 * 86400000).map((a) => a.aix_type);
      const action = staffAction(staffText, aix);
      const head = headOfFirstMessage(star.text);
      const pick = pickupForFirstMessage((picks ?? []) as PickupLookupRow[], head);
      const fit = appealFromPickup(pick);
      const custAfterStar = msgs.slice(starIdx + 1, i + 1).filter((x) => x.sender === "customer").map((x) => ({ text: x.text, createdAt: x.created_at }));
      const reaction = readAppealReaction(custAfterStar, { sentAt: star.created_at });
      const verdict = resolvePropertyAppealFit({ pickup: pick, reaction });
      const reached = applied.some((a) => a > atMs && a <= atMs + 30 * 86400000);
      out.push({ cid: cid.slice(0, 8), at: m.created_at.slice(0, 16), soonKind, action, writer: staffMsgs[0].staff_writer ?? "-", fit: fit?.appeal ?? null, fitWhy: fit?.why ?? null, reaction, level: verdict.level, why: verdict.why, reached,
        turn: turnText.replace(/\n/g, " ⏎ ").slice(0, 140), staff: staffText.replace(/\n/g, " ⏎ ").slice(0, 160), star: head ? `${head.name} ${head.room}` : null });
    }
  }
  writeFileSync(`scripts/.replay-out/appeal-fit-hold${ANY ? "-any" : ""}.json`, JSON.stringify(out, null, 0));
  // 集計
  const tab = (key: (r: Record<string, unknown>) => string) => {
    const t: Record<string, Record<string, [number, number]>> = {};
    for (const r of out) { const a = String(r.action); const kk = key(r); ((t[kk] ??= {})[a] ??= [0, 0]); t[kk][a][0]++; if (r.reached) t[kk][a][1]++; }
    for (const [kk, v] of Object.entries(t).sort()) console.log(`  ${kk.padEnd(28)} ${Object.entries(v).map(([a, [n, r]]) => `${a}=${n}(申込${r})`).join("  ")}`);
  };
  console.log(`\n番 ${out.length}（${ANY ? "🌟の後の全部" : "すぐ来られない"}）・申込到達（30日）${out.filter((r) => r.reached).length}`);
  console.log("\n■ 採点の刺さり × 人の一手（件数・申込到達）"); tab((r) => `採点=${r.fit ?? "なし"}`);
  console.log("\n■ 反応の点 × 人の一手"); tab((r) => `反応点=${(r.reaction as { points: number }).points}`);
  console.log("\n■ 判定（property-appeal-fit）× 人の一手"); tab((r) => `判定=${r.level}`);
  console.log("\n■ 来られない型 × 人の一手"); tab((r) => `型=${String(r.soonKind ?? "-").replace(/from\+\d+d/, (s) => (Number(s.slice(5, -1)) >= 7 ? "from7+" : "from<7"))}`);
  if (ROWS) for (const r of out) console.log(`\n${r.at} ${r.cid} [${r.soonKind}] 人=${r.action}(${r.writer}) 採点=${r.fit ?? "なし"} 反応=${JSON.stringify(r.reaction)} 判定=${r.level} 申込=${r.reached ? "○" : "-"} 🌟${r.star}\n   客: ${r.turn}\n   人: ${r.staff}`);
})();
