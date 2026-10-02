// 2026-10-02 ⑯ 手順6 過去の LINE からの物件検索の知識（line-search-knowledge.ts）と、なんば・梅田以外の起点のテスト（LLM なし）
// 実行: npx tsx app/lib/__tests__/line-search-knowledge.test.ts
import { anchorUsesInText, staffPhrasesInText, anonymize, buildLineKnowledge } from "../line-search-knowledge";
import { readRelativeArea, readRideAsks, buildAreaPlan } from "../osaka-area-profile";
import { transit } from "../transit-route";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info ?? ""); } };
const g = (s: string) => transit().groupOf(s)?.key ?? null;

console.log("■ お客様の起点の言い方（実物の言い回し）");
const u1 = anchorUsesInText("梅田、中津まで電車1本で行けるところがいいです。できれば15分から２０分以内くらいの場所がいいです。", g);
t("1本 → ride（梅田・中津）", u1.some((u) => u.anchor === "梅田" && u.type === "ride") && u1.some((u) => u.anchor === "中津" && u.type === "ride"), u1);
t("なんばまで行きやすい → soft", anchorUsesInText("なんばまで行きやすいところが良くて、平野区だとJRは不便で", g).some((u) => u.anchor === "なんば" && u.type === "soft"));
t("梅田まで30分 → minutes", anchorUsesInText("梅田まで30分以内で乗り継ぎ一回とかでいける場所", g).some((u) => u.anchor === "梅田" && u.type === "minutes"));
t("桜川駅の近く → near", anchorUsesInText("桜川駅の近くで探してます", g).some((u) => u.anchor === "桜川" && u.type === "near"));
t("駅まで徒歩15分は数えない", anchorUsesInText("梅田まで徒歩15分", g).every((u) => u.type !== "minutes"));

console.log("■ スタッフの説明の1文（名前は伏せる）");
const p1 = staffPhrasesInText("清水さん お世話になっております！！ ご指摘ありがとうございます！！ 難波周辺の中央区浪速区の1LDK家賃相場は10万円から12万円となり、1Kの家賃相場が7万円から8万円程となります。");
t("相場の文を抜く", p1.some((p) => p.kind === "相場" && /1LDK家賃相場は10万円から12万円/.test(p.sentence)), p1);
t("挨拶の文は抜かない", !p1.some((p) => /お世話になっております/.test(p.sentence)));
const p2 = staffPhrasesInText("お部屋の広さ29.3㎡とDaikiさんのご希望条件より一回り狭くなってしまいますが 新大阪駅徒歩3分・家賃68,000円という条件は間取り・家賃・立地含めまして");
t("広さの理由の文・名前は〇〇さん（前の語を巻き込まない）", p2.some((p) => p.kind === "理由の説明" && /29\.3m2と〇〇さんのご希望条件より一回り狭く/.test(p.sentence)), p2);
t("駅徒歩だけの文（好立地）は理由の説明に数えない", staffPhrasesInText("家賃管理費込54,000円、東海道線「塚本」徒歩3分の好立地で、かなりオススメ出来るお部屋となります！").every((p) => p.kind !== "理由の説明"));
t("条件を広げる提案", staffPhrasesInText("17万円以内のお部屋限りございましたので、家賃のご条件を広げさせていただきお送りさせていただきました！").some((p) => p.kind === "条件を広げる提案"));
t("電話番号は消す", !/06-4400/.test(anonymize("勤務先TEL 06-4400-6893 の件、相場は")));

console.log("■ 会話の山 → 知識の行（会話の数で数える）");
const k = buildLineKnowledge([
  { conversation_id: "a", sender: "customer", text: "梅田まで1本で行ける線" },
  { conversation_id: "a", sender: "customer", text: "梅田まで乗り換えなしがいいです" },
  { conversation_id: "b", sender: "customer", text: "難波か梅田まで電車一本" },
  { conversation_id: "c", sender: "staff", text: "大阪市北区の1LDKの家賃相場は9万円から12万円程となります！！" },
], g);
const umeda = k.rows.find((r) => r.key === "station:梅田")!;
t("同じ会話は1つ（梅田 2会話・1本 2）", umeda.evidence_count === 2 && umeda.payload.by_type.ride === 2, umeda);
t("スタッフの文は phrase の鍵", k.rows.some((r) => r.key === "phrase:相場"));

console.log("■ なんば・梅田以外の起点（同じ読みで範囲が出る）");
for (const [text, anchor] of [["天王寺に出やすいところ", "天王寺"], ["京橋まで乗り換えなし", "京橋"], ["新大阪に行きやすい", "新大阪"], ["本町まで1本で20分以内", "本町"], ["江坂に出やすい", "江坂"], ["三宮まで直通", "三ノ宮"], ["堺東に出やすいエリア", "堺東"]] as Array<[string, string]>) {
  const w = readRelativeArea(text).anchors.length ? readRelativeArea(text) : readRideAsks(text);
  const plan = buildAreaPlan(w);
  t(`「${text}」→ ${anchor}・範囲 ${plan?.stations.length ?? 0}駅`, w.anchors[0]?.station === anchor && (plan?.stations.length ?? 0) >= 3, w.anchors);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
