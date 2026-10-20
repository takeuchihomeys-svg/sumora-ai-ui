// app/lib/__tests__/reaction-negatives.test.ts — 送った物件への反応・メモ → 判定の弱い減点（LLM なし・作り物の文だけ・お客様の実文は使わない）
// 実行: npx tsx app/lib/__tests__/reaction-negatives.test.ts
import {
  readNegativeAttrs, buildReactionNegatives, reactionCodesFor, reactionRowAdjust, resolveTarget, memoRefOf, reactionsLinkEnabled,
  REACTION_POINTS, REACTION_JA, type RxProp, type RxSend,
} from "../reaction-negatives";
import { assembleReactionInput, propKeyOf } from "../reaction-negatives-server";
import { judgeProperty, buildCustomerProfile, parsePropertyFacts, REASON_POINTS, reasonJa } from "../property-brain";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const attrs = (s: string) => readNegativeAttrs(s).map((x) => `${x.attr}${x.hard ? "!" : ""}`).sort().join(",");

console.log("── 文から不満の向きを読む");
t("お部屋が上過ぎる → floor_high", attrs("お部屋がちょっと上過ぎるかもです") === "floor_high", attrs("お部屋がちょっと上過ぎるかもです"));
t("駅名は上過ぎる＝場所の向き（階にしない）", attrs("テスト駅は上過ぎるかもです") === "", attrs("テスト駅は上過ぎるかもです"));
t("可能性が高いは家賃ではない", attrs("落ちる可能性高いですよね") === "");
t("もう少し安心は家賃ではない", attrs("もう少し安心なところがいいです") === "");
t("番号の条件の列挙は反応ではない", attrs("①未定 ②10万まで ③1LDK 駅から遠いのは嫌") === "");
t("条件のフォームは反応ではない", attrs("①【ご入居の時期】⇒いつでも ④【築年数】⇒古くない物") === "");
t("高層は怖い → floor_high（家賃の高いにしない）", attrs("高層階はちょっと怖いです") === "floor_high", attrs("高層階はちょっと怖いです"));
t("もう少し低い階 → floor_high", attrs("もう少し低い階がいいです") === "floor_high");
t("狭い → narrow", attrs("お部屋が少し狭いですね") === "narrow");
t("もう少し広め → narrow", attrs("もう少し広めのお部屋があれば") === "narrow");
t("収納が狭いは部屋の広さではない", attrs("収納が狭いですね") === "", attrs("収納が狭いですね"));
t("駅から遠い → far", attrs("駅から少し遠いですね") === "far");
t("職場から遠いは通勤の話（far にしない）", attrs("職場から遠いですね") === "", attrs("職場から遠いですね"));
t("家賃が高い → expensive", attrs("家賃がちょっと高いです") === "expensive");
t("高いですね（物の語なし）→ expensive", attrs("高いですね") === "expensive");
t("初期費用が高いは家賃ではない", attrs("初期費用が高いですね") === "", attrs("初期費用が高いですね"));
t("古い → old", attrs("建物が古そうですね") === "old");
t("質問は不満ではない", attrs("駅から遠いですか？") === "");
t("受け入れは不満ではない", attrs("狭くても大丈夫です") === "", attrs("狭くても大丈夫です"));
t("NG と言った → hard", attrs("5階以上は無理です") === "floor_high!", attrs("5階以上は無理です"));
t("古すぎ無ければ大丈夫（条件の言い方）は不満ではない", attrs("古すぎ無ければ大丈夫") === "", attrs("古すぎ無ければ大丈夫"));
t("安い業者さんは家賃ではない", attrs("もう少し安い業者さんがあります") === "", attrs("もう少し安い業者さんがあります"));
t("予算オーバーでも好み＝受け入れ", attrs("予算オーバーですが、この2つは好みです") === "", attrs("予算オーバーですが、この2つは好みです"));
t("前の道が狭いは部屋の広さではない", attrs("前の道が狭いですね") === "", attrs("前の道が狭いですね"));
t("天井が高いは家賃ではない", attrs("天井が高いですね") === "", attrs("天井が高いですね"));
t("2つの節 → 2つ", attrs("家賃が高いです。あと駅から遠い") === "expensive,far", attrs("家賃が高いです。あと駅から遠い"));

console.log("── どの物件への反応か");
const P = (key: string, o: Partial<RxProp> = {}): RxProp => ({ key, name: key.split("|")[0], floor: null, rentTotal: null, areaSqm: null, walk: null, age: null, ...o });
const A = P("テストハイツ|1001", { floor: 10, rentTotal: 90000, areaSqm: 25, walk: 8, age: 10, imageUrls: ["img-a"] });
const B = P("サンプルコート|302", { floor: 3, rentTotal: 80000, areaSqm: 30, walk: 12, age: 20, imageUrls: ["img-b"] });
t("引用の画像 → その物件", resolveTarget({ conv: "c", at: "", text: "ここ良いです", quotedImageUrl: "img-b" }, [A, B])?.key === B.key);
t("1件だけ → その物件", resolveTarget({ conv: "c", at: "", text: "高いです" }, [A])?.key === A.key);
t("物件名 → その物件", resolveTarget({ conv: "c", at: "", text: "サンプルコートは狭いですね" }, [A, B])?.key === B.key);
t("決まらない → 束（null）", resolveTarget({ conv: "c", at: "", text: "高いですね" }, [A, B]) === null);

console.log("── 送付の後の反応を集める");
const sends: RxSend[] = [{ conv: "c1", at: "2026-10-01T00:00:00Z", props: [A] }, { conv: "c1", at: "2026-10-01T00:10:00Z", props: [B] }];
const st = buildReactionNegatives({
  sends,
  msgs: [
    { conv: "c1", at: "2026-10-01T03:00:00Z", text: "テストハイツは階が上過ぎるかもです" },
    { conv: "c1", at: "2026-10-01T03:01:00Z", text: "全体的に家賃が高いですね" },
    { conv: "c1", at: "2026-10-01T03:02:00Z", text: "サンプルコートは良さそうです！内覧したいです" },
    { conv: "c1", at: "2026-10-09T03:00:00Z", text: "やっぱり狭いですね" }, // 送付から 72時間を過ぎた＝反応にしない
  ],
  now: "2026-10-10T00:00:00Z",
});
const fl = st.negatives.find((x) => x.attr === "floor_high");
t("上過ぎる → 物件の階 10（物件に結んだ）", fl?.ref === 10 && fl?.scope === "property", JSON.stringify(fl));
const ex = st.negatives.find((x) => x.attr === "expensive");
t("束への「高い」→ 束の中央値 85,000（弱い扱い）", ex?.ref === 85000 && ex?.scope === "bundle", JSON.stringify(ex));
t("72時間を過ぎた発言は読まない", !st.negatives.some((x) => x.attr === "narrow"));
t("物件ごとの反応: サンプルコートは前向き", st.perProperty[B.key]?.good === true && !st.perProperty[B.key]?.declined);
t("今より後の発言は使わない（now より後）", buildReactionNegatives({ sends, msgs: [{ conv: "c1", at: "2026-10-01T03:00:00Z", text: "部屋が上過ぎる" }], now: "2026-10-01T02:00:00Z" }).negatives.length === 0);
t("60日より古い反応は使わない", buildReactionNegatives({ sends, msgs: [{ conv: "c1", at: "2026-10-01T03:00:00Z", text: "部屋が上過ぎる" }], now: "2027-01-01T00:00:00Z" }).negatives.length === 0);

console.log("── メモ");
t("メモの数字: 5階", memoRefOf("floor_high", "5階以上は怖い") === 5);
t("メモの数字: 8.5万", memoRefOf("expensive", "家賃は8.5万円までが厳しい") === 85000);
const stM = buildReactionNegatives({ sends: [], msgs: [], memos: [{ kind: "ng", text: "高層階は怖い（7階以上NG）", at: "2026-10-05T00:00:00Z" }, { kind: "asked", text: "家賃が高い", at: "2026-10-05T00:00:00Z" }], now: "2026-10-10T00:00:00Z" });
t("NG のメモ → floor_high 7・hard／聞かれた事のメモは読まない", stM.negatives.length === 1 && stM.negatives[0].ref === 7 && stM.negatives[0].hard, JSON.stringify(stM.negatives));

console.log("── 候補と照らす");
const negs = st.negatives;
t("10階以上・家賃9万 → 階と家賃の減点", reactionCodesFor({ floor: 12, rentTotal: 90000, areaSqm: 25, walk: 5, age: 5 }, negs).join(",") === "REACTION_FLOOR_HIGH_NG,REACTION_EXPENSIVE_NG");
t("3階・家賃7.5万 → 解消の加点", reactionCodesFor({ floor: 3, rentTotal: 75000, areaSqm: 25, walk: 5, age: 5 }, negs).join(",") === "REACTION_FLOOR_HIGH_OK,REACTION_EXPENSIVE_OK");
t("値が分からない → 札なし", reactionCodesFor({ floor: null, rentTotal: null, areaSqm: null, walk: null, age: null }, negs).length === 0);
t("NG と言った向き → HARD", reactionCodesFor({ floor: 8, rentTotal: null, areaSqm: null, walk: null, age: null }, stM.negatives).join(",") === "REACTION_FLOOR_HIGH_HARD");
t("札の点と日本語が全部ある", Object.keys(REACTION_POINTS).every((c) => REASON_POINTS[c] === REACTION_POINTS[c] && !!REACTION_JA[c] && reasonJa(c) === REACTION_JA[c]));

console.log("── 判定（judgeProperty）: 渡さなければ今まで通り・渡すと弱い減点");
const profile = buildCustomerProfile({ rent_max: 100000, floor_plan: "1K" }, [], [], null);
const facts = parsePropertyFacts("【1】テストタワー 1201\n90,000円\n1K\n敷なし 礼なし\nテスト駅 徒歩5分\nAD 2ヶ月");
const j0 = judgeProperty(facts, profile, 0, {});
const jNull = judgeProperty(facts, profile, 0, { reactionNegatives: null });
const jOn = judgeProperty(facts, profile, 0, { reactionNegatives: negs });
t("off（null）は点・札が同じ", j0.score === jNull.score && j0.reasonCodes.join() === jNull.reasonCodes.join());
t("on: 12階・9万 → 階と家賃で −16・通すのまま（弱い扱い）", jOn.score === j0.score - 16 && jOn.verdict === j0.verdict && jOn.reasonCodes.includes("REACTION_FLOOR_HIGH_NG"), `${j0.score}→${jOn.score} ${jOn.verdict}`);
const jHard = judgeProperty(facts, profile, 0, { reactionNegatives: stM.negatives });
t("on: NG と言った向き → 保留（外す候補にはしない）", jHard.verdict === "hold" && jHard.flagCodes.includes("REACTION_FLOOR_HIGH_HARD"), `${jHard.verdict} ${jHard.flagCodes}`);
const lowFacts = parsePropertyFacts("【2】テストハイム 201\n75,000円\n1K\n敷なし 礼なし\nテスト駅 徒歩5分\nAD 2ヶ月");
const jLow = judgeProperty(lowFacts, profile, 0, { reactionNegatives: negs });
t("on: 2階・7.5万 → 解消の加点", jLow.reasonCodes.includes("REACTION_FLOOR_HIGH_OK") && jLow.reasonCodes.includes("REACTION_EXPENSIVE_OK"));

console.log("── 送った物件の中から👑（行の付け直し）");
const row = { score: 120, verdict: "pass", reason_codes: ["RENT_OK"] };
const good = reactionRowAdjust(row, { floor: 3, rentTotal: 80000, areaSqm: 30, walk: 12, age: 20 }, B.key, st);
t("前向きな反応の物件 → 加点", (good.score ?? 0) > 120 && good.reason_codes.includes("REACTION_PROP_GOOD"), JSON.stringify(good));
const declinedSt = buildReactionNegatives({ sends: [{ conv: "c1", at: "2026-10-01T00:00:00Z", props: [A] }], msgs: [{ conv: "c1", at: "2026-10-01T01:00:00Z", text: "こちらは見送りでお願いします" }], now: "2026-10-02T00:00:00Z" });
const dec = reactionRowAdjust(row, { floor: 10, rentTotal: 90000, areaSqm: 25, walk: 8, age: 10 }, A.key, declinedSt);
t("見送った物件 → 減点・保留", dec.verdict === "hold" && dec.reason_codes.includes("REACTION_PROP_DECLINED"), JSON.stringify(dec));
const again = reactionRowAdjust({ ...good }, { floor: 3, rentTotal: 80000, areaSqm: 30, walk: 12, age: 20 }, B.key, st);
t("付け直しは二重に足さない", again.score === good.score, `${good.score} ${again.score}`);

console.log("── 行の組み立て（DB の行 → 入力）");
const asm = assembleReactionInput({
  sentProps: [{ conversation_id: "c9", property_name: "テストハイツ", room_no: "1001", sent_at: "2026-10-01T00:00:00Z", delivery: "customer" }, { conversation_id: "c9", property_name: "共有だけ", room_no: "101", sent_at: "2026-10-01T00:00:00Z", delivery: "shared" }],
  sentImages: [{ conversation_id: "c9", image_url: "img-x", property_name: "テストハイツ", room_no: "1001", created_at: "2026-10-01T00:00:01Z", facts: { rent: 88000, admin_fee_yen: 2000, floor: 10 } }],
  pickups: [{ property_name: "テストハイツ", room_no: "1001", summary_text: "【1】テストハイツ 1001\n88,000円 管理費 2,000円\n1K\n25.5㎡\nテスト駅 徒歩8分\n築10年", created_at: "2026-09-30T00:00:00Z" }],
  msgs: [{ id: "m1", conversation_id: "c9", sender: "staff", text: null, image_url: "img-x", created_at: "2026-10-01T00:00:01Z", quoted_message_id: null },
    { id: "m2", conversation_id: "c9", sender: "customer", text: "階が上過ぎるかも", image_url: null, created_at: "2026-10-01T02:00:00Z", quoted_message_id: "m1" }],
  memos: [],
});
const k = propKeyOf("テストハイツ", "1001").key;
t("共有だけの送付は入れない", asm.sends.every((s) => s.props.every((p) => p.key !== propKeyOf("共有だけ", "101").key)));
t("物件の値（階・家賃＋管理費・徒歩）", asm.sends[0].props[0].key === k && asm.sends[0].props[0].floor === 10 && asm.sends[0].props[0].rentTotal === 90000 && asm.sends[0].props[0].walk === 8, JSON.stringify(asm.sends[0].props[0]));
t("引用の画像を引ける", asm.msgs.length === 1 && asm.msgs[0].quotedImageUrl === "img-x");

console.log("── スイッチ");
t("既定は off", reactionsLinkEnabled({}) === false);
t("on で on", reactionsLinkEnabled({ AIX_REACTIONS_LINK: "on" }) === true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
