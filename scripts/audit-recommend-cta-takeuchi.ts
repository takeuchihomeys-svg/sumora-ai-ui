// scripts/audit-recommend-cta-takeuchi.ts — AIX【物件オススメ】の後の2通目の締め（誘導／ご査収）を、旧（決められない→ご査収）と新（決められない→竹内さんの形）で
//   竹内さんの実送信と比べる（読むだけ・LLM なし・費用0）。2026-10-14 竹内さん「AIX の後の返信を竹内さんの基準に」
//   番 = audit-aix-after-text.ts --json の組（AIX を押した直後にスタッフが打った文）のうち物件オススメ・書き手=竹内さん
//   締めの判定 = recommend-cta.resolveRecommendCta（1通目の頭の物件の採点 property_pickups ＋ お客様の直近の反応）。ブレインの wait は brain_decision_logs では読めないので数えない
// 実行: npx tsx --env-file=.env.local scripts/audit-recommend-cta-takeuchi.ts --in=<audit-aix-after-text の --json> [--writer=takeuchi]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolveRecommendCta, readCustomerReaction, headOfFirstMessage, pickupForFirstMessage, type PickupLookupRow } from "../app/lib/recommend-cta";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const IN = arg("in"); const WRITER = arg("writer", "takeuchi");
const cta = (s: string) => /ご案内させて(?:頂|いただ)きます|抑えさせて(?:頂|いただ)きます/.test(s);
(async () => {
  const pairs = (JSON.parse(readFileSync(IN, "utf8")) as Array<{ aix: string; writer: string; sent: string; conv: string; at: string }>).filter((p) => p.writer === WRITER && p.aix.startsWith("property_recommendation"));
  let n = 0, sentCta = 0, oldCta = 0, newCta = 0, oldAgree = 0, newAgree = 0; const reasons: Record<string, number> = {};
  for (const p of pairs) {
    const { data: pr } = await sb.from("aix_usage_logs").select("generated_text").eq("conversation_id", p.conv).eq("aix_type", "property_recommendation").lte("created_at", p.at).order("created_at", { ascending: false }).limit(1);
    const first = (pr?.[0] as { generated_text?: string } | undefined)?.generated_text ?? "";
    const head = headOfFirstMessage(first);
    const { data: rows } = head ? await sb.from("property_pickups").select("property_name, room_no, verdict, reason_codes, created_at, terms").eq("conversation_id", p.conv).eq("room_no", head.room).order("created_at", { ascending: false }).limit(20) : { data: [] };
    const pickup = pickupForFirstMessage((rows ?? []) as PickupLookupRow[], head);
    const { data: msgs } = await sb.from("messages").select("sender, text, created_at").eq("conversation_id", p.conv).lt("created_at", p.at).order("created_at", { ascending: false }).limit(12);
    const recent = ((msgs ?? []) as Array<{ sender: string; text: string | null; created_at: string }>).reverse().map((m) => ({ sender: m.sender === "customer" ? "customer" : "staff", text: m.text, rawCreatedAt: m.created_at }));
    const reaction = readCustomerReaction(recent);
    const o = resolveRecommendCta({ pickup, reaction, notViewable: false });
    const nw = resolveRecommendCta({ pickup, reaction, notViewable: false, undecided: "cta" });
    const s = cta(p.sent);
    n++; if (s) sentCta++;
    if (o.kind !== "receipt") oldCta++; if (nw.kind !== "receipt") newCta++;
    if ((o.kind !== "receipt") === s) oldAgree++; if ((nw.kind !== "receipt") === s) newAgree++;
    const rk = `${nw.reason.replace(/[（(].*$/, "").slice(0, 30)}｜竹内さん${s ? "誘導" : "なし"}`; reasons[rk] = (reasons[rk] ?? 0) + 1;
  }
  const pc = (a: number) => `${a}/${n}（${Math.round((a / Math.max(1, n)) * 100)}%）`;
  console.log(`# 物件オススメの後の2通目の締め（書き手=${WRITER}・番 ${n}）`);
  console.log(`  竹内さんの実送信で誘導あり ${pc(sentCta)}`);
  console.log(`  旧（決められない→ご査収）: 誘導 ${pc(oldCta)}・竹内さんと一致 ${pc(oldAgree)}`);
  console.log(`  新（決められない→竹内さんの形）: 誘導 ${pc(newCta)}・竹内さんと一致 ${pc(newAgree)}`);
  console.log(`  理由×竹内さん: ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・")}`);
})().catch((e) => { console.error(e); process.exit(1); });
