// scripts/audit-promise-ack-path.ts — 3巡目（10/07）: こちらの約束の後のお客様のお礼・了承の番で、約束の AIX（promise:*）が立つかを本番の材料で当て直す（読むだけ・LLM なし）
//   道の違い（ブレイン＝返信の下書き／スタッフ＝何も打たずに後で AIX で約束を果たす）の出所を、brain-core と同じ純関数で1番ずつ再現する。
//   入力: scripts/audit-path-gap-by-scene.ts --out の jsonl（場面 ack/considering・ブレイン=reply・スタッフ=AIX の番）
// 実行: npx tsx --env-file=.env.local scripts/audit-promise-ack-path.ts <path-gap.jsonl> [--all]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { buildActionLedger } from "../app/lib/action-ledger";
import { resolveStaffPromiseAix } from "../app/lib/aix-task-link";
import { customerRequestedPropertyCheck } from "../app/lib/aix-scene-evidence";
import { unrepliedCustomerTurn } from "../app/lib/brain-aix-feedback";
import { analyzeSubstance, CUST_WILL_SEND_SELF_PRED } from "../app/lib/reply-context";
import { customerPointsAtProperty } from "../app/lib/cost-question-scope";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "");
type R = { conv: string; at: string; scene: string; brain: string; src: string | null; staff: string[]; agree: boolean; customer: string; staffText: string };
const file = process.argv[2];
const ALL = process.argv.includes("--all");
const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as R)
  .filter((r) => ALL ? ["ack", "considering"].includes(r.scene) : (["ack", "considering"].includes(r.scene) && r.brain === "reply" && r.staff[0] !== "reply"));

(async () => {
  const tally = new Map<string, number>();
  for (const r of rows) {
    const { data: m } = await sb.from("messages").select("sender, text, created_at, line_message_id, is_aix_generated").eq("conversation_id", r.conv).lte("created_at", r.at).order("created_at", { ascending: false }).limit(15);
    const typed = (m ?? []) as Array<{ sender: string; text: string | null; created_at: string; line_message_id: string | null; is_aix_generated: boolean | null }>;
    const { data: a } = await sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, line_message_id, property_names, estimate_sent, template_name, prop_statuses, generated_text").eq("conversation_id", r.conv).lte("created_at", r.at).order("created_at", { ascending: false }).limit(20);
    const { data: f } = await sb.from("sent_facts").select("*").eq("conversation_id", r.conv).lte("sent_at", r.at).order("sent_at", { ascending: false }).limit(50);
    const ledger = buildActionLedger({
      recentAixRows: ((a ?? []) as Array<Record<string, unknown>>).map((l) => ({ ...l })) as never,
      messages: [...typed].reverse().map((x) => ({ sender: x.sender, text: x.text ?? "", createdAt: x.created_at, isAix: !!x.is_aix_generated, lineMessageId: x.line_message_id })),
      lineTasks: [], lastCustomerAt: typed.find((x) => x.sender === "customer")?.created_at ?? null, recordedFacts: (f ?? []) as never, now: Date.parse(r.at) + 60_000,
    });
    const un = unrepliedCustomerTurn(typed as never);
    const oldest = [...typed].reverse();
    const lastIsCustomer = oldest[oldest.length - 1]?.sender === "customer";
    const sub = analyzeSubstance(un.text, [un.text]);
    const ackAfter = lastIsCustomer && !un.hasImage && !!un.text.trim() && sub.isAckOnly;
    const lastStaffIdx = oldest.map((x) => x.sender).lastIndexOf("staff");
    const basis = ackAfter && lastStaffIdx >= 0 ? oldest.slice(0, lastStaffIdx + 1) : oldest;
    const p = resolveStaffPromiseAix(ledger.facts, oldest, {
      customerRequestedCheck: customerRequestedPropertyCheck({ recentMessages: basis.map((x) => ({ sender: x.sender, text: x.text })), sentPropertyCount: ledger.facts.propertiesSentCount }),
      customerWillSend: false, customerAckAfter: ackAfter,
      propertyInPlay: ledger.facts.propertiesSentCount > 0 || ledger.facts.estimateSent || oldest.some((x) => x.sender === "customer" && customerPointsAtProperty(x.text ?? "")),
    });
    const e = ledger.facts.lastStaffEntry;
    const why = p ? `promise:${p.kind}→${p.action}` : !ackAfter ? `了承と読まない(${sub.evidence.slice(0, 2).join(",")})` : !e ? "直前のこちらの行なし" : e.status !== "promised" ? `直前のこちらの行=${e.kind}/${e.status}` : "約束の形が対象外";
    const key = why.replace(/\(.*\)/, "");
    tally.set(key, (tally.get(key) ?? 0) + 1);
    const lastStaff = [...oldest].reverse().find((x) => x.sender === "staff")?.text ?? "";
    console.log(`${r.conv.slice(0, 8)} ${r.at.slice(5, 16)} [${r.scene}] 人=${r.staff.join(",")}｜${why}\n  客: ${r.customer.replace(/\n/g, " / ").slice(0, 80)}\n  前のこちら: ${lastStaff.replace(/\n/g, " / ").slice(0, 120)}\n  台帳: ${e ? `${e.kind}/${e.status}` : "-"}`);
  }
  console.log(`\n=== ${rows.length}番: ${[...tally].map(([k, v]) => `${k} ${v}`).join("・")}`);
})().catch((e) => { console.error(e); process.exit(1); });
