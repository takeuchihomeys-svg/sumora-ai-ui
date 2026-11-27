// app/lib/__tests__/aix-brain-read-card.test.ts — #827 AIX ボタンの文作りに渡すブレインの読みの札
import assert from "node:assert/strict";
import { aixBrainReadCard, aixReadSrcOf, aixBrainReadCardOn } from "../aix-brain-read-card";

let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => { try { fn(); pass++; console.log("  OK  " + name); } catch (e) { fail++; console.log("  NG  " + name + "\n      " + (e as Error).message); } };

t("既定 off", () => { assert.equal(aixBrainReadCardOn({}), false); assert.equal(aixBrainReadCardOn({ AIX_BRAIN_READ_CARD: "on" }), true); });
t("meta が無ければ空", () => { assert.equal(aixBrainReadCard(null), ""); assert.equal(aixBrainReadCard({}), ""); });
t("番の目的・狙い・仕込み・要点・駅が事実の行で出る・言い回しと種類は変えない但し書き", () => {
  const c = aixBrainReadCard({
    turn_aims_after: { turnAim: "空きの結果を伝える", midAim: "内覧の日程へ", plant: "1部屋のみ・申込で抑えてから内覧も可" },
    main_point: "空きと初期費用",
    apply_route: { node: "proposing", branch: null, substate: { id: "proposing_liked_one" } },
  });
  assert.match(c, /この番の目的: 空きの結果を伝える/);
  assert.match(c, /次の2〜3番の狙い: 内覧の日程へ/);
  assert.match(c, /先の番のための一言.*1部屋のみ/);
  assert.match(c, /要点: 空きと初期費用/);
  assert.match(c, /今の駅: proposing（細かい状態 proposing_liked_one）/);
  assert.match(c, /AIX の種類・ピッカー・確認の結果・金額・日程は変えない/);
});
t("仕込みに確認・約束が入っていたら渡さない（q065 の教訓）", () => {
  const c = aixBrainReadCard({ turn_aims_after: { turnAim: "入居日を答える", plant: "最速入居日は管理会社に確認してすぐ連絡する" } });
  assert.doesNotMatch(c, /管理会社に確認/);
  assert.match(c, /この番の目的/);
});
t("分かれ道の駅は 分: で出す", () => {
  assert.match(aixBrainReadCard({ apply_route: { node: "proposing", branch: "条件変更" } }), /今の駅: 分:条件変更/);
});
t("材料の要約は決まった計算で取る（答え漏れ・逆算・駅の状態・誘い・140字で切る）", () => {
  const long = "あ".repeat(200);
  const src = aixReadSrcOf({ blocks: [
    { key: "unanswered", text: "【まだ答えていない問い: 駐車場の空き】" },
    { key: "route_backplan", text: "入居 1/10 から逆算: 申込は 12/10 ごろ" },
    { key: "station_state", text: long },
    { key: "pickup_why", text: "使わない" },
  ], holdSoftNext: "検討の後に内覧の候補日を添える" })!;
  assert.equal(src.unanswered, "まだ答えていない問い: 駐車場の空き");
  assert.match(src.backplan!, /逆算/);
  assert.equal(src.station_state!.length, 141);
  assert.equal(src.soft_next, "検討の後に内覧の候補日を添える");
  assert.equal(Object.keys(src).length, 4);
  const c = aixBrainReadCard({ aix_read_src: src });
  assert.match(c, /まだ答えていない事（この AIX で受ける物だけ触れる）: まだ答えていない問い: 駐車場の空き/);
  assert.match(c, /やわらかい次の一手の候補/);
});
t("材料が無ければ要約は null", () => { assert.equal(aixReadSrcOf({ blocks: [], holdSoftNext: "" }), null); });
t("ブレインの出力の turn_aims（BRAIN_TURN_AIMS・凍結）は読まない", () => {
  assert.equal(aixBrainReadCard({ turn_aims: { turnAim: "読まない目的" } } as never), "");
});
t("判断の後の決まった計算の目的（aix_read_src.aims）は札に入る", () => {
  const src = aixReadSrcOf({ blocks: [], aims: { turnAim: "好きな1件の中身に答える", midAim: "内覧へ", plant: "" } })!;
  const c = aixBrainReadCard({ aix_read_src: src });
  assert.match(c, /この番の目的: 好きな1件の中身に答える/);
  assert.match(c, /次の2〜3番の狙い: 内覧へ/);
});

console.log(`\n合計: ${pass}/${pass + fail}`); if (fail) process.exit(1);
