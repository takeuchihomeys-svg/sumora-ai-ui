// 実行: npx tsx app/lib/__tests__/strategy-freshness.test.ts
import { topicStateOn, staleStrategyMarks, staleStrategyLine } from "../strategy-freshness";
let passed = 0, failed = 0;
function it(name: string, fn: () => void) { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); } }
function ok(v: unknown, label = "") { if (!v) throw new Error(`${label} expected truthy`); }
it("既定 off", () => { ok(!topicStateOn({})); ok(topicStateOn({ CONDUCTOR_TOPIC_STATE: "on" })); });
it("12196: お客様が外した物件を cs が指したまま → excluded", () => {
  const m = staleStrategyMarks({
    cs: "お客様が送ってくださったプレサンス立売堀アーバンスタイルの募集状況と法人契約の可否を管理会社に確認し、分かり次第すぐご連絡",
    csAt: "2026-11-07T07:00:00Z",
    messages: [{ sender: "customer", text: "プレサンス立売堀アーバンスタイルが 場所的にちょっと高いかと 色々と紹介頂ける案件を お待ちしております。", created_at: "2026-11-07T08:08:24Z" }],
    knownNames: ["プレサンス立売堀アーバンスタイル", "セレニテ難波西アリエ"],
  });
  ok(m.some((x) => x.kind === "excluded" && x.name === "プレサンス立売堀アーバンスタイル"), JSON.stringify(m));
  ok(staleStrategyLine(m).includes("お客様が外した"), staleStrategyLine(m));
});
it("11865: 確認の約束の結果を送った後も cs に残る → answered", () => {
  const m = staleStrategyMarks({
    cs: "お送り頂いた物件の募集状況を管理会社に確認し、確認出来次第ご連絡する。募集中なら最大限割引の御見積書とあわせて内覧のご案内",
    csAt: "2026-11-05T11:00:00Z",
    messages: [
      { sender: "staff", text: "お送り頂きました物件の募集状況と内覧可否を、管理会社に確認させて頂きます！！", created_at: "2026-11-05T11:39:07Z" },
      { sender: "staff", text: "お送り頂きました阿部野筋5丁目の貸し家につきまして募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！", created_at: "2026-11-06T04:15:02Z" },
      { sender: "customer", text: "おとり物件てことですか🙇‍♀️ 調べてくださりありがとうございます！", created_at: "2026-11-06T07:51:40Z" },
    ],
    knownNames: [],
  });
  ok(m.length === 1 && m[0].kind === "answered", JSON.stringify(m));
});
it("13898: cs の物件と今の連投が名指す物件が違う → moved（名指しの無い連投は印を付けない）", () => {
  const cs = "大物町の見積は割引限界とお伝え済みなので、ザカラー東本町B棟102号室の入居月（12月中旬〜1月）をお客様に伺ったうえで";
  const names = ["大物町", "ザカラー東本町B棟", "エスリード大手前"];
  // 実物の 13898（「もぉ少し初期費用安くできたりしませんか？」）は物件を名指さない＝この決まった計算では印を付けない（入口の turn_topics で読む）
  ok(staleStrategyMarks({ cs, csAt: "2026-11-10T00:00:00Z", messages: [{ sender: "customer", text: "もぉ少し初期費用安くできたりしませんか？", created_at: "2026-11-12T08:33:13Z" }], knownNames: names }).length === 0);
  const m = staleStrategyMarks({ cs, csAt: "2026-11-10T00:00:00Z", messages: [{ sender: "customer", text: "エスリード大手前の方が気になってきました、初期費用もう少し安くできますか？", created_at: "2026-11-12T08:33:13Z" }], knownNames: names });
  ok(m.some((x) => x.kind === "moved" && x.name === "エスリード大手前"), JSON.stringify(m));
});
it("古くない cs には付けない（外していない・結果を送っていない・同じ物件の話）", () => {
  const m = staleStrategyMarks({ cs: "セレニテ難波西アリエの募集状況を確認しご連絡", csAt: "2026-11-08T00:00:00Z", messages: [{ sender: "customer", text: "セレニテ難波西アリエの内覧はいつ行けますか", created_at: "2026-11-08T01:00:00Z" }], knownNames: ["セレニテ難波西アリエ"] });
  ok(m.length === 0, JSON.stringify(m)); ok(staleStrategyLine(m) === "");
});
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
