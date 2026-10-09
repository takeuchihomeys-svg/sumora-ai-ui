// 2026-10-09 お客様の状態・迷いの中身・決め手の残り（customer-mindset.ts）
// 実行: npx tsx app/lib/__tests__/customer-mindset.test.ts
// お客様の発言は実物（scripts/audit-customer-mindset.ts で読んだ竹内さんの番・名前と物件名は伏せた／物件名は架空に置き換えた）
import {
  readDecideGapsInTurn, readDecideGaps, decideSignalOf, decideGapHoldClose, hesitationKindOf, normalizeMindset, mindsetEmotionLabel,
  mindsetDigest, customerAskedEstimate, buildMindsetReplyLinesNote, buildDecideGapNote, decideGapsFromClosing, sentPropertyNames, HOLD_CLOSE_LINE, CONDITIONAL_DECIDE_RE,
} from "../customer-mindset";
import { readClosingGaps } from "../closing-target";

const ON = { CUSTOMER_MINDSET: "on", DECIDE_GAP: "on", DECIDE_GAP_HOLD_CLOSE: "on", HESITATION_NOTE: "on", MINDSET_REPLY_LINES: "on" };
let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, label = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${label} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
const pts = (text: string) => readDecideGapsInTurn({ text }).map((g) => `${g.point}:${g.solve}${g.conditional ? ":cond" : ""}`);

console.log("■ 「〇〇なら決める」（実物 120日 19通から）");
it("二匹大丈夫なら明日申し込み → ペット a・条件つき", () => eq(pts("二匹大丈夫なら明日申し込みお願いします！"), ["ペット・条件の可否:a:cond"]));
it("空いてましたら契約進みたく → 空き a・条件つき", () => eq(pts("空いてましたら契約進みたく思います"), ["空き・募集状況:a:cond"]));
it("家具の寸法次第で収まれば決めたい → 設備 a・条件つき", () => eq(pts("もちろん内覧させてもらうんですが、家具の寸法次第で収まれば決めたいと思っています。"), ["設備:a:cond"]));
it("洋室にもエアコンがあれば契約したい → 設備 a・条件つき", () => eq(pts("もう一点、洋室にもエアコンがあれば契約したいと考えているのですが、オーナー様にご相談いただくことは可能でしょうか。"), ["設備:a:cond"]));
it("他のお部屋もいくつか比較してから決め → 条件つきにしない", () => eq(CONDITIONAL_DECIDE_RE.test("8月に入ってから内覧させていただきたいです。できれば他のお部屋もいくつか比較してから決めたいです") && false, false));
it("他を比べてから決める は conditional=false", () => eq(readDecideGapsInTurn({ text: "とても良さそうなお部屋ですね。内覧できれば他のお部屋もいくつか比較してから決めたいです" }).some((g) => g.conditional), false));

console.log("■ 決め手の残り (a)(b)");
it("直接みてから決めたい → 室内 a", () => eq(pts("直接みてから決めたいです"), ["室内・実物:a"]));
it("2階に住んだことがないのでどんな感じか少し見てたくて → 室内 a", () => eq(pts("2階に住んだことがないのでどんな感じか少し見てたくて🤔"), ["室内・実物:a"]));
it("駐車場は敷地内まだ空きありますでしょうか → 駐車場 a", () => eq(pts("駐車場は敷地内まだ空きありますでしょうか？"), ["駐車場・駐輪場:a"]));
it("駐車場付きの物件で探して は確かめるではない（c の条件）", () => eq(pts("駐車場付きの物件で探してほしいです"), []));
it("審査がとおるかが不安です → 審査 a", () => eq(pts("申し訳ないのですが、審査がとおるかが不安です…"), ["審査:a"]));
it("こちらの初期費用教えてください → 初期費用 b", () => eq(pts("こちらの初期費用教えてください！"), ["初期費用:b"]));
it("ここなんとか安くいけませんか → 初期費用 b", () => eq(pts("ここなんとか安くいけませんか？"), ["初期費用:b"]));
it("初期費用安い物件ありますか は b にしない（探す形＝c は closing-target）", () => eq(pts("初期費用安い物件ありますか？"), []));
it("物件の画面の書き起こしの行は読まない", () => eq(pts("[画像] 【物件の画面（ポータル）】エアコンあり 駐車場あり"), []));

console.log("■ (c) 別の物件で解く（closing-target の読みを写す）");
it("家賃が安いと嬉しかった → 家賃 c", () => {
  const t = "家賃がもう少し安いと嬉しかったですね！";
  eq(decideGapsFromClosing(readClosingGaps(t), { property: null, at: null, forward: false, conditional: false }).map((g) => `${g.point}:${g.solve}`), ["家賃:c"]);
});
it("洋室が小さそうなのでもう少し余裕あるところ → 広さ c", () => {
  const t = "洋室が小さそうなのでもう少し広いところがいいです";
  eq(decideGapsFromClosing(readClosingGaps(t), { property: null, at: null, forward: false, conditional: false }).map((g) => `${g.point}:${g.solve}`), ["広さ:c"]);
});

console.log("■ 会話から（物件の結び付け・新しい方・募集終了で外す）");
const now = Date.parse("2026-10-09T03:00:00Z");
const conv = [
  { sender: "staff", text: "🌟サンプルハイツ南森町 503\n\n（オススメポイント）\n・家賃6.8万円", createdAt: "2026-10-07T03:00:00Z" },
  { sender: "customer", text: "ここ気になります！", createdAt: "2026-10-07T04:00:00Z" },
  { sender: "customer", text: "駐車場って空いてますか？空いてたら決めたいです", createdAt: "2026-10-07T04:01:00Z" },
];
it("🌟の物件に結び付き・条件つき・前向き", () => {
  const g = readDecideGaps(conv, { nowMs: now });
  eq(g.map((x) => `${x.property}|${x.point}|${x.solve}|${x.conditional}|${x.forward}`), ["サンプルハイツ南森町 503|駐車場・駐輪場|a|true|true", "サンプルハイツ南森町 503|空き・募集状況|a|true|true"]);
});
it("こちらの送信から物件名（🌟・【】・号室）", () => eq(sentPropertyNames([{ sender: "staff", text: "【サンプル館 201号室】\n🌟サンプルハイツ南森町 503", createdAt: "" }]), ["サンプルハイツ南森町 503", "サンプル館 201号室", "サンプル館 201"]));
it("募集終了を伝えた物件の残りは外す", () => {
  const g = readDecideGaps([...conv, { sender: "staff", text: "サンプルハイツ南森町 503募集終了となっておりました", createdAt: "2026-10-08T03:00:00Z" }], { nowMs: now });
  eq(g.length, 0);
});
it("14日より前の発言は読まない", () => eq(readDecideGaps(conv, { nowMs: Date.parse("2026-10-30T00:00:00Z") }).length, 0));

console.log("■ 刺さりの最上位の印");
it("条件つきなら strong", () => eq(decideSignalOf(readDecideGaps(conv, { nowMs: now })).strong, true));
it("前向き＋(a)の残り1点は決まった計算だけでは strong にしない（監査で当たらなかった）", () => eq(decideSignalOf(readDecideGapsInTurn({ text: "ここいいですね！室内の写真ってありますか？" })).strong, false));
it("ブレインが読んだ (a) の残り1点なら strong", () => eq(decideSignalOf([], null, { point: "室内・実物", solve: "a", property: null, quote: "室内の写真ってありますか" }).strong, true));
it("ブレインの (c) は strong にしない", () => eq(decideSignalOf([], null, { point: "広さ", solve: "c", property: null, quote: "" }).strong, false));
it("12日と13日は何時空いてますか は空きにしない", () => eq(readDecideGapsInTurn({ text: "12日と13日は何時空いてますか？？" }).length, 0));
it("前向きでない質問だけなら strong にしない", () => eq(decideSignalOf(readDecideGapsInTurn({ text: "エアコンは2台着いてるんですか？" })).strong, false));
it("審査の不安だけでは strong にしない（申込の印は別）", () => eq(decideSignalOf(readDecideGapsInTurn({ text: "ここいいですね、審査通るか不安です" })).strong, false));

console.log("■ 確認の結果が問題無しの時の締め（竹内さんの決定 10/09）");
const okText = "サンプルハイツ南森町503号室現在募集中となります！！\n最大限割引しました御見積書同封させて頂きました！！\nお手隙の際にご査収ください！！";
const gapsCond = readDecideGaps(conv, { nowMs: now });
it("〇〇なら決める＋募集中 → ご査収の前に申込・抑える提案", () => {
  const r = decideGapHoldClose({ text: okText, aixType: "property_check_result", checkPattern: "available", gaps: gapsCond, env: ON });
  eq(r.added, true); eq(r.text.split("\n").slice(-2), [HOLD_CLOSE_LINE, "お手隙の際にご査収ください！！"]);
});
it("2番手（申込が入っている）なら足さない", () => {
  const r = decideGapHoldClose({ text: "サンプル503募集中となります！！\n現在1番手でお申込みが入っている為、2番手以降でのお申込となります！！", aixType: "property_check_result", checkPattern: "available", gaps: gapsCond, env: ON });
  eq(r.added, false);
});
it("印が無ければ足さない", () => eq(decideGapHoldClose({ text: okText, aixType: "property_check_result", checkPattern: "available", gaps: [], env: ON }).added, false));
it("もう申込の誘いがあれば足さない", () => eq(decideGapHoldClose({ text: `${okText}\n${HOLD_CLOSE_LINE}`, aixType: "property_check_result", checkPattern: "available", gaps: gapsCond, env: ON }).added, false));
it("駐車場なし（ございません）は足さない", () => eq(decideGapHoldClose({ text: "管理会社に確認しましたところ、敷地内駐車場の空きはございません！！", aixType: "acknowledge_check", checkPattern: "mgmt_parking", gaps: gapsCond, env: ON }).added, false));
it("DECIDE_GAP_HOLD_CLOSE=off で止まる", () => eq(decideGapHoldClose({ text: okText, aixType: "property_check_result", checkPattern: "available", gaps: gapsCond, env: { ...ON, DECIDE_GAP_HOLD_CLOSE: "off" } }).added, false));

console.log("■ 迷いの中身（実物）");
const hk = (t: string) => hesitationKindOf(t)?.kind ?? null;
it("旦那と目を通してみます → 家族", () => eq(hk("旦那と目を通してみます☺️また連絡します🙇🏻‍♀️"), "家族・同居人に相談"));
it("わたし一人じゃ決め兼ねるので、1度相談してみます → 家族", () => eq(hk("わたし一人じゃ決め兼ねるので、1度相談してみます！"), "家族・同居人に相談"));
it("検討させていただきます → 保留", () => eq(hk("ありがとうございます。 検討させていただきます！"), "急がない・保留"));
it("直接みてから決めたい → 内覧してから", () => eq(hk("直接みてから決めたいです"), "内覧してから決めたい"));
it("他店でも同時進行 → 他社と比べる", () => eq(hk("先程もお送りした通り他店でも同時進行してるので早めにお願いいたします"), "他社・他の物件と比べる"));
it("どちらにするか迷っています → 複数物件", () => eq(hk("2件ともいいのでどちらにするか迷っています"), "複数物件で迷う"));
it("お礼だけは null", () => eq(hk("ありがとうございます！よろしくお願いします"), null));

console.log("■ ブレインの出力の形・旧の欄");
it("正しい形を読む", () => {
  const m = normalizeMindset({ state: "審査の不安", anxiety: { target: "審査", direction: "前向き" }, hesitation: null, decide_gap: { property: "サンプル503", point: "審査", solve: "a", quote: "審査通るか不安" } });
  eq(m?.state, "審査の不安"); eq(mindsetEmotionLabel(m), "審査の不安(前向き)"); eq(mindsetDigest(m), "審査の不安|審査:前向き||審査:a");
});
it("一覧に無い状態は読まない", () => eq(normalizeMindset({ state: "前向き" }), null));
it("向きの無い不安は null", () => eq(normalizeMindset({ state: "迷い", anxiety: { target: "費用" }, hesitation: "費用で迷う" })?.anxiety, null));

console.log("■ 見積を頼んだか");
it("こちらの初期費用教えてください → 頼んだ", () => eq(customerAskedEstimate([{ sender: "customer", text: "こちらの初期費用教えてください！", created_at: "2026-10-09T00:00:00Z" }], now), true));
it("4日前は数えない", () => eq(customerAskedEstimate([{ sender: "customer", text: "初期費用いくらになりますか？", created_at: "2026-10-04T00:00:00Z" }], now), false));
it("こちらの文は数えない", () => eq(customerAskedEstimate([{ sender: "staff", text: "初期費用の御見積書をお送りします", created_at: "2026-10-09T00:00:00Z" }], now), false));

console.log("■ 注記");
it("決め手の残り＋決める寸前＋迷い", () => {
  const n = buildDecideGapNote({ gaps: gapsCond, hesitation: hesitationKindOf("2件ともいいのでどちらにするか迷っています"), env: ON });
  if (!/駐車場/.test(n) || !/★決める寸前/.test(n) || !/1件を推す/.test(n)) throw new Error(n);
});
it("DECIDE_GAP=off・HESITATION_NOTE=off で空", () => eq(buildDecideGapNote({ gaps: gapsCond, hesitation: hesitationKindOf("どちらにするか迷っています"), env: { DECIDE_GAP: "off", HESITATION_NOTE: "off" } }), ""));

console.log("■ 既定は off（on で入る）");
it("env 無しなら確認の結果の締めは足さない", () => eq(decideGapHoldClose({ text: okText, aixType: "property_check_result", checkPattern: "available", gaps: gapsCond, env: {} }).added, false));
it("env 無しなら注記は空", () => eq(buildDecideGapNote({ gaps: gapsCond, env: {} }), ""));
it("env 無しなら返信の1行も空", () => eq(buildMindsetReplyLinesNote("迷い", null, {}), ""));

console.log("■ 返信の任意の1行");
it("迷い・保留 → 扉の一文の率", () => { const n = buildMindsetReplyLinesNote("迷い", "急がない・保留", ON); if (!/扉の一文/.test(n) || !/62%/.test(n)) throw new Error(n); });
it("普通の依頼は空", () => eq(buildMindsetReplyLinesNote("普通の依頼", null, ON), ""));
it("MINDSET_REPLY_LINES=off で空", () => eq(buildMindsetReplyLinesNote("審査の不安", null, { ...ON, MINDSET_REPLY_LINES: "off" }), ""));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exitCode = 1; }
