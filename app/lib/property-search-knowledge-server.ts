// app/lib/property-search-knowledge-server.ts（サーバー専用・DB）
// 物件検索の整理済みの知識（property_search_knowledge）を作る（決定論・LLM なし）・読む（ブレイン・resolve-area）。
// 組み立ての純関数は property-search-knowledge.ts。作り直しは scripts/build-property-search-knowledge.ts（既定は dry）。
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseAreaWant } from "./area-want";
import { transit } from "./transit-route";
import { buildDeliveredKnowledge, buildRestatementKnowledge, readable, deliveredLine, keyLabel, stationKey, wardKey, KNOWLEDGE_RULE, type KnowledgeRow, type DeliveredPayload, type RestatementPayload } from "./property-search-knowledge";

const BRANCH = "osaka";
const YUMA_CONVERSATION_ID = "dd34f5b0-03bf-4dfb-a598-a4d18ebb8df7";

/** 建物名＋号室の鍵（DB の rent_unit_key と同じ） */
export function unitKey(name: string | null | undefined, room: string | null | undefined): string {
  return String(name ?? "").normalize("NFKC").replace(/[\s・･()（）「」\[\]【】]/g, "").toLowerCase() + "#" + String(room ?? "").normalize("NFKC").replace(/[^0-9A-Za-z]/g, "");
}

/** お客様の希望の鍵（希望の駅のまとまり・区・出やすい／1本の基準の駅）と、希望の駅のまとまりの駅 */
export function desiredKeys(desiredArea: string | null | undefined, freeText?: string | null): { keys: string[]; own: string[] } {
  const want = parseAreaWant(desiredArea, freeText);
  const t = transit();
  const keys = new Set<string>();
  const own = new Set<string>();
  for (const s of want.stations) {
    const g = t.groupOf(s.station);
    keys.add(stationKey(g?.key ?? s.station));
    for (const m of g?.members ?? [s.station]) own.add(m);
  }
  for (const a of want.anchors) { keys.add(stationKey(a.station)); for (const m of t.groupOf(a.station)?.members ?? [a.station]) own.add(m); }
  for (const w of want.wards) keys.add(wardKey(w));
  return { keys: [...keys], own: [...own] };
}

async function all<T>(db: SupabaseClient, table: string, cols: string, f?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 100000; from += 1000) {
    let q = db.from(table).select(cols).range(from, from + 999);
    if (f) q = f(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    if (!data?.length) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

/** 知識を作り直す（dry＝数えるだけ）。既にある鍵は中身を差し替え、新しい鍵は足す（消さない・退役は手順5 の整理） */
export async function rebuildSearchKnowledge(db: SupabaseClient, opts: { dry?: boolean } = {}): Promise<{ delivered: KnowledgeRow[]; restatement: KnowledgeRow[]; written: number; counts: Record<string, number> }> {
  const custs = await all<any>(db, "property_customers", "id, desired_area, preferences, other_requests");
  const convs = await all<any>(db, "conversations", "id, property_customer_id, is_post_apply", (q) => q.not("property_customer_id", "is", null));
  const yumaCust = new Set(convs.filter((c) => c.id === YUMA_CONVERSATION_ID).map((c) => c.property_customer_id));
  const applied = new Set(convs.filter((c) => c.is_post_apply).map((c) => c.property_customer_id));
  const sends = await all<any>(db, "sent_properties", "property_customer_id, property_name, room_no, channel, source", (q) => q.eq("delivery", "customer").not("property_customer_id", "is", null));
  const obs = await all<any>(db, "rent_observations", "unit_key, station, ward", (q) => q.eq("branch_id", BRANCH));
  const obsBy = new Map(obs.map((o) => [o.unit_key, o]));
  const sendsBy = new Map<string, any[]>();
  for (const s of sends) {
    if (["check", "estimate"].includes(s.channel ?? "") || ["aix:property_check_result", "aix:estimate_sheet"].includes(s.source ?? "")) continue;
    const a = sendsBy.get(s.property_customer_id) ?? []; a.push(s); sendsBy.set(s.property_customer_id, a);
  }
  const t = transit();
  const facts = custs.filter((c) => !yumaCust.has(c.id)).map((c) => {
    const { keys, own } = desiredKeys(c.desired_area, [c.preferences, c.other_requests].filter(Boolean).join("\n"));
    const seen = new Set<string>();
    const delivered: Array<{ station: string | null; ward: string | null }> = [];
    for (const s of sendsBy.get(c.id) ?? []) {
      const k = unitKey(s.property_name, s.room_no);
      if (seen.has(k)) continue;
      seen.add(k);
      const o = obsBy.get(k);
      if (!o) continue;
      const g = o.station ? t.groupOf(o.station) : null;
      delivered.push({ station: g?.key ?? o.station ?? null, ward: o.ward ?? null });
    }
    return { id: c.id as string, keys, ownStations: own, delivered, applied: applied.has(c.id) };
  });
  const delivered = buildDeliveredKnowledge(facts);
  const hist = await all<any>(db, "property_condition_history", "property_customer_id, old_value, new_value", (q) => q.eq("changed_field", "desired_area"));
  const pairs = hist.filter((h) => !yumaCust.has(h.property_customer_id)).map((h) => ({ id: h.property_customer_id, from: desiredKeys(h.old_value).keys, to: desiredKeys(h.new_value).keys, applied: applied.has(h.property_customer_id) }));
  const restatement = buildRestatementKnowledge(pairs);
  const counts = {
    customers: facts.length, customers_with_delivered: facts.filter((f) => f.delivered.length).length, delivered_units: facts.reduce((a, f) => a + f.delivered.length, 0),
    delivered_keys: delivered.length, delivered_readable: readable(delivered).length, restatement_pairs: pairs.length, restatement_keys: restatement.length, restatement_readable: readable(restatement).length,
  };
  let written = 0;
  if (!opts.dry) {
    const existing = await all<any>(db, "property_search_knowledge", "id, kind, key", (q) => q.eq("branch_id", BRANCH).eq("is_current", true));
    const idOf = new Map(existing.map((e) => [`${e.kind}|${e.key}`, e.id]));
    for (const r of [...delivered, ...restatement]) {
      const row = { branch_id: BRANCH, kind: r.kind, key: r.key, payload: r.payload, evidence_count: r.evidence_count, title: r.title, content: r.content, category: "search_pattern", source: "deterministic", hypothesis_status: "confirmed", updated_at: new Date().toISOString() };
      const id = idOf.get(`${r.kind}|${r.key}`);
      const { error } = id ? await db.from("property_search_knowledge").update(row).eq("id", id) : await db.from("property_search_knowledge").insert(row);
      if (!error) written++;
    }
  }
  return { delivered, restatement, written, counts };
}

export type LoadedKnowledge = { id: string; kind: string; key: string; evidence_count: number; payload: DeliveredPayload | RestatementPayload; content: string };

/** 読む（人数が足りる・今の物だけ）。読んだ記録を付ける（手順5 の整理で「読まれない物」を見つける） */
export async function loadSearchKnowledge(db: SupabaseClient, keys: string[], opts: { markUsed?: boolean } = {}): Promise<LoadedKnowledge[]> {
  if (!keys.length) return [];
  const { data, error } = await db.from("property_search_knowledge").select("id, kind, key, evidence_count, payload, content")
    .eq("branch_id", BRANCH).eq("is_current", true).in("key", keys).gte("evidence_count", KNOWLEDGE_RULE.minCustomers);
  if (error || !data?.length) return [];
  if (opts.markUsed !== false) { try { await db.rpc("psk_mark_used", { p_ids: data.map((d) => d.id) }); } catch { /* 記録だけ */ } }
  return data as LoadedKnowledge[];
}

/** ブレインの材料の行 */
export function knowledgeLines(rows: LoadedKnowledge[]): string[] {
  return rows.map((r) => (r.kind === "desired_to_delivered" ? deliveredLine(r.key, r.payload as DeliveredPayload) : `${r.content}`)).map((l) => l.replace(/^/, "・"));
}
export { keyLabel };
