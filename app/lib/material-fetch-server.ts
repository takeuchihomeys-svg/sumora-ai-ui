// app/lib/material-fetch-server.ts — 足りない事実を取りに行く（S4）の読み（サーバー・LLM なし・1番に読む表は最大3つ・各1回）
//   2026-11-13 作業員1。表と判定は material-fetch.ts（純関数）。読めない時は取れなかった扱い（スタッフだけの印）で止めない
import { matchCompanyFacts } from "./company-facts";
import { materialFetchPlan, pickDocLines, type FetchResult } from "./material-fetch";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sb = { from: (table: string) => any };
const linesOf = (r: { image_lines?: unknown; equipment?: unknown; terms?: unknown }): string[] => {
  const out: string[] = [];
  const push = (v: unknown) => { if (typeof v === "string" && v.trim()) out.push(v.trim()); else if (Array.isArray(v)) v.forEach(push); else if (v && typeof v === "object") Object.entries(v as Record<string, unknown>).forEach(([k, x]) => { if (typeof x === "string" || typeof x === "number") out.push(`${k}: ${x}`); else push(x); }); };
  push(r.image_lines); push(r.equipment); push(r.terms);
  return out.slice(0, 200);
};

export async function fetchMissingMaterial(sb: Sb, conversationId: string, labels: ReadonlyArray<string>, o: { lastPropertiesSentAt?: string | null } = {}): Promise<FetchResult[]> {
  const plan = materialFetchPlan(labels);
  if (!plan.length) return [];
  const need = new Set(plan.map((p) => p.source).filter(Boolean));
  let docRows: Array<{ property_name: string | null; room_no: string | null; lines: string[] }> = [];
  let fresh: string[] = [];
  let estimateText: string | null = null;
  try {
    if (need.has("property_doc") || need.has("pickup_ready")) {
      const { data } = await sb.from("property_pickups").select("property_name, room_no, summary_text, image_lines, equipment, terms, sent_at, expired_at, created_at").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(40);
      const rows = (data ?? []) as Array<{ property_name: string | null; room_no: string | null; summary_text: string | null; image_lines?: unknown; equipment?: unknown; terms?: unknown; sent_at: string | null; expired_at: string | null; created_at: string }>;
      docRows = rows.map((r) => ({ property_name: r.property_name, room_no: r.room_no, lines: linesOf(r) }));
      const since = o.lastPropertiesSentAt ? Date.parse(o.lastPropertiesSentAt) : 0;
      fresh = rows.filter((r) => !r.sent_at && !r.expired_at && Date.parse(r.created_at) > since).slice(0, 3)
        .map((r) => `${r.property_name ?? "物件"}${r.room_no ? ` ${r.room_no}` : ""}${r.summary_text ? `（${r.summary_text.replace(/\s+/g, " ").slice(0, 60)}）` : ""}`);
    }
    if (need.has("estimate_sheet")) {
      const { data } = await sb.from("aix_usage_logs").select("generated_text, created_at").eq("conversation_id", conversationId).eq("aix_type", "estimate_sheet").not("sent_at", "is", null).order("created_at", { ascending: false }).limit(1);
      estimateText = (((data ?? [])[0] as { generated_text?: string | null } | undefined)?.generated_text ?? null);
    }
  } catch { /* 読めない時は取れなかった扱い */ }
  return plan.map((p) => {
    if (!p.source) return { label: p.label, source: null, facts: [] };
    if (p.source === "property_doc") return { label: p.label, source: p.source, facts: pickDocLines(docRows, p) };
    if (p.source === "pickup_ready") return { label: p.label, source: p.source, facts: fresh };
    if (p.source === "estimate_sheet") return { label: p.label, source: p.source, facts: estimateText ? [estimateText.replace(/\s+/g, " ").slice(0, 200)] : [] };
    return { label: p.label, source: p.source, facts: matchCompanyFacts(p.label).slice(0, 2).map((f) => f.fact.replace(/\*\*/g, "").slice(0, 200)) };
  });
}
