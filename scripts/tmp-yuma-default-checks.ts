// tmp: 売上サポの既定のチェック（defaultAixChecks）が送付済みの部屋を外すか（YUMA・読むだけ）
import { defaultAixChecks, sentBeforeIds } from "../app/lib/pickup-review-order";
async function main() {
  const j = await (await fetch("https://sumora-ai-ui.vercel.app/api/property-pickups?view=detail&pcid=509cd061-60cc-49a9-8c5a-4f356c4a5f88&batches=30")).json() as { customer: Record<string, any> };
  const c = j.customer;
  const rounds = (c.batches as any[]).map((b) => ({ items: b.items, created_at: b.created_at }));
  const checks = defaultAixChecks(rounds as any, c.best?.id ?? null, 10, { firstProposalSentAt: c.first_proposal_sent_at, sentHistory: c.sent_history });
  const all = rounds.flatMap((r) => r.items) as any[];
  const before = sentBeforeIds(all as any, c.sent_history);
  console.log("sent_history", c.sent_history.length, "best", c.best?.id);
  for (const it of all.filter((x) => x.status === "pending")) console.log(it.id, it.site, it.property_name, it.room_no, it.verdict, it.score, checks[it.id] ? "☑" : "・", before.has(it.id) ? "送付済み" : "");
}
main();
