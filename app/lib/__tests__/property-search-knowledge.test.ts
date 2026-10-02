// 2026-10-02 ⑯ 手順4b 物件検索の整理済みの知識（property-search-knowledge.ts）のテスト（LLM なし・DB なし）
// 実行: npx tsx app/lib/__tests__/property-search-knowledge.test.ts
import { buildDeliveredKnowledge, buildRestatementKnowledge, readable, deliveredLine, keyLabel, planCuration, buildAreaProfiles, KNOWLEDGE_RULE, type DeliveredPayload, type ExistingKnowledge } from "../property-search-knowledge";
import { desiredKeys, unitKey } from "../property-search-knowledge-server";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info ?? ""); } };

console.log("■ 希望の鍵");
const k = desiredKeys("大国町・なんば", null);
t("駅の鍵（まとまりの代表）", k.keys.includes("station:大国町") && k.keys.includes("station:なんば"), k);
t("区の鍵", desiredKeys("北区、中央区、西区").keys.includes("ward:大阪市北区"));
t("出やすいの基準の駅も鍵", desiredKeys("なんば・梅田に出やすいエリア").keys.join(",") === "station:なんば,station:梅田");
t("梅田の希望のまとまりの駅（大阪・北新地）は『自分の駅』", ["梅田", "大阪", "北新地"].every((s) => desiredKeys("梅田").own.includes(s)));
t("建物名＋号室の鍵は DB の rent_unit_key と同じ形", unitKey("エスリード 難波（南）", "1203号") === "エスリード難波南#1203");

console.log("■ 希望 → 届けた（人数で数える）");
const rows = [
  { id: "a", keys: ["station:梅田"], ownStations: ["梅田", "大阪"], delivered: [{ station: "中津", ward: "大阪市北区" }, { station: "中津", ward: "大阪市北区" }, { station: "梅田", ward: "大阪市北区" }], applied: true },
  { id: "b", keys: ["station:梅田"], ownStations: ["梅田", "大阪"], delivered: [{ station: "中津", ward: "大阪市北区" }, { station: "十三", ward: "大阪市淀川区" }], applied: false },
  { id: "c", keys: ["station:梅田"], ownStations: ["梅田", "大阪"], delivered: [], applied: false },
  { id: "d", keys: ["station:天王寺"], ownStations: ["天王寺"], delivered: [{ station: "寺田町", ward: "大阪市天王寺区" }], applied: false },
];
const kn = buildDeliveredKnowledge(rows);
const umeda = kn.find((x) => x.key === "station:梅田")!;
const p = umeda.payload as DeliveredPayload;
t("届けていない人（c）は数えない・人数2", umeda.evidence_count === 2);
t("同じ人の同じ駅は1人（中津 2人）", p.stations.find((s) => s.name === "中津")?.customers === 2, p.stations);
t("希望の駅そのもの（梅田）は『届けた別の駅』に入れない", !p.stations.some((s) => s.name === "梅田"));
t("申込に進んだ人の駅", p.applied_customers === 1 && p.applied_stations.some((s) => s.name === "中津"));
t("1人だけの知識（天王寺）は読まない", readable(kn).every((x) => x.key !== "station:天王寺") && KNOWLEDGE_RULE.minCustomers === 2);
t("行の文に人数と駅（名前・発言は無い）", /梅田が希望のお客様2人に.*中津2人/.test(deliveredLine(umeda.key, p)) && !/[a-d]さん/.test(deliveredLine(umeda.key, p)));

console.log("■ エリアの言い直し");
const rs = buildRestatementKnowledge([
  { id: "a", from: ["station:梅田"], to: ["station:梅田", "station:十三"], applied: true },
  { id: "b", from: ["station:梅田"], to: ["station:中津"], applied: false },
  { id: "c", from: ["station:梅田"], to: ["station:梅田"], applied: false },
]);
const r0 = rs.find((x) => x.key === "station:梅田")!;
t("足した先だけ数える（同じ物の言い直しは数えない）・人数2・申込1", r0.evidence_count === 2 && /十三1人/.test(r0.content) && /中津1人/.test(r0.content) && /申込に進んだ 1人/.test(r0.content), r0.content);
t("鍵の表示（ward:大阪市北区 → 北区）", keyLabel("ward:大阪市北区") === "北区" && keyLabel("station:梅田") === "梅田");

console.log("■ 整理（統合・退役・食い違い・読まれない）");
{
  const now = Date.parse("2026-11-10T00:00:00Z");
  const ex = (id: string, key: string, ev: number, top: string, created = "2026-10-01T00:00:00Z", used: string | null = null): ExistingKnowledge =>
    ({ id, kind: "desired_to_delivered", key, evidence_count: ev, payload: { stations: [{ name: top, customers: 3 }] }, created_at: created, last_used_at: used, use_count: used ? 1 : 0 });
  const prodRow = (key: string, top: string, ev = 3) => ({ kind: "desired_to_delivered" as const, key, payload: { customers: ev, units: 5, stations: [{ name: top, customers: 3 }], wards: [], applied_customers: 0, applied_stations: [] }, evidence_count: ev, title: "t", content: "c" });
  const norm = (k: string) => (k === "station:難波" ? "station:なんば" : k);
  const plan = planCuration(
    [ex("1", "station:なんば", 5, "大国町"), ex("2", "station:難波", 2, "桜川"), ex("3", "station:天王寺", 3, "寺田町"), ex("4", "station:梅田", 3, "中津", "2026-09-01T00:00:00Z")],
    [prodRow("station:なんば", "今宮戎"), prodRow("station:梅田", "中津"), prodRow("station:十三", "神崎川")],
    { nowMs: now, normKey: norm, kinds: ["desired_to_delivered"] },
  );
  t("同じ鍵（難波＝なんば）は人数の多い方に統合・他は退役（merged）", plan.retire.some((r) => r.id === "2" && /merged/.test(r.reason)));
  t("作り直しで出てこない鍵（天王寺）は退役（not_produced・消さない）", plan.retire.some((r) => r.id === "3" && /not_produced/.test(r.reason)));
  t("届け先の1番が入れ替わった（大国町→今宮戎）は食い違いとして記録", plan.conflicts.some((c) => c.key === "station:なんば" && c.before === "大国町" && c.after === "今宮戎"));
  t("新しい鍵（十三）は足す", plan.insert.some((r) => r.key === "station:十三"));
  t("作って30日以上一度も読まれない（梅田）は報告だけ", plan.unread.includes("station:梅田") && !plan.retire.some((r) => r.id === "4"));
  t("この作り直しで作らない種類には触らない", planCuration([{ ...ex("9", "ward:x", 3, "a"), kind: "other" }], [], { nowMs: now, kinds: ["desired_to_delivered"] }).retire.length === 0);
}

console.log("■ 区のまとめ（area_profile）");
{
  const prof = buildAreaProfiles(
    [{ ward: "大阪市浪速区", plan_group: "1K", n: 400, p25: 70000, p50: 75000, p75: 80000 }, { ward: "大阪市浪速区", plan_group: "1DK", n: 5, p25: 90000, p50: 100000, p75: 110000 }],
    [{ ward: "大阪市浪速区", hubs: { なんば: 2, 梅田: 10, 京橋: null }, stations: 6 }],
    [], 10,
  );
  t("相場は件数が足りる間取りだけ・電車の最短", prof.length === 1 && /1K 7.5万（7〜8万・400件）/.test(prof[0].content) && !/1DK/.test(prof[0].content) && /なんば 2分・梅田 10分/.test(prof[0].content), prof[0]?.content);
  t("鍵は ward:<区>・種類は area_profile", prof[0].key === "ward:大阪市浪速区" && prof[0].kind === "area_profile");
}

console.log("■ 隣接区の印（竹内さん: 中央区と浪速区は隣接しているからおこなっている）");
{
  const p: DeliveredPayload = { customers: 10, units: 20, stations: [{ name: "なんば", customers: 4 }, { name: "大国町", customers: 3 }], wards: [{ name: "大阪市浪速区", customers: 6 }, { name: "大阪市中央区", customers: 5 }], applied_customers: 0, applied_stations: [] };
  const line = deliveredLine("ward:大阪市中央区", p);
  t("届け先の区が隣の区なら「隣接区」・同じ区は「同じ区」", /浪速区6人（隣接区）/.test(line) && /中央区5人（同じ区）/.test(line), line);
  t("駅も、その駅の区が隣の区なら「隣接区」（大国町＝浪速区）", /大国町3人（隣接区）/.test(line), line);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
