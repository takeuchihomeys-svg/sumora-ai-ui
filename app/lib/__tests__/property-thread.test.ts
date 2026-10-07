// 物件ごとの状況の台帳（app/lib/property-thread.ts）のテスト（自己完結ハーネス）
// 2026-10-07 竹内（S❤ 事例）。並びは本番の会話の実物（d3a56a97・c024b7b9・63fa0c26）を写した（名前は物件名だけ・画像は記号）。
// 実行: npx tsx app/lib/__tests__/property-thread.test.ts
import { resolvePropertyThreads, buildPropertyThreadNote, topicOf, type PtMsg, type PtAix } from "../property-thread";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };

const img = (lmid: string, at: string, url: string, aix = true): PtMsg => ({ sender: "staff", text: "[画像]", created_at: at, line_message_id: lmid, image_url: url, is_aix_generated: aix });

describe("S❤（d3a56a97）: 名前の無い見積書の画像への引用 → 初期費用を聞かれた物件（推定）", () => {
  const messages: PtMsg[] = [
    img("s1", "2026-10-06T04:15:36.295Z", "u-ferio"),
    img("s2", "2026-10-06T04:15:36.563Z", "u-ichitsuya"),
    { sender: "customer", text: "こちらの初期費用知りたいです🙏🏻", created_at: "2026-10-06T04:58:37Z", line_message_id: "c1", quoted_message_id: "s1" },
    img("a1", "2026-10-06T10:21:24.944Z", "u-est1"),
    img("a2", "2026-10-06T10:21:26.178Z", "u-felicide"),
    img("a3", "2026-10-06T10:21:26.304Z", "u-est2"),
    { sender: "staff", text: "お送り頂きました物件の中で\n・シャーメゾン フェリシード 101号室\nこちら1件現在募集中となります！！", created_at: "2026-10-06T10:21:26.539Z", is_aix_generated: true },
    { sender: "customer", text: "ありがとうございます🙏🏻\nこちら礼金は少し安くなったりはしないでしょうか？", created_at: "2026-10-06T16:24:31Z", line_message_id: "c2", quoted_message_id: "a1" },
    { sender: "customer", text: "あとこちらの詳細もお願いします🙏", created_at: "2026-10-06T16:24:48Z", line_message_id: "c3", quoted_message_id: "s2" },
  ];
  const imageLabels = new Map([["u-ferio", "フェリオ永田 101号室"], ["u-ichitsuya", "クリエオーレ一津屋Ⅱ 103号室"], ["u-felicide", "シャーメゾン フェリシード 101号室"]]);
  const aix: PtAix[] = [{ created_at: "2026-10-06T10:21:29Z", aix_type: "property_check_result", property_names: ["物件①", "シャーメゾン フェリシード 101号室"], prop_statuses: ["available", "available"], estimate_sent: true }];
  const s = resolvePropertyThreads({ messages, imageLabels, aix });
  it("今の番の物件は2件（礼金→フェリオ永田・詳細→一津屋Ⅱ）", () => {
    eq(s.turnTargets.length, 2);
    eq(s.turnTargets[0].display, "フェリオ永田 101号室"); eq(s.turnTargets[0].topic, "discount"); eq(s.turnTargets[0].by, "inferred");
    eq(s.turnTargets[1].display, "クリエオーレ一津屋Ⅱ 103号室"); eq(s.turnTargets[1].topic, "detail"); eq(s.turnTargets[1].by, "quote");
  });
  it("材料の文: ▶ にフェリオ永田・フェリシードは「他の物件」", () => {
    const n = buildPropertyThreadNote(s);
    truthy(/▶ 今の番の物件: フェリオ永田 101号室/.test(n), n);
    truthy(/他の物件[\s\S]*シャーメゾン フェリシード/.test(n), n);
  });
});

describe("c024b7b9: 画像4枚・物件2件の AIX → 前2枚が1件目・後ろ2枚が2件目", () => {
  const messages: PtMsg[] = [
    img("a1", "2026-10-01T02:03:49.2Z", "x1"), img("a2", "2026-10-01T02:03:49.3Z", "x2"), img("a3", "2026-10-01T02:03:50.3Z", "x3"), img("a4", "2026-10-01T02:03:50.4Z", "x4"),
    { sender: "staff", text: "・杭瀬北新町エヌエム 6FA\n・エリシオン大物町 301号室\nこちら2件どちらも…募集中となります！！", created_at: "2026-10-01T02:03:50.8Z", is_aix_generated: true },
    { sender: "customer", text: "こんなに安いんですね！", created_at: "2026-10-01T02:08:53Z", line_message_id: "c1", quoted_message_id: "a4" },
  ];
  const aix: PtAix[] = [{ created_at: "2026-10-01T02:03:52Z", aix_type: "property_check_result", property_names: ["杭瀬北新町エヌエム 6FA", "エリシオン大物町 301号室"], prop_statuses: ["available", "available"], estimate_sent: true }];
  const s = resolvePropertyThreads({ messages, imageLabels: new Map(), aix });
  it("4枚目への引用はエリシオン大物町（スタッフの答えと同じ）", () => eq(s.turnTargets[0]?.display, "エリシオン大物町 301号室"));
});

describe("寄せられない時は推測しない", () => {
  it("画像3枚・物件2件・目印なし → 引用先の物件は決めない", () => {
    const messages: PtMsg[] = [img("a1", "2026-10-01T02:00:00Z", "x1"), img("a2", "2026-10-01T02:00:01Z", "x2"), img("a3", "2026-10-01T02:00:02Z", "x3"),
      { sender: "customer", text: "こちら安くなりますか", created_at: "2026-10-01T03:00:00Z", quoted_message_id: "a2" }];
    const s = resolvePropertyThreads({ messages, imageLabels: new Map(), aix: [{ created_at: "2026-10-01T02:00:05Z", aix_type: "property_check_result", property_names: ["A棟 101号室", "Bハイツ 202号室"], prop_statuses: ["available", "available"], estimate_sent: true }] });
    eq(s.turnTargets.length, 0); eq(buildPropertyThreadNote(s), "");
  });
  it("物件の話でない番 → 材料なし", () => {
    const s = resolvePropertyThreads({ messages: [{ sender: "customer", text: "よろしくお願いします", created_at: "2026-10-01T03:00:00Z" }], imageLabels: new Map() });
    eq(buildPropertyThreadNote(s), "");
  });
});

describe("話題・画像の書き起こし", () => {
  it("礼金→値下げ／初期費用→費用／詳細", () => { eq(topicOf("礼金は少し安くなったり"), "discount"); eq(topicOf("初期費用知りたいです"), "cost"); eq(topicOf("詳細もお願いします"), "detail"); });
  it("ゆなまる: ポータルの画面の書き起こし（敷金の語）は値下げと読まず「送ってきた」", () => {
    const s = resolvePropertyThreads({
      messages: [{ sender: "staff", text: "確認させていただきました！！\nシャーメゾン ソレイユ 0202号室現在募集中", created_at: "2026-10-06T09:00:00Z", is_aix_generated: true },
        { sender: "customer", text: "[画像] 【物件の画面（ポータル）】\nシャーメゾン ソレイユ 0202号室\n敷金・契約一時金 2万円・8万円", created_at: "2026-10-06T10:31:31Z" }],
      imageLabels: new Map(), aix: [{ created_at: "2026-10-06T09:00:01Z", aix_type: "property_check_result", property_names: ["シャーメゾン ソレイユ 0202号室"], prop_statuses: ["available"] }],
    });
    eq(s.rooms[0].events.some((e) => e.kind === "customer_shared"), true);
    eq(s.rooms[0].events.some((e) => e.topic === "discount"), false);
  });
  it("スタッフの交渉の宣言・結果を物件に付ける", () => {
    const s = resolvePropertyThreads({
      messages: [img("s1", "2026-10-06T04:15:00Z", "u1", false),
        { sender: "staff", text: "フェリオ永田の礼金について、管理会社に減額交渉をさせて頂きます！！", created_at: "2026-10-07T02:02:08Z" },
        { sender: "staff", text: "フェリオ永田の礼金について管理会社に交渉させていただきましたが、減額は難しいとのご返事でした。", created_at: "2026-10-07T06:08:03Z" }],
      imageLabels: new Map([["u1", "フェリオ永田 101号室"]]),
    });
    eq(s.rooms[0].events.map((e) => e.kind).join(","), "sent,staff_negotiating,staff_result");
  });
});

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} passed, ${failed} failed`);
if (failed > 0) { console.log(failures.map((f) => ` - ${f}`).join("\n")); process.exit(1); }
