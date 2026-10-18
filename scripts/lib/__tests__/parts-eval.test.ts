// パーツごとの試験の決まった計算（scripts/lib/parts-eval.ts）
// 実行: npx tsx scripts/lib/__tests__/parts-eval.test.ts（自己完結。全 PASS で exit 0）
import {
  maskGoldText, receiveKindsOf, partReceive, splitParts, takeuchiReceives, quoteOverlap, deriveGold, goldToContract,
  scoreRow, habitTable, habitTableText, topHabitsByModel, majorityRow, parseRuns, columnOf, buildCoreInput, matchBrainAsk,
  brainFunctionOf, aixKeyOfBrain, pickerVerdict, propertyNamed, referentMiss, pathKind, applyGoldExtra, functionTable, functionTableText,
  signMatches, principleChoice, principleTable, applyRubric, bestFinalSim,
  type ResultRow, type GoldParts, type PrincipleConflict,
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

// ─── 20問で足した物（2026-10-18） ───
eq("伏せる: 代表の名前", maskGoldText("代表取締役 竹内悠馬\nTEL"), "代表取締役（名前）\nTEL");
eq("伏せる: 金額の桁区切りは伏せない", maskGoldText("初期費用170,480円には"), "初期費用170,480円には");
eq("働きの型", [brainFunctionOf("reader", "受け止めの抜け"), brainFunctionOf("link", "ピッカーの選び違い"), brainFunctionOf("link", "主語・指す物の取り違え"), brainFunctionOf("priority", "決まりが本質を上書き"), brainFunctionOf("writer", "質問の答えの抜け"), brainFunctionOf("link", "自信が低いのに言い切った")], ["気持ち", "決める", "注意", "慣れ／じっくり", "体で覚える", "自信の気づき"]);
eq("AIX の鍵（物件確認した は細目まで）", [aixKeyOfBrain("property_check_result", "mgmt_equipment"), aixKeyOfBrain("cost_breakdown", null), aixKeyOfBrain("property_check_result", null)], ["property_check_result/条件:mgmt_equipment", "cost_breakdown", "property_check_result/募集状況"]);
eq("ピッカー: 合う／細目違い／ボタン違い／ボタンだけの正解", [pickerVerdict(["property_check_result/条件:mgmt_equipment"], "property_check_result/条件:mgmt_equipment"), pickerVerdict(["property_check_result/条件:mgmt_equipment"], "property_check_result/条件:mgmt_pet"), pickerVerdict(["cost_breakdown"], "viewing_invite"), pickerVerdict(["property_check_result"], "property_check_result/条件:mgmt_pet")], ["ok", "picker", "button", "ok"]);
ok("物件の名前（号室の揺れは同じ）", propertyNamed("栄美グランドハイツ", "栄美グランドハイツ 413号室・浅香山住宅5号棟 503号室"));
const ref2 = { mode: "all" as const, targets: ["栄美グランドハイツ", "浅香山住宅5号棟"] };
eq("指す物: 2件とも名指し＝合う", referentMiss(ref2, "栄美グランドハイツ 413号室・浅香山住宅5号棟 503号室"), null);
ok("指す物: 1件だけ＝外れ", (referentMiss(ref2, "栄美グランドハイツ 413号室") ?? "").includes("だけ"));
eq("指す物: 名指しが無い＝分からない", referentMiss(ref2, "お送りしたお2部屋"), null);
const gp = (accept: string[], sure: "low" | null = null) => ({ accept, asks: [{ ...g.asks[0], sure, route: "promise" as const }] });
eq("道の種類: 言い切り／AIX の判断（AIX にした・しなかった）／ピッカー／種類", [pathKind(gp(["2段:check"], "low"), "返信"), pathKind(gp(["2段:pickup"]), "AIX:viewing_invite"), pathKind(gp(["AIX:estimate_sheet"]), "返信"), pathKind(gp(["AIX:property_check_result/条件:mgmt_equipment"]), "AIX:property_check_result/条件:mgmt_pet"), pathKind(gp(["AIX:cost_breakdown"]), "AIX:viewing_invite")], ["自信が低いのに言い切った", "AIXの判断の外れ", "AIXの判断の外れ", "ピッカーの選び違い", "AIXの種類の取り違え"]);
// 採点: ピッカー・指す物・自信
const g20 = applyGoldExtra(JSON.parse(JSON.stringify(g)) as GoldParts, { asks: { "spec:0": { route: "aix", routes: ["aix", "promise"], pickers: ["property_check_result/条件:mgmt_equipment"], referent: ref2, sure: "low" } } });
const base20 = { path: { code: "AIX:property_check_result", ok: true }, essence: { code: "AIX:property_check_result", ok: true }, asks: [{ q: "", covered: true, route: true }] };
eq("ピッカーの選び違い（つなぎの段）", scoreRow(g20, row({ ...base20, brain: { action: "property_check_result", check_pattern: "mgmt_pet", turn_contract: { asks: [{ quote: "場所が少し遠いので他にも候補", route: "aix", aix: "property_check_result", property: "栄美グランドハイツ・浅香山住宅5号棟" }], lead_with: 0 } } })).misses.map((m) => `${m.stage}:${m.kind}`), ["link:ピッカーの選び違い"]);
eq("主語・指す物の取り違え（1件に決め打ち）", scoreRow(g20, row({ ...base20, brain: { action: "property_check_result", check_pattern: "mgmt_equipment", turn_contract: { asks: [{ quote: "場所が少し遠いので他にも候補", route: "aix", aix: "property_check_result", property: "浅香山住宅5号棟 503号室" }], lead_with: 0 } } })).misses.map((m) => `${m.stage}:${m.kind}`), ["link:主語・指す物の取り違え"]);
eq("自信が低いのに返信で言い切った", scoreRow(g20, row({ ...base20, asks: [{ q: "", covered: false, route: false }], brain: { turn_contract: { asks: [{ quote: "場所が少し遠いので他にも候補", route: "reply" }], lead_with: 0 } } })).misses.map((m) => `${m.stage}:${m.kind}`)[0], "link:自信が低いのに言い切った");
eq("言ってはいけない事が「言い切る」なら自信の外れ", scoreRow(g20, row({ ...base20, brain: { action: "property_check_result", check_pattern: "mgmt_equipment", turn_contract: { asks: [{ quote: "場所が少し遠いので他にも候補", route: "aix", aix: "property_check_result" }], lead_with: 0 } }, ng: [{ text: "ペット可と言い切る", violated: true }] })).misses.map((m) => m.kind), ["自信が低いのに言い切った"]);
const wd = scoreRow(g20, row({ ...base20, brain: { action: "property_check_result", check_pattern: "mgmt_equipment", turn_contract: { asks: [{ quote: "場所が少し遠いので他にも候補", route: "aix", aix: "property_check_result" }], lead_with: 0 } }, draft: { text: "栄美グランドハイツの御見積書です", code: "AIX:property_check_result", ok: true, asks: [true], ng: [] } }));
eq("下書きが1件だけ名指し＝書く役の指す物の外れ", wd.misses.map((m) => `${m.stage}:${m.kind}`), ["writer:主語・指す物の取り違え"]);
const ft = functionTable([{ ...wd, column: "A#1" }]);
ok("働きの型の表", functionTableText(ft).includes("| 注意 | 1 | 1 |"));
// 正解に足す
const gx = applyGoldExtra(JSON.parse(JSON.stringify(g)) as GoldParts, { addAsks: [{ quote: "内見を前向きに検討しています", route: "reply", say: "最後に内覧に誘う" }], asks: { "q:内見を前向き": { priority: 9 } }, leadWith: "a1", confirm: [{ id: "c1", q: "よいか", yes: "はい", no: "いいえ" }] });
ok("無い行を足す", gx.asks.some((a) => a.quote === "内見を前向きに検討しています" && a.status === "machine"));
eq("言葉で当てて順を決める", gx.asks.find((a) => a.quote.startsWith("内見"))!.priority, 9);
ok("確認の問いが確認待ちに入る", gx.pending.some((p) => p.startsWith("c1:")) && !gx.pending.some((p) => p.startsWith("先に答える項目")));
const gx2 = applyGoldExtra(JSON.parse(JSON.stringify(g)) as GoldParts, { addAsks: [{ quote: "場所が少し遠いので他にも候補ありましたらお願いしたいです", route: "reply" }] });
eq("似た行があれば足さない", gx2.asks.length, g.asks.length);
// 原則のぶつかり
const pc: PrincipleConflict = { id: "p1", pair: [5, 9], winner: 5, why: "物件ごと", signs: { "5": ["2段", "AIX:property_check_result"], "9": ["返信"] } };
eq("原則の印", [signMatches("2段", "2段:check"), signMatches("AIX:物件", "AIX:property_send（左だけ）"), signMatches("AIX:property_check_result", "AIX:property_check_result/availability"), signMatches("2段", "返信")], [true, true, true, false]);
eq("どちらの原則を優先したか", [principleChoice(pc, "2段:check"), principleChoice(pc, "返信"), principleChoice(pc, "AIX:viewing_invite")], [5, 9, null]);
const gpc = applyGoldExtra(JSON.parse(JSON.stringify(g)) as GoldParts, { principles: [pc] });
ok("原則の確認待ち", gpc.pending.some((p) => p.startsWith("p1: 原則 5.")));
const sp = scoreRow(gpc, row({ path: { code: "返信", ok: false }, essence: { code: "2段:check", ok: true } }), { includeMachine: true });
eq("原則: 本質と最終を分けて読む", sp.principles, [{ id: "p1", pair: [5, 9], gold: 5, brain: 5, final: 9 }]);
eq("原則: spec だけの時は機械の下書きの原則を数えない", scoreRow(gpc, row({ path: { code: "返信", ok: false } })).principles, []);
const ptab = principleTable([{ ...sp, column: "A#1" }]);
ok("原則の組×勝ちの表", ptab.includes("5.物件ごとに違う事は確認の約束 × 9.資料・会社の事実は即答") && ptab.includes("1/1") && ptab.includes("正解（竹内さん）"));
// 物差し（旧／幅あり）
const gw = { ...g, goodAnswers: [{ id: "w1", code: "返信", text: "かしこまりました！！他の候補も探します", by: "竹内さん" as const }], judgeReviews: [{ item: "ask:0", verdict: true, by: "竹内さん" as const }] };
const rw = row({ path: { code: "返信", ok: false }, asks: [{ q: "", covered: false, route: false }] });
eq("旧の物差しは何も変えない", applyRubric(gw, rw, "old").r.path!.ok, false);
const aw = applyRubric(gw, rw, "wide");
eq("幅あり: 良い答えの道で合格・判定の見直しで依頼が合格", [aw.r.path!.ok, aw.r.asks![0].covered, aw.g.accept.includes("返信")], [true, true, true]);
eq("元の行は変えない", rw.path!.ok, false);
ok("幅あり: ④は良い答えの文とも比べる", bestFinalSim(gw, "かしこまりました！！他の候補も探します") > 0.9);

const _g: GoldParts = g; void _g;
console.log(`parts-eval: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
