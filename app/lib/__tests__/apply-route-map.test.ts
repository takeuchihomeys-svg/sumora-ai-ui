// 2026-10-20 申込までの地図（app/lib/apply-route-map.ts）の単体試験。LLM・DB なし。
// 実行: npx tsx app/lib/__tests__/apply-route-map.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  locateApplyRoute, resolveRouteNode, buildApplyRouteBrainText, applyRouteBrainTextIfEnabled, applyRouteMapEnabled,
  ROUTE_NODES, ROUTE_BRANCHES, MAIN_ROUTE, APPLY_ROUTE_TEXT_MAX, SILENT_DAYS, type ApplyRouteSignals,
} from "../apply-route-map";
import { rankMentionOf, latestRankMention } from "../parallel-second";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, msg = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); }
function ok(c: unknown, msg: string) { if (!c) throw new Error(msg); }

const NOW = Date.parse("2026-10-20T03:00:00Z");
const base = (o: Partial<ApplyRouteSignals>): ApplyRouteSignals => ({ stage: "proposing", nowMs: NOW, ...o });

console.log("地図のデータ");
it("本線の駅は全部 ROUTE_NODES にあり、nextNode が本線の次を指す", () => {
  for (let i = 0; i < MAIN_ROUTE.length - 1; i++) eq(ROUTE_NODES[MAIN_ROUTE[i]].nextNode, MAIN_ROUTE[i + 1], MAIN_ROUTE[i]);
});
it("分かれ道は全部 意味・次の一手・戻り方を持つ", () => {
  for (const b of Object.values(ROUTE_BRANCHES)) { ok(b.meaning && b.next.label && b.wayBack.how, b.id); if (b.wayBack.to) ok(ROUTE_NODES[b.wayBack.to], `${b.id} wayBack`); }
});

console.log("本線の位置");
it("段階が無ければ unknown（node=null・next=null）", () => { const l = locateApplyRoute(base({ stage: null })); eq([l.node, l.branch, l.next], [null, null, null]); });
it("初回→問い合わせ・次は条件ヒアリング（condition_hearing）", () => { const l = locateApplyRoute(base({ stage: "first" })); eq(l.node, "inquiry"); eq(l.next?.aix, ["condition_hearing"]); });
it("物件検索中で送付も約束も無い→条件ヒアリング", () => eq(resolveRouteNode({ stage: "searching", ledger: { propertiesSentCount: 0, pickupPromisedUnfulfilled: false, estimateSent: false, conditionAsked: true } }).node, "hearing"));
it("物件検索中で探す約束あり→ピックアップ（property_send）", () => {
  const l = locateApplyRoute(base({ stage: "searching", ledger: { propertiesSentCount: 0, pickupPromisedUnfulfilled: true, estimateSent: false, conditionAsked: false } }));
  eq(l.node, "pickup"); eq(l.next?.aix, ["property_send"]);
});
it("見積送付済み→見積・次は内覧のご案内", () => { const l = locateApplyRoute(base({ stage: "estimate_sent" })); eq(l.node, "estimate"); eq(l.next?.aix, ["viewing_invite"]); });
it("内覧後→申込へ（application_push）", () => eq(locateApplyRoute(base({ stage: "viewed" })).next?.aix, ["application_push"]));

console.log("分かれ道");
it("他社物件の持ち込み（型 brought_property）→ 物件確認した・戻りは気に入った物件あり", () => {
  const l = locateApplyRoute(base({ routeType: "brought_property", customerTurnText: "https://suumo.jp/x" }));
  eq(l.branch, "brought_property"); eq(l.next?.aix, ["property_check_result"]); eq(l.wayBack?.to, "interested"); eq(l.node, "proposing");
});
it("他社で内覧の予定（other-agent-viewing を再利用）", () => eq(locateApplyRoute(base({ customerTurnText: "他社さんで内見の予定あって、一度そっちで内見だけしてこようかなと思ってるんですが大丈夫でしょうか？？" })).branch, "other_agent_viewing"));
it("相見積もり", () => eq(locateApplyRoute(base({ stage: "estimate_sent", customerTurnText: "他社さんの見積の方が安かったです" })).branch, "competing_estimate"));
it("審査の相談（型 screening_question）", () => eq(locateApplyRoute(base({ routeType: "screening_question" })).branch, "screening_concern"));
const SENT = { propertiesSentCount: 3, pickupPromisedUnfulfilled: false, estimateSent: false, conditionAsked: false };
it("条件変更（物件を送った後の型 condition_feedback）→ 戻りはピックアップ", () => { const l = locateApplyRoute(base({ routeType: "condition_feedback", ledger: SENT })); eq(l.branch, "condition_change"); eq(l.wayBack?.to, "pickup"); });
it("物件を送る前の条件のやり取りは分かれ道にしない（本線のヒアリング）", () => eq(locateApplyRoute(base({ stage: "searching", routeType: "condition_feedback" })).branch, null));
it("初回の条件のフォーム（first×condition_feedback）→ 条件ヒアリング・次は物件ピックアップした", () => {
  const l = locateApplyRoute(base({ stage: "first", routeType: "condition_feedback" })); eq([l.node, l.branch], ["hearing", null]); eq(l.next?.aix, ["property_send"]);
});
it("申込以降は条件変更・音信不通の分かれ道を開かない", () => {
  eq(locateApplyRoute(base({ stage: "applying", routeType: "condition_feedback" })).branch, null);
  eq(locateApplyRoute(base({ stage: "applying", lastStaffAtIfStaffLast: new Date(NOW - 30 * 86_400_000).toISOString() })).branch, null);
});
it("すぐ来られない（holdFirstReason の文）→ 申込で抑える", () => eq(locateApplyRoute(base({ stage: "interested", holdReason: "遠方のお客様" })).branch, "cannot_come_soon"));
it("入居時期が先（来年・2か月以上先の月）／今月・来月は当てない", () => {
  eq(locateApplyRoute(base({ customerTurnText: "入居は来年の3月頃を考えています" })).branch, "move_in_later");
  eq(locateApplyRoute(base({ customerTurnText: "入居は1月中旬希望です" })).branch, "move_in_later");
  eq(locateApplyRoute(base({ customerTurnText: "ご入居の時期 10月下旬" })).branch, null);
  eq(locateApplyRoute(base({ customerTurnText: "入居は11月末までに" })).branch, null);
});
it("審査の不安の申告（問いの形でない）→ 審査の相談", () => eq(locateApplyRoute(base({ customerTurnText: "クレカブラックなのと、夜職なので給料明細だせませんが💦" })).branch, "screening_concern"));
it("番手: 案内の後は rank_offered・申込んだ後は rank_waiting・1番手／受け付けていない／保証会社の2番手は当てない（2026-10-21）", () => {
  eq(locateApplyRoute(base({ stage: "interested", recentStaffTexts: ["現在2番手でのお申込みとなります"] })).branch, "rank_offered");
  eq(locateApplyRoute(base({ stage: "interested", recentStaffTexts: ["よろしければ2番手でお申し込みさせて頂き、並行してお部屋探しさせて頂きます"] })).branch, "rank_offered");
  eq(locateApplyRoute(base({ stage: "interested", recentStaffTexts: ["お気に召されましたら2番手でお部屋お申込みさせて頂きます!!"] })).branch, "rank_offered");
  eq(locateApplyRoute(base({ stage: "interested", recentStaffTexts: ["アーバン西九条201号室、2番手でお申込みさせて頂きます!!"] })).branch, "rank_waiting");
  eq(locateApplyRoute(base({ stage: "interested", recentStaffTexts: ["1番手でお申込み可能です"] })).branch, null);
  eq(locateApplyRoute(base({ stage: "interested", recentStaffTexts: ["お申込みが既に入っており2番手申込み受け付けていないとのことです!!"] })).branch, null);
  eq(locateApplyRoute(base({ stage: "interested", recentStaffTexts: ["・2番手保証会社日本セーフティ(独立系)"] })).branch, null);
  // 一番新しい番手の話で決める（案内 → 申込んだ）
  eq(locateApplyRoute(base({ stage: "interested", recentStaffTexts: ["2番手にてお申し込み完了しております!!", "現在お申込みが入っており、2番手でのお申込みが可能となっております!!"] })).branch, "rank_waiting");
  ok(ROUTE_BRANCHES.rank_offered.next.aix.includes("application_push") && !ROUTE_BRANCHES.rank_waiting.next.aix.includes("application_push"), "申込んだ後に申込を勧めない");
});
it("番手: 2番手で申込中（1つの判定）は申込の段階でも rank_waiting・申込の段階の文だけでは開かない", () => {
  eq(locateApplyRoute(base({ stage: "applying", parallelSecond: true })).branch, "rank_waiting");
  eq(locateApplyRoute(base({ stage: "applying", recentStaffTexts: ["2番手にてお申し込み完了しております!!"] })).branch, null);
  eq(locateApplyRoute(base({ stage: "won", parallelSecond: true })).branch, null);
});
it("番手の文の読み分け（2026-10-22 独立レビュー）: 待つ形は勧めの語があっても申込んだ・保証会社の並び・受け付けていない・終わりにしない形", () => {
  // (1) 繰り上がりの連絡を待つ形は勧め・問いの語があっても applied
  eq(rankMentionOf("2番手で繰り上がりのご連絡を待ちながら、並行してお部屋探しするのがオススメです!!"), "applied");
  eq(rankMentionOf("繰り上がり連絡がございましたら審査開始となりますので、それまで他のお部屋も見てみませんか？"), "applied");
  eq(rankMentionOf("現在2番手で審査開始待ちの状態ですが、よろしければ他もお探ししましょうか"), "applied");
  eq(rankMentionOf("繰り上がり待ちの間に、他のお部屋も如何でしょうか"), "applied");
  eq(rankMentionOf("よろしければ2番手でお申し込みさせて頂き、並行してお部屋探しさせて頂きます"), "offered");
  // (2) 保証会社の並び
  eq(rankMentionOf("1番手：全保連\n2番手：日本セーフティ"), null);
  eq(rankMentionOf("2番手は信販系のオリコになります"), null);
  // (3) 受け付けていない
  eq(rankMentionOf("2番手のお申込みは出来ずとのことです"), "unavailable");
  eq(rankMentionOf("1番手の審査中のため2番手のお申込みストップとのことです"), "unavailable");
  eq(rankMentionOf("現在2番手申込停止中です"), "unavailable");
  // (4) 終わりにしない（割合・可能性・流れの説明）
  eq(rankMentionOf("2番手でも繰り上がりました割合は3割ほどです"), "offered");
  eq(rankMentionOf("1番手がキャンセルの場合は2番手に繰り上がる形となります"), "offered");
  eq(rankMentionOf("無事1番手に繰り上がりました!!"), "ended");
  eq(rankMentionOf("204号室は1番手の方がご契約となりますので、お客様の2番手お申込みがキャンセルとなっております"), "ended");
  // 案内の後にこちらが別の中身を送っていれば案内の場面は過ぎた（q004）・画像だけは数えない・申込んだは続く
  eq(latestRankMention(["現在募集中のお部屋で全てピックアップさせて頂きました！！お気に召されたお部屋お申込み可能です！！", "[画像]", "1001号室は現在既に1番手のお申込が入っており、お申込される場合は2番手以降でのご案内となります！！"]), null);
  eq(latestRankMention(["[画像]", "[画像]", "現在2番手でのお申込みとなります"]), "offered");
  eq(latestRankMention(["ピックアップさせて頂きました", "2番手にてお申し込み完了しております!!"]), "applied");
  // お客様が番手のことを聞いている時は、後に別の中身があっても案内の場面のまま（独立レビュー 365日）
  eq(latestRankMention(["12階のお部屋は募集が終了しております!!", "13階のお部屋は1番手のお申込みが入っており、2番手でのお申込となります!!"], "13階は何人待ちですか？"), "offered");
  eq(latestRankMention(["ピックアップさせて頂きました", "既に1番手のお申込が入っておりますので、お申込頂ける場合は2番手以降でのご案内となります!!"], "1つ目の物件だと、別の方が契約しない場合いつ入居可能ですか？"), "offered");
  eq(latestRankMention(["ピックアップさせて頂きました", "既に1番手のお申込が入っておりますので、お申込頂ける場合は2番手以降でのご案内となります!!"], "こちらの物件の詳細希望です"), null);
  // 申込んだ判定は isApplied2ndText と同じ1文の規則（main の 3番手・可能性）
  eq(rankMentionOf("1番手に上がる可能性ございますので、3番手でお申込させて頂きます"), "applied");
});
it("新着待ち（searching.reason=watch_promised）", () => {
  const l = locateApplyRoute(base({ stage: "searching", searching: { active: true, reason: "watch_promised" } }));
  eq(l.node, "pickup"); eq(l.branch, "new_arrival_wait");
});
it(`音信不通（こちらが最後・${SILENT_DAYS}日以上）・6日は当てない`, () => {
  eq(locateApplyRoute(base({ lastStaffAtIfStaffLast: new Date(NOW - 8 * 86_400_000).toISOString() })).branch, "silent");
  eq(locateApplyRoute(base({ lastStaffAtIfStaffLast: new Date(NOW - 6 * 86_400_000).toISOString() })).branch, null);
});
it("見送り（段階 dropped）・延期（型 postpone_cancel）・検討（considering）", () => {
  const d = locateApplyRoute(base({ stage: "dropped" })); eq([d.node, d.branch], [null, "declined"]);
  eq(locateApplyRoute(base({ routeType: "postpone_cancel" })).branch, "postponed");
  eq(locateApplyRoute(base({ routeType: "considering" })).branch, "considering");
});
it("見送りは他の合図より先（他で決まった＋持ち込みの語）", () => eq(locateApplyRoute(base({ routeType: "decided_elsewhere", customerTurnText: "他社の見積で決まりました" })).branch, "declined"));

it("farMoveIn を渡した時は決まった線（farMoveInTurn）だけで入居時期が先を開く（語の網は使わない）", () => {
  eq(locateApplyRoute(base({ customerTurnText: "入居は来年の3月頃を考えています", farMoveIn: false })).branch, null);
  eq(locateApplyRoute(base({ customerTurnText: "よろしくお願いします", farMoveIn: true })).branch, "move_in_later");
});
it("審査の相談の候補は 保証会社について／物件確認した（10/20 の決定）", () => eq(locateApplyRoute(base({ routeType: "screening_question" })).next?.aix, ["guarantor_info", "property_check_result"]));

console.log("材料の文とスイッチ");
it("文は600字以内・今どこに［］・分かれ道と戻り方を含む", () => {
  for (const b of Object.keys(ROUTE_BRANCHES)) {
    const t = buildApplyRouteBrainText({ ...locateApplyRoute(base({ stage: "viewing_arranging" })), branch: b as never, wayBack: ROUTE_BRANCHES[b as keyof typeof ROUTE_BRANCHES].wayBack, next: ROUTE_BRANCHES[b as keyof typeof ROUTE_BRANCHES].next });
    ok(t.length <= APPLY_ROUTE_TEXT_MAX, `${b} ${t.length}`);
    ok(t.includes("［内覧調整］") && t.includes("本線への戻り方"), b);
  }
});
it("位置が分からない時は空文字", () => eq(buildApplyRouteBrainText(locateApplyRoute(base({ stage: null }))), ""));
it("スイッチ: 既定 on（2026-10-22 試験 p12-arm-on で悪化なし）・off だけで止める → off は空文字・loc=null", () => {
  for (const env of [{ APPLY_ROUTE_MAP: "off" }, { APPLY_ROUTE_MAP: " OFF " }]) {
    eq(applyRouteMapEnabled(env), false);
    const r = applyRouteBrainTextIfEnabled(base({ stage: "estimate_sent" }), env);
    eq([r.text, r.loc], ["", null]);
  }
  for (const env of [{}, { APPLY_ROUTE_MAP: "on" }, { APPLY_ROUTE_MAP: "" }]) {
    eq(applyRouteMapEnabled(env), true);
    ok(applyRouteBrainTextIfEnabled(base({ stage: "estimate_sent" }), env).text.includes("申込までの地図"), "on");
  }
});
it("brain-core: off の時プロンプトは同じ（applyRouteText は '' で始まり、on の分岐の中でだけ代入・差し込みは user の毎回変わる並びだけ）", () => {
  const src = readFileSync(join(__dirname, "..", "brain-core.ts"), "utf8").replace(/\r\n/g, "\n");
  ok(src.includes('let applyRouteText = "";\n  if (applyRouteMapEnabled()) {'), "初期値と分岐");
  const assigns = src.match(/applyRouteText\s*=[^=]/g) ?? [];
  eq(assigns.length, 2, "代入は初期化と分岐の中の2つ");
  const uses = src.match(/\$\{applyRouteText\}/g) ?? [];
  eq(uses.length, 2, "差し込みは customerSpecificText の2つの形だけ");
  // 差し込みを外すと main と同じ並び（system・会話専用ブロックには入れていない）
  const sysStart = src.indexOf("export function buildBrainSystemBlocks"), sysEnd = src.indexOf("export function brainRequestBase");
  ok(!src.slice(sysStart, sysEnd).includes("applyRoute"), "system ブロックに入れない");
  const freshA = src.indexOf("const freshStableA"), cst = src.indexOf("const customerSpecificText");
  ok(!src.slice(freshA, cst).includes("applyRoute"), "会話専用ブロック A/B に入れない");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
