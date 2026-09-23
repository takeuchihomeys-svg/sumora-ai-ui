// 「申込の一文」を率で渡して選ばせる入口のテスト（自己完結ハーネス）
// 2026-09-23 竹内「実際の成約データや直近のLINEを参考にずれをなくす」
// 実行: npx tsx app/lib/__tests__/apply-line-rates.test.ts
import {
  RECOMMEND_APPLY_LINE_STATS as S, APPLY_LINE_STAGE_RATES,
  buildRecommendApplyLineNote, buildApplyLineStageRateNote, detectRecommendApplyLine, detectImmediateMoveInWish,
} from "../apply-line-rates";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const truthy = (a: unknown, m = "") => { if (!a) throw new Error(`expected truthy ${m}`); };
const falsy = (a: unknown, m = "") => { if (a) throw new Error(`expected falsy ${m}`); };
const eq = (a: unknown, b: unknown) => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} but got ${JSON.stringify(a)}`); };
const has = (t: string, s: string) => { if (!t.includes(s)) throw new Error(`expected to contain ${JSON.stringify(s)}\n${t}`); };
const hasNot = (t: string, s: string) => { if (t.includes(s)) throw new Error(`expected NOT to contain ${JSON.stringify(s)}\n${t}`); };

// ── 実物（scripts/audit-recommend-apply-line.ts ⑤ から。本名は〇〇に伏せてある）──
/** AI が書いてスタッフが消した（旧 buildMoveInDeadlineNote「添えること」の行・スタッフ自筆0通） */
const REAL_TWO_WEEKS = "お申込みから審査・ご契約・入居まで通常2週間程度で対応できますので、10月末頃のご入居にもしっかり対応可能です！！";
/** 空室の通で AI が書いてスタッフが消した */
const REAL_VACANT_CTA = "〇〇さんお気に召されましたらお申込みしお部屋押さえさせて頂きます😊！！";
/** 退去予定の通で AI が書いてスタッフが残した */
const REAL_VACATING_CTA = "退去予定のお部屋となりますので、〇〇さんお気に召されましたらお申込みしお部屋押さえさせて頂きます😊！！";
/** AI は書かず、スタッフが自分から足した（退去前） */
const REAL_STAFF_ADDED = "退去前のお部屋となりますので、お気に召されましたらお部屋お申込みいただき、ご内覧設定させていただきます😊！！";
/** 2番手の報告（申込の語はあるが誘導ではない） */
const REAL_STATUS = "現在1番手でお申込みが入っておりますので、2番手でのお申込みとなります。";
/** 申込の語が無い普通の締め */
const REAL_PLAIN = "ご希望のエリアで築浅・敷金礼金なしのお部屋となります！！\nお手隙の際にご確認ください！！";

const base = { notViewable: false, viewableFrom: null, hasEstimate: false, immediateMoveIn: false, moveInWish: null, marginDays: null };
const every = [
  buildRecommendApplyLineNote(base),
  buildRecommendApplyLineNote({ ...base, hasEstimate: true }),
  buildRecommendApplyLineNote({ ...base, immediateMoveIn: true }),
  buildRecommendApplyLineNote({ ...base, notViewable: true, viewableFrom: "10月1日" }),
  buildRecommendApplyLineNote({ ...base, moveInWish: "11月入居希望", marginDays: 23 }),
  buildRecommendApplyLineNote({ ...base, notViewable: true, hasEstimate: true, immediateMoveIn: true, moveInWish: "11月末", marginDays: 0 }),
];

describe("必須の形にも禁止の形にもなっていない（20%未満の帯＝率を渡して選ばせる）", () => {
  it("「添えること」「必ず」を含まない", () => { for (const n of every) { hasNot(n, "添えること"); hasNot(n, "必ず"); } });
  it("「禁止」「絶対」の形にしない（申込の一文は実送信にある形）", () => { for (const n of every) { hasNot(n, "禁止"); hasNot(n, "絶対"); } });
  it("2週間の行を全文で引用しない（LLM に写させない）", () => {
    for (const n of every) { hasNot(n, REAL_TWO_WEEKS); hasNot(n, "通常2週間程度で対応できます"); hasNot(n, "しっかり対応可能です"); }
  });
  it("空でない・見出しがある", () => { for (const n of every) has(n, "【申込の一文と入居時期"); });
});

describe("率の数字が STATS 定数と一致する（率の出所は1か所）", () => {
  const n = buildRecommendApplyLineNote(base);
  it("実送信率・AIが書いた件数・消した件数・スタッフが足した率", () => {
    has(n, `実送信${S.sent.pct}%`); has(n, `AIが書いた${S.ai.n}件のうち${S.aiRemoved.n}件`); has(n, `足したのは${S.staffAdded.pct}%`);
  });
  it("見積書・物件確認した の率（成約側 20〜32%）を『そちらで添える』として渡す", () => {
    has(n, `${APPLY_LINE_STAGE_RATES.estimate_sheet.sentPct}〜${APPLY_LINE_STAGE_RATES.property_check_result.sentPct}%`);
    has(n, "見積書・物件確認した の段階で添える");
  });
  // 反証者の指摘で「0通」→率の形に（実送信に残った形が4通・1.5%あり「実送信に無い形」と読ませない）
  it("2週間の行は率の形で渡す（実送信1.5%・残4・消11・自筆0）→ 書かない", () => {
    has(n, `実送信${S.twoWeeksLine.sentPct}%`); has(n, `残${S.twoWeeksLine.sentRemained}`); has(n, `自分から書いたのは${S.twoWeeksLine.staffSelfWritten}`); has(n, "書かない");
    hasNot(n, "書いたことが0通");
  });
  it("優先の1行がある（スタッフの指定・購買シグナル peak が上・一般的なCTA指示より率が上）", () => {
    has(n, "スタッフが申込誘導を指定した時"); has(n, "peak"); has(n, "この実送信の率のとおり書かない");
  });
  it("既定は「基本は書かない」", () => has(n, "基本は書かない"));
});

describe("状況ごとの線", () => {
  it("見積書同封 → 書かない・1/69", () => {
    const n = buildRecommendApplyLineNote({ ...base, hasEstimate: true });
    has(n, "1/69"); has(n, "御見積書を同封"); has(n, "書かない");
  });
  // 反証者の指摘: 1/61 は本文（物件側の「空室のため即入居可能」）の率で、旗は customer_conditions（お客様側）を見る＝出所違い → 行を出さない
  it("即入居の旗が立っても 1/61 の行は出さない（既定の『基本は書かない』に任せる）", () => {
    const n = buildRecommendApplyLineNote({ ...base, immediateMoveIn: true });
    hasNot(n, "1/61"); hasNot(n, "お客様は即入居を希望"); has(n, "基本は書かない");
  });
  it("退去予定でまだ内覧できない → 『内覧誘導ではなく申込誘導』と『必須ではない』を両方含む", () => {
    const n = buildRecommendApplyLineNote({ ...base, notViewable: true, viewableFrom: "10月1日" });
    has(n, "内覧誘導ではなく申込誘導"); has(n, "必須ではない"); has(n, "10月1日以降"); has(n, `誘導なし${S.vacatingClosing.nonePct}%`);
    has(n, `申込${S.vacatingClosingWhenCta.apply}件 vs 内覧${S.vacatingClosingWhenCta.viewing}件`);
  });
  it("空室（今内覧できる） → 空室の率で『書かない』", () => {
    const n = buildRecommendApplyLineNote(base);
    has(n, "今ご内覧頂ける"); has(n, `実送信${S.bySituation.vacantAll.pct}%`); hasNot(n, "内覧誘導ではなく申込誘導");
  });
  it("入居希望日に余裕がある → 事実と率を渡し『断言してよいが必須ではない』", () => {
    const n = buildRecommendApplyLineNote({ ...base, moveInWish: "11月入居希望", marginDays: 23 });
    has(n, "「11月入居希望」"); has(n, "23日の余裕"); has(n, "断言してよいが必須ではない"); has(n, `実送信${S.moveInOkForm.sentPct}%`);
  });
  it("入居希望日に余裕が無い（null）→ 入居時期の行を出さない（forbid ブロックと矛盾させない）", () => {
    const n = buildRecommendApplyLineNote({ ...base, moveInWish: "9月末", marginDays: null });
    hasNot(n, "断言してよい"); hasNot(n, "余裕");
  });
  it("見積書同封＋即入居の旗 → hasEstimate の行だけ出る（1/61 は出ない）", () => {
    const n = buildRecommendApplyLineNote({ ...base, hasEstimate: true, immediateMoveIn: true });
    has(n, "1/69"); hasNot(n, "1/61");
  });
});

describe("段階別の率だけのノート（見積書・物件確認した は必須にしない）", () => {
  it("見積書: 20.0%／成約側40件・必須ではない", () => { const n = buildApplyLineStageRateNote("estimate_sheet"); has(n, "20%"); has(n, "見積書"); has(n, "必須ではない"); hasNot(n, "必ず"); });
  it("物件確認した: 31.8%／成約側22件", () => { const n = buildApplyLineStageRateNote("property_check_result"); has(n, "31.8%"); has(n, "物件確認した"); has(n, "必須ではない"); });
  it("率の表が過半数（50%）を超える段階は無い", () => { for (const r of Object.values(APPLY_LINE_STAGE_RATES)) truthy(r.sentPct < 50, r.label); });
});

describe("検出器（ログ・監査用。出口では使わない）— 実物で分類", () => {
  it("2週間の行 → two_weeks", () => eq(detectRecommendApplyLine(`🌟〇〇 302号室\n${REAL_TWO_WEEKS}`).kind, "two_weeks"));
  it("空室の申込CTA → apply_cta", () => eq(detectRecommendApplyLine(REAL_VACANT_CTA).kind, "apply_cta"));
  it("退去予定の申込CTA → apply_cta", () => eq(detectRecommendApplyLine(REAL_VACATING_CTA).kind, "apply_cta"));
  it("スタッフが足した形（お申込みいただき、ご内覧設定）→ apply_cta", () => eq(detectRecommendApplyLine(REAL_STAFF_ADDED).kind, "apply_cta"));
  it("2番手の報告 → apply_status（誘導ではない）", () => eq(detectRecommendApplyLine(REAL_STATUS).kind, "apply_status"));
  it("申込の語が無い → null", () => { eq(detectRecommendApplyLine(REAL_PLAIN).kind, null); eq(detectRecommendApplyLine("").kind, null); eq(detectRecommendApplyLine(null).kind, null); });
  it("文単位で返す（見つけた文だけ）", () => {
    const r = detectRecommendApplyLine(`${REAL_PLAIN}\n${REAL_VACATING_CTA}`);
    eq(r.kind, "apply_cta"); eq(r.sentence, REAL_VACATING_CTA);
  });
});

describe("即入居の希望（お客様側）を読む", () => {
  it("希望条件の『入居: 即入居』『すぐに入居』→ true", () => {
    truthy(detectImmediateMoveInWish("家賃: 7万\n入居: 即入居")); truthy(detectImmediateMoveInWish("すぐに入居したい")); truthy(detectImmediateMoveInWish("入居時期：なるべく早く"));
  });
  it("『11月入居希望』『入居: 10月末』→ false", () => {
    falsy(detectImmediateMoveInWish("入居: 11月入居希望")); falsy(detectImmediateMoveInWish("入居: 10月末")); falsy(detectImmediateMoveInWish("")); falsy(detectImmediateMoveInWish(null));
  });
  it("『すぐ』単体（すぐ返信します）では反応しない", () => falsy(detectImmediateMoveInWish("すぐ返信します")));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
