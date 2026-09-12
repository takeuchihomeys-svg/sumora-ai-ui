// 2026-09-12 竹内方針「AIX のセットはブレインが判断する」段1: 決定論の場面の証拠（detectAixSceneEvidence）と
// 本文の安全（resolveBodySafety）・分析モード判定（decideAnalysisMode）の回帰テスト。
// S1〜S5 の検出11ケースは aix-reply-set.test.ts（2c86c209）から期待値を変えずに移した（場面の検出は判断ではなく証拠になった）。
// 実行: npx tsx app/lib/__tests__/aix-scene-evidence.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { detectAixSceneEvidence, customerRequestedPropertyCheck, type SceneEvidenceInput } from "../aix-scene-evidence";
import { resolveBodySafety } from "../aix-reply-set";
import { decideAnalysisMode, type AnalysisModeInput } from "../brain-analysis-mode";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}
const base = (o: Partial<SceneEvidenceInput>): SceneEvidenceInput => ({ latestCustomerTurn: "", hasCustomerImage: false, ...o });
const ev = (o: Partial<SceneEvidenceInput>) => detectAixSceneEvidence(base(o));
const safety = (o: Partial<SceneEvidenceInput>) => resolveBodySafety(ev(o), base(o));

describe("場面の証拠 S1〜S5（2c86c209 の期待値のまま）", () => {
  it("S1 11c492f7「どの部屋が今ところ空室ですか？」→ property_check_result（after_confirm）", () => {
    const x = ev({ latestCustomerTurn: "どの部屋が今ところ空室ですか？" });
    expect(x?.candidateAction).toBe("property_check_result"); expect(x?.timing).toBe("after_confirm"); expect(x?.scene).toBe("S1_vacancy");
  });
  it("S1 送付物件への指示語＋空き質問 → S1", () => {
    expect(ev({ latestCustomerTurn: "さっきのお部屋まだ空いてますか？", sentPropertyCount: 3 })?.scene).toBe("S1_vacancy");
  });
  it("S1 URL＋空室語（旧 P0）→ property_check_result", () => {
    expect(ev({ latestCustomerTurn: "https://suumo.jp/chintai/xx/ ここ空いてますか" })?.candidateAction).toBe("property_check_result");
  });
  it("S2「この物件の最短入居可能日はいつですか？」→ mgmt_move_in（本文の安全に MOVEIN_DATE_ASSERTION）", () => {
    const o = { latestCustomerTurn: "この物件の最短入居可能日はいつですか？" };
    expect(ev(o)?.checkPattern).toBe("mgmt_move_in"); expect(safety(o)?.forbidden.includes("MOVEIN_DATE_ASSERTION")).toBe(true);
  });
  it("S2 退去予定の物件 → vacate_date", () => {
    expect(ev({ latestCustomerTurn: "この物件いつから住めますか？", propertyStatus: "move_out_scheduled" })?.checkPattern).toBe("vacate_date");
  });
  it("S3 物件ありの審査質問 → mgmt_guarantor", () => {
    expect(ev({ latestCustomerTurn: "この物件って審査厳しいですか？" })?.checkPattern).toBe("mgmt_guarantor");
  });
  it("S3 物件が特定できない審査不安（096825c8 型の一般論）→ null", () => {
    expect(ev({ latestCustomerTurn: "現在大学4年生で内定があります。審査通りますか？" })).toBe(null);
  });
  it("S4 82e2d5cf「明日ってまだ空いてますか？彼氏がいけるみたい」→ viewing_invite", () => {
    expect(ev({ latestCustomerTurn: "明日ってまだ空いてますか？彼氏がいけるみたいで" })?.candidateAction).toBe("viewing_invite");
  });
  it("S4「拝見したいです」→ viewing_invite", () => expect(ev({ latestCustomerTurn: "メロディハイムの別の部屋も拝見したいです" })?.candidateAction).toBe("viewing_invite"));
  it("S5「9/9の15時からお願いします！」＋viewing_invite 履歴 → meeting_place（bridge=null）", () => {
    const o = { latestCustomerTurn: "9/9の15時からお願いします！", aixHistory: [{ aix_type: "viewing_invite" }] };
    expect(ev(o)?.candidateAction).toBe("meeting_place"); expect(safety(o)?.bridge).toBe(null); expect(ev(o)?.timing).toBe("now");
  });
  it("S5 viewing_invite 履歴なしの時刻指定 → meeting_place にしない", () => {
    expect(ev({ latestCustomerTurn: "9/9の15時からお願いします！" })?.candidateAction === "meeting_place").toBe(false);
  });
});

describe("本文の安全（resolveBodySafety）", () => {
  it("S1/S2/S3 は確認約束の根拠になる", () => {
    expect(safety({ latestCustomerTurn: "この物件まだ空いてますか？" })?.confirmationBasis).toBe("property_check_result");
    expect(safety({ latestCustomerTurn: "この物件って審査厳しいですか？" })?.confirmationBasis).toBe("property_check_result");
  });
  it("S4 内覧は確認約束の根拠にならない", () => {
    expect(safety({ latestCustomerTurn: "メロディハイムの別の部屋も拝見したいです" })?.confirmationBasis).toBe(null);
  });
  it("証拠なし → null", () => expect(safety({ latestCustomerTurn: "ありがとうございます" })).toBe(null));
});

const modeBase = (o: Partial<AnalysisModeInput>): AnalysisModeInput => ({
  hasCachedMeta: true, totalMsgCount: 40, isFullBypass: false, isIncrementalBypass: false,
  hoursSinceLastFull: 1, hoursSinceLastMsg: 1, msgsSinceDeep: 5, msgsSinceLastFull: 2,
  latestCustomerText: "ありがとうございます", latestCustomerMsgAt: "2026-09-12T10:00:00Z",
  prevAnalyzedMsgTs: "2026-09-12T09:00:00Z", prevAction: "", sentPropertyCount: 0, ...o,
});

describe("分析モード判定（decideAnalysisMode）", () => {
  it("新しい顧客発言に場面の証拠 → incremental に格上げ", () => {
    const x = decideAnalysisMode(modeBase({ latestCustomerText: "この物件まだ空いてますか？" }));
    expect(x.mode).toBe("incremental"); expect(x.upgradeReason).toBe("scene_evidence:S1_vacancy");
  });
  it("前回 action あり＋新しい顧客発言 → incremental（前の AIX 判断を見直す）", () => {
    const x = decideAnalysisMode(modeBase({ prevAction: "viewing_invite" }));
    expect(x.mode).toBe("incremental"); expect(x.upgradeReason).toBe("prev_action:viewing_invite");
  });
  it("証拠なし・前回 action なし → cached", () => expect(decideAnalysisMode(modeBase({})).mode).toBe("cached"));
  it("前回の分析が今回の顧客発言を見ている → 格上げしない", () => {
    expect(decideAnalysisMode(modeBase({ prevAction: "viewing_invite", prevAnalyzedMsgTs: "2026-09-12T10:00:00Z" })).mode).toBe("cached");
  });
  it("既存の full 条件（メッセージ数<11）はそのまま", () => expect(decideAnalysisMode(modeBase({ totalMsgCount: 5 })).mode).toBe("full"));
  it("既存の incremental 条件（10件以上）はそのまま（upgradeReason なし）", () => {
    const x = decideAnalysisMode(modeBase({ msgsSinceLastFull: 10 }));
    expect(x.mode).toBe("incremental"); expect(x.upgradeReason).toBe(null);
  });
  // 2026-09-12 竹内（あや事例・G2）: 「URL」→「こちらです！」の分割送信。最後の1通だけでは物件の到着が見えず cached になっていた
  it("あや: 未返信の連投（URL＋こちらです！）で判定 → 物件が届いた＝incremental", () => {
    const x = decideAnalysisMode(modeBase({ latestCustomerText: "https://www.homes.co.jp/chintai/room/0990651/\nこちらです！" }));
    expect(x.mode).toBe("incremental"); expect(x.upgradeReason).toBe("scene_evidence:S1_vacancy");
  });
  it("連投に画像がある（latestTurnHasImage）→ 物件の画像として格上げ", () => {
    const x = decideAnalysisMode(modeBase({ latestCustomerText: "こちらです！", latestTurnHasImage: true }));
    expect(x.mode).toBe("incremental");
  });
});

describe("内覧の別日程（2026-09-12 竹内・愛乃事例: 内覧日調整を送った後 → AIX 内覧日調整）", () => {
  const afterInvite = { aixHistory: [{ aix_type: "viewing_invite" }] };
  it("「それ以外だと何日になりますか？」→ S4 viewing_date_alternative", () => {
    const x = ev({ latestCustomerTurn: "それ以外だと何日になりますか？", ...afterInvite });
    expect(x?.scene).toBe("S4_viewing"); expect(x?.reasonCode).toBe("viewing_date_alternative"); expect(x?.candidateAction).toBe("viewing_invite");
  });
  it("「土日は可能ですか？」→ 内覧日調整", () => expect(ev({ latestCustomerTurn: "土日は可能ですか？", ...afterInvite })?.reasonCode).toBe("viewing_date_alternative"));
  it("「来週でご都合いい日ってありますか？？」→ 内覧日調整", () => expect(ev({ latestCustomerTurn: "すいません今週実家に帰るので、、 来週でご都合いい日ってありますか？？", ...afterInvite })?.reasonCode).toBe("viewing_date_alternative"));
  it("「土日でも大丈夫ですか」は条件変更（S7）ではなく内覧日調整", () => expect(ev({ latestCustomerTurn: "土日でも大丈夫ですか？", ...afterInvite })?.scene).toBe("S4_viewing"));
  it("具体的な日時＋依頼「14日の16:00でお願いしたいです」→ 待ち合わせ（S5）のまま", () => expect(ev({ latestCustomerTurn: "では14日の16:00でお願いしたいです！", ...afterInvite })?.scene).toBe("S5_time_spec"));
  it("エリアの「〜以外」は内覧の別日程にしない（内覧日調整を送った後でも）", () => {
    expect(ev({ latestCustomerTurn: "平野区加美駅付近以外で大阪市内の物件を教えてほしいです", ...afterInvite })?.reasonCode === "viewing_date_alternative").toBe(false);
  });
  it("提示日の受諾「明日ってまだ空いてますか？…お願いしたいです」は内覧の別日程にしない（実データの次は待ち合わせ）", () => {
    expect(ev({ latestCustomerTurn: "明日ってまだ空いてますか？ 私行けないんですけど彼氏がいけるみたいでお願いしたいです！", ...afterInvite })?.reasonCode === "viewing_date_alternative").toBe(false);
  });
  it("内覧日調整を送る前は「土日は可能ですか？」でも内覧の別日程にしない", () => expect(ev({ latestCustomerTurn: "土日は可能ですか？" })?.reasonCode === "viewing_date_alternative").toBe(false));
});

describe("物件確認の依頼（2026-09-12 竹内: 物件確認したはお客様から依頼があった時だけ）", () => {
  const S = (text: string) => ({ sender: "staff", text });
  const C = (text: string) => ({ sender: "customer", text });
  const req = (msgs: { sender: string; text: string }[]) => customerRequestedPropertyCheck({ recentMessages: msgs });
  it("こちらが物件を送っただけ（お客様の発言は条件の話）→ 依頼なし", () => {
    expect(req([C("梅田周辺で1LDKを探しています"), S("かしこまりました！！ピックアップさせて頂きます！！"), S("https://suumo.jp/chintai/bc_1/ ご査収ください")])).toBe(false);
  });
  it("見積書を送っただけ → 依頼なし", () => {
    expect(req([C("ありがとうございます"), S("[画像]"), S("最大限割引しました初期費用の御見積書となります！！")])).toBe(false);
  });
  it("お客様が物件URLを送った → 依頼あり（スタッフの受付文の後でも、応えている相手の発言で判定）", () => {
    expect(req([C("https://suumo.jp/chintai/bc_100505635971/ こちら空いてますか？"), S("募集状況確認させて頂きます！！")])).toBe(true);
  });
  it("送付物件への指示語＋空き質問 → 依頼あり", () => {
    expect(req([S("https://suumo.jp/chintai/bc_2/"), C("2件目のお部屋まだ募集してますか？")])).toBe(true);
  });
  it("物件画像だけ送ってきた → 依頼あり", () => {
    expect(req([S("ご希望条件お聞かせください"), C("[画像]")])).toBe(true);
  });
  it("この物件の入居日の質問 → 依頼あり（S2）", () => {
    expect(req([S("https://suumo.jp/chintai/bc_3/"), C("この物件はいつから入居できますか？")])).toBe(true);
  });
  it("前向きな返事だけ（ありがとうございます）→ 依頼なし", () => {
    expect(req([S("https://suumo.jp/chintai/bc_4/"), C("ありがとうございます！")])).toBe(false);
  });
  it("この物件の初期費用の依頼 → 依頼あり（実例: こちらの物件も初期費用見て頂くことは可能でしょうか）", () => {
    expect(req([S("https://suumo.jp/chintai/bc_5/"), C("こちらの物件も初期費用見て頂くことは可能でしょうか？？")])).toBe(true);
  });
  it("じゅにあ事例: 「何件か気になる物件送ってもいいですか？」＝自分で送る予告 → 依頼なし・場面の証拠なし", () => {
    expect(req([S("https://suumo.jp/chintai/bc_6/"), C("何件か気になる物件送ってもいいですか？")])).toBe(false);
    expect(ev({ latestCustomerTurn: "何件か気になる物件送ってもいいですか？", sentPropertyCount: 2 })).toBe(null);
  });
  it("予告と一緒に URL が届いた → 依頼あり（届いた物件は確認する）", () => {
    expect(req([S("ご希望条件お聞かせください"), C("気になる物件送ります https://suumo.jp/chintai/bc_7/")])).toBe(true);
  });
  it("物件の探索依頼（特定の物件を指していない）→ 依頼なし", () => {
    expect(req([S("はじめまして"), C("梅田周辺のマンションで初期費用安い物件教えてください")])).toBe(false);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
