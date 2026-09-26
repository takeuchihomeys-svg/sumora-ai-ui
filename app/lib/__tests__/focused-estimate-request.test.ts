// 主のお部屋（こちらが送ったお部屋）への見積もりの依頼 → 見積書送る（自己完結ハーネス・本文は実物）
// 実行: npx tsx app/lib/__tests__/focused-estimate-request.test.ts
import { resolveFocusedEstimateRequest, FOCUSED_ESTIMATE_ASK_RE, VACANCY_ASK_RE } from "../focused-estimate-request";

let passed = 0, failed = 0; const failures: string[] = []; let current = "";
function describe(name: string, fn: () => void) { current = name; fn(); }
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${current} › ${name}`); }
  catch (e) { failed++; failures.push(`${current} › ${name}`); console.log(`  ✗ ${current} › ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const eq = (a: unknown, b: unknown, msg = "") => { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)} ${msg}`); };

const OURS = { name: "エステムコート大阪WEST", sentByUs: true, ended: false };
const BROUGHT = { name: "持ち込みのお部屋", sentByUs: false, ended: false };

describe("YUMA 事例（2026-09-27 竹内「この場面は見積書を正解にする」）", () => {
  it("こちらが送ったお部屋に「いいですね」→「見積もりお願いできますか」→ 見積書送る", () => {
    const r = resolveFocusedEstimateRequest("エステムコート大阪WESTいいですね\n「見積もりお願いできますか", OURS);
    eq(r.hit, true); eq(r.reason, "focused_estimate_request"); eq(r.focusName, "エステムコート大阪WEST");
  });
});

describe("実送信で見積書送るだった依頼（監査 ours_pointed / ours_unnamed）", () => {
  const texts = [
    "こちらの初期費用教えてください！",
    "初期費用いくらですか？",
    "この物件についてですが、初期費用の見積もり出してほしいです。",
    "こちらの物件いいですね。 初期費用はいくらほどになりますか？",
    "ありがとうございます。 こちらの見積もりも欲しいです",
    "承知しました！ 607号室での見積もりお願いいたします",
    "8/3で1回初期費用出してもらえますか？💦",
    "HandPの初期費用の見積もり仮で作ってもらうことは可能ですか？",
    "ここは初期費用等どれくらいになりますか？",
    "〇〇様です！ ご丁寧にありがとうございます😊 初期費用がおいくらになるか計算してもらえると助かります🙇‍♀️",
  ];
  for (const t of texts) it(t.slice(0, 24), () => eq(resolveFocusedEstimateRequest(t, OURS).hit, true));
});

describe("今まで通り（上書きしない）", () => {
  it("物件が決まっていない（主のお部屋なし）", () => eq(resolveFocusedEstimateRequest("初期費用いくらですか？", null).reason, "no_focus"));
  it("お客様が持ち込んだお部屋は募集状況の確認が先になり得る", () =>
    eq(resolveFocusedEstimateRequest("このふたつの物件取り扱いあれば初期費用の見積もり等いただきたいです", BROUGHT).reason, "focus_not_ours"));
  it("終了したお部屋", () => eq(resolveFocusedEstimateRequest("見積もりお願いできますか", { ...OURS, ended: true }).reason, "focus_ended"));
  it("見積書へのお礼は依頼ではない（b87d85db）", () =>
    eq(resolveFocusedEstimateRequest("見積もり書ありがとうございます！！ 近くで借りるのでも全然大丈夫です！", OURS).reason, "not_estimate_ask"));
  it("見積もりしてもらったお礼（f2967621）", () =>
    eq(FOCUSED_ESTIMATE_ASK_RE.test("見積もりしてもらいありがとうございます！！"), false));
  it("条件フォームの初期費用の項目", () =>
    eq(resolveFocusedEstimateRequest("【ご希望の家賃】⇒7万\n【初期費用の限度額】⇒20万", OURS).reason, "not_estimate_ask"));
  it("別の物件を探す依頼が主題（3722d12d）", () =>
    eq(resolveFocusedEstimateRequest("9月中旬あたりで行けるとこ探して欲しいです 初期費用いくらかかりますか？", OURS).reason, "condition_change"));
  it("別の部屋の有無（9faff2ec）", () =>
    eq(resolveFocusedEstimateRequest("白基調の部屋はあんまりないですかね？💦 送って下さってる部屋は初期費用はいくらですか？", OURS).reason, "condition_change"));
  it("空き状況も聞いている（1191b1eb）→ ブレインに任せる", () => {
    const r = resolveFocusedEstimateRequest("一部屋しか空いてない感じですか？ 初期費用教えてください！", OURS);
    eq(r.reason, "also_vacancy"); eq(r.alsoVacancy, true);
  });
  it("まだ募集していますか＋見積もり", () => eq(VACANCY_ASK_RE.test("こちらまだ募集してますか？見積もりもお願いします"), true));
  it("内覧も聞いている（bfd172e6）→ ブレインに任せる", () =>
    eq(resolveFocusedEstimateRequest("こちらだと初期費用おいくらですか？ 本日内覧可能ですか？", OURS).reason, "also_viewing"));
  it("費用の中身の質問は見積もりの依頼ではない（cost_breakdown）", () =>
    eq(resolveFocusedEstimateRequest("家賃だけ払ったら住めるんですか？", OURS).reason, "not_estimate_ask"));
  it("コスト懸念（初期費用を抑えたい）は見積もりの依頼ではない", () =>
    eq(resolveFocusedEstimateRequest("初期費用を抑えたいです", OURS).reason, "not_estimate_ask"));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log(failures.join("\n")); process.exit(1); }
