// パーツごとの試験の決まった計算（scripts/lib/parts-eval.ts）
// 実行: npx tsx scripts/lib/__tests__/parts-eval.test.ts（自己完結。全 PASS で exit 0）
import {
  maskGoldText, receiveKindsOf, partReceive, splitParts, takeuchiReceives, quoteOverlap, deriveGold, goldToContract,
  scoreRow, habitTable, habitTableText, topHabitsByModel, majorityRow, parseRuns, columnOf, buildCoreInput, matchBrainAsk,
  type ResultRow, type GoldParts,
} from "../parts-eval";

let fail = 0, pass = 0;
function eq(name: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) pass++; else { fail++; console.error(`✗ ${name}\n   得: ${JSON.stringify(a)}\n   期: ${JSON.stringify(b)}`); }
}
function ok(name: string, v: boolean) { eq(name, v, true); }

// ─── 伏せる ───
eq("号室の数字を伏せる", maskGoldText("The Peak 202号室は空室"), "The Peak ◯号室は空室");
eq("電話を伏せる", maskGoldText("090-1234-5678に"), "（電話番号）に");
eq("金額・階は伏せない", maskGoldText("家賃74,500円・6階"), "家賃74,500円・6階");

// ─── 受け止め ───
eq("謝り＞不安（同じ行）", receiveKindsOf("すみません🥲")[0], "apology");
eq("お礼＞不安", partReceive("ありがとうございます💦"), "thanks");
eq("了承＋泣き＝不安", partReceive("わかりました😭"), "anxiety");
eq("中身のある文は受け止めだけではない", partReceive("お風呂が狭いと赤ちゃんのお風呂入れるのが難しいなって思っちゃって…💦"), null);
eq("文の終わりで分ける・1文の途中の改行では分けない", splitParts("明日内覧で\n気に入れば\nこちらでお願いできますか？"), ["明日内覧で 気に入れば こちらでお願いできますか？"]);
eq("受け止めの行は分ける", splitParts("そうなんですね、、(うるうる)\n承知しました！\nありがとうございます！\n広くて綺麗ですね！✨一旦見てみたいです！"), ["そうなんですね、、(うるうる)", "承知しました！", "ありがとうございます！", "広くて綺麗ですね！✨", "一旦見てみたいです！"]);
ok("竹内さんの文がお礼を受けている", takeuchiReceives("ご査収頂きありがとうございます😊！！", "thanks"));
ok("竹内さんの文がお礼を受けていない", !takeuchiReceives("はい！！\n気になる点出てきましたら何時でも", "thanks"));
ok("引用の重なり", quoteOverlap("神崎川は住んでいたが不便だった", "神崎川はすんでましたが不便だったので汗") > 0.5);

// ─── 正解の下書き ───
const spec = { id: "qX", type: "待って・閉じる", accept: ["2段:pickup"], mustNot: ["AIX:viewing_invite"], asks: [{ q: "そうなんですね、、(うるうる) 承知しました！ ありがとうございます！ 一旦見てみたいです！ 場所が少し遠いので他にも候補ありましたらお願いしたいです", route: "promise" as const, point: "新たにピックアップしてお送りする" }], ng: ["頼まれていない内覧・申込の誘いを足す"] };
const prob = { id: "qX", customer: "そうなんですね、、(うるうる)\n承知しました！\nありがとうございます！\n一旦見てみたいです！\n場所が少し遠いので他にも候補ありましたらお願いしたいです", staffText: "ご査収頂きありがとうございます😊！！\nかしこまりました！！\nYUMAさんにオススメできるお部屋を新たにピックアップしてお送りさせて頂きます！！" };
const g = deriveGold(spec, prob);
eq("spec の依頼は要点に一番近い部分になる", g.asks[0].quote, "場所が少し遠いので他にも候補ありましたらお願いしたいです");
eq("spec の依頼は spec のまま", g.asks[0].status, "spec");
eq("受け止めを分ける（気遣い・了承・お礼）", g.asks.filter((a) => a.receive).map((a) => a.receive), ["care", "agree", "thanks"]);
eq("竹内さんが受けていない気遣い＝触れない", g.asks.find((a) => a.receive === "care")!.route, "none");
eq("お礼は受けている＝返信", g.asks.find((a) => a.receive === "thanks")!.route, "reply");
eq("答えていない部分＝触れない（確認待ち）", g.asks.find((a) => a.quote.startsWith("一旦"))!.route, "none");
eq("先に答える項目は依頼", g.leadWith, "a1");
ok("確認待ちの印がある", g.pending.length >= 3);
const c = goldToContract(g);
eq("TurnContract の形（leadWith は番号）", c.leadWith, 0);
eq("足す欄は extra", Object.keys(c.extra[0]).sort(), ["facts", "id", "priority", "properties", "receive", "say", "status", "why"]);

// 言い換えの spec は、お客様の言葉を引用にする
const g2 = deriveGold({ id: "qY", type: "広告の理解", accept: ["返信"], asks: [{ q: "他の物件は掲載しているが募集無しなのか", route: "reply", point: "掲載が残る仕組みを説明" }] }, { id: "qY", customer: "他のとこは掲載してるけど募集無しですか？", staffText: "はい！！" });
eq("言い換え→発言の言葉", g2.asks[0].quote, "他のとこは掲載してるけど募集無しですか？");
eq("言い換えは label に残す", g2.asks[0].label, "他の物件は掲載しているが募集無しなのか");

// ─── 採点 ───
const row = (o: Partial<ResultRow>): ResultRow => ({ id: "qX", rep: 1, label: "mc-x", ...o });
const tcAsk = (quote: string, route: string, kind = "request") => ({ quote, route, kind });
// 全部正解
const good = scoreRow(g, row({ brain: { turn_contract: { asks: [tcAsk("場所が少し遠いので他にも候補ありましたら", "promise")], lead_with: 0 } }, path: { code: "2段:pickup", ok: true }, essence: { code: "2段:pickup", ok: true }, asks: [{ q: "", covered: true, route: true }], ng: [{ text: "x", violated: false }], draft: { text: "ありがとうございます！！新たにピックアップします", code: "2段:pickup", ok: true, asks: [true], ng: [false] } }));
eq("正解は外れなし", good.misses, []);
eq("段ごとの分母（確認待ちは数えない）", [good.stage.reader.n, good.stage.link.n, good.stage.priority.n, good.stage.writer.n], [1, 1, 1, 1]);
// 読めていない
const miss = scoreRow(g, row({ brain: { turn_contract: { asks: [tcAsk("一旦見てみたいです", "aix")], lead_with: 0 } }, path: { code: "AIX:viewing_invite", ok: false }, essence: { code: "AIX:viewing_invite", ok: false }, asks: [{ q: "", covered: false, route: false }], ng: [{ text: "頼まれていない内覧", violated: true }] }));
eq("読み手の取りこぼし（約束の抜け）", miss.misses[0], { stage: "reader", kind: "約束の抜け", askId: "a1", note: "読めていない「場所が少し遠いので他にも候補ありましたら」" });
ok("言ってはいけない事は優先の段で数える", miss.misses.some((m) => m.stage === "priority" && m.kind === "言ってはいけない事"));
eq("書く役は分母に入らない（ブレインで落ちた）", miss.stage.writer.n, 0);
// 道の取り違え
const route = scoreRow(g, row({ brain: { turn_contract: { asks: [tcAsk("場所が少し遠いので他にも候補", "reply")], lead_with: 0 } }, path: { code: "返信", ok: false }, essence: { code: "返信", ok: false }, asks: [{ q: "", covered: false, route: false }] }));
eq("つなぎの抜け（道の取り違え）は1回だけ数える", route.misses.map((m) => `${m.stage}:${m.kind}`), ["link:道の取り違え"]);
// 決まりの上書き
const over = scoreRow(g, row({ brain: { turn_contract: { asks: [tcAsk("場所が少し遠いので他にも候補", "promise")], lead_with: 0 } }, path: { code: "返信", ok: false }, essence: { code: "2段:pickup", ok: true }, asks: [{ q: "", covered: true, route: true }] }));
eq("本質は正解・最終で外れ＝決まりが本質を上書き", over.misses.map((m) => `${m.stage}:${m.kind}`), ["priority:決まりが本質を上書き"]);
// 書く役の抜け
const writer = scoreRow(g, row({ brain: { turn_contract: { asks: [tcAsk("場所が少し遠いので他にも候補", "promise")], lead_with: 0 } }, path: { code: "2段:pickup", ok: true }, essence: { code: "2段:pickup", ok: true }, asks: [{ q: "", covered: true, route: true }], draft: { text: "かしこまりました", code: "2段:pickup", ok: true, asks: [false], ng: [] } }));
eq("書く役の抜け", writer.misses.map((m) => `${m.stage}:${m.kind}`), ["writer:約束の抜け"]);
// 確認待ちも入れる
const all = scoreRow(g, row({ brain: { turn_contract: { asks: [tcAsk("場所が少し遠いので他にも候補", "promise")], lead_with: 0 } }, path: { code: "2段:pickup", ok: true }, essence: { code: "2段:pickup", ok: true }, asks: [{ q: "", covered: true, route: true }] }), { includeMachine: true });
ok("確認待ちを入れると受け止めの抜けが出る", all.misses.some((m) => m.kind === "受け止めの抜け"));
// 受け止めはブレインが気持ちとして持っていれば読めた
eq("受け止めの照合（気持ち）", matchBrainAsk(g.asks.find((a) => a.receive === "thanks")!, [{ quote: "全体", kind: "feeling" }]), 0);

// ─── 癖の表・多数決・案 ───
const t = habitTable([{ ...miss, column: "A:sonnet#1" }, { ...route, column: "C:flash#1" }, { ...good, column: "C:flash#2" }]);
eq("列", t.columns, ["A:sonnet#1", "C:flash#1", "C:flash#2"]);
ok("表に読み手の行", t.rows.some((r) => r.stage === "reader" && r.kind === "約束の抜け" && r.counts[0] === 1));
ok("表の文字", habitTableText(t).includes("| 読み手の取りこぼし | 約束の抜け | 1 | 0 | 0 | 1 |"));
eq("モデルごとの癖（# より前でまとめる）", topHabitsByModel(t, 1).map((x) => [x.model, x.top[0]?.kind]), [["A:sonnet", "約束の抜け"], ["C:flash", "道の取り違え"]]);
const m3 = majorityRow([
  row({ rep: 1, path: { code: "返信", ok: false }, asks: [{ q: "a", covered: false }], draft: { text: "x", code: "返信", ok: false, asks: [false], ng: [false] } }),
  row({ rep: 2, path: { code: "2段:pickup", ok: true }, asks: [{ q: "a", covered: true }], draft: { text: "y", code: "2段:pickup", ok: true, asks: [true], ng: [false] } }),
  row({ rep: 3, path: { code: "2段:pickup", ok: true }, asks: [{ q: "a", covered: true }], draft: { text: "z", code: "2段:pickup", ok: true, asks: [true], ng: [true] } }),
], "mc-x")!;
eq("多数決の道", [m3.path!.code, m3.path!.ok], ["2段:pickup", true]);
eq("多数決の依頼", m3.asks![0].covered, true);
eq("多数決の下書き", [m3.draft!.ok, m3.draft!.asks, m3.draft!.ng], [true, [true], [false]]);
eq("案の並び", parseRuns("A=mc1018-sonnet,Cmaj=mc1018-flash:maj3,D=mc-d"), [{ plan: "A", label: "mc1018-sonnet", majority: false }, { plan: "Cmaj", label: "mc1018-flash", majority: true }, { plan: "D", label: "mc-d", majority: false }]);
eq("列の名前", [columnOf("A", "mc1018-sonnet", 1), columnOf("C", "mc1018-flash", "maj")], ["A:sonnet#1", "C:flash#maj"]);
const core = buildCoreInput(g.asks.map((a) => ({ id: a.id, quote: a.quote, kind: a.kind, receive: a.receive, properties: a.properties, route: a.route, facts: a.facts, say: a.say })), prob.customer);
ok("案D の核の材料にお客様の文そのもの", core.includes(prob.customer) && core.includes("受け止め:お礼"));

const _g: GoldParts = g; void _g;
console.log(`parts-eval: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
