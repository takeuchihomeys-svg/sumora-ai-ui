// 2026-10-02 ⑯ 手順4b 物件検索の整理済みの知識（property-search-knowledge.ts）のテスト（LLM なし・DB なし）
// 実行: npx tsx app/lib/__tests__/property-search-knowledge.test.ts
import { buildDeliveredKnowledge, buildRestatementKnowledge, readable, deliveredLine, keyLabel, KNOWLEDGE_RULE, type DeliveredPayload } from "../property-search-knowledge";
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
