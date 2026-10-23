// 2026-10-23 竹内さんの決定（2d860ddb）入居者の条件について（お子様の入居・年齢）のピッカーのテスト。LLM は呼ばない
// 実行: npx tsx app/lib/__tests__/aix-occupant-picker.test.ts
import {
  aixOccupantPickerEnabled, buildOccupantMgmtInfo, ensureOccupantCondition, isOccupantConditionText, occupantFormat,
  occupantConditionLine, OCCUPANT_RULES,
} from "../aix-occupant-picker";
import { aixRequestMustUseClaude } from "../aix-new-pickers";
import { willRouteAlt } from "../llm-alt-provider";
import { checkPatternForConfirmTopic, confirmObjectOf, confirmTopicForCheckPattern } from "../action-ledger";
import { normalizeBrainCheckPattern, brainCheckPatternSchemaField } from "../brain-check-pattern";
import { detectPropertyCheckPattern, propertyCheckKindFor } from "../aix-taxonomy";
import { catalogBlockForBrain, AIX_CATALOG } from "../aix-catalog";
import { AIX_PICKERS } from "../aix-pickers";
import { classifyHandFulfillment } from "../link-brain-watch";

let passed = 0, failed = 0;
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
function withSwitch(v: string | undefined, fn: () => void) {
  const prev = process.env.AIX_OCCUPANT_PICKER;
  if (v) process.env.AIX_OCCUPANT_PICKER = v; else delete process.env.AIX_OCCUPANT_PICKER;
  try { fn(); } finally { if (prev === undefined) delete process.env.AIX_OCCUPANT_PICKER; else process.env.AIX_OCCUPANT_PICKER = prev; }
}

it("切替は既定 off（on で入る）", () => {
  ok(!aixOccupantPickerEnabled({}), "既定 on");
  ok(aixOccupantPickerEnabled({ AIX_OCCUPANT_PICKER: "on" }), "on で入らない");
  ok(!aixOccupantPickerEnabled({ AIX_OCCUPANT_PICKER: "off" }), "off で入る");
});

it("画面のピッカーは切替なしである（確認した（条件・交渉）の中・可否と条件の欄）", () => {
  const p = AIX_PICKERS.property_check_result.pickers;
  ok(p.find((x) => x.key === "check_pattern")?.options?.some((o) => o.value === "mgmt_occupant" && o.label === "入居者の条件について"), "選択肢が無い");
  ok(p.find((x) => x.key === "occupant_policy")?.options?.map((o) => o.value).join("/") === "可能/不可/条件あり", "可否の欄");
  ok(p.some((x) => x.key === "occupant_condition"), "条件の欄");
  const e = AIX_CATALOG.find((x) => x.key === "property_check_result/mgmt_occupant");
  ok(e && e.button === "確認した（条件・交渉）" && e.staffOnly.includes("お子様"), "カタログの行");
});

it("網: 当たる・当たらない", () => {
  for (const s of ["202は子ども不可ですか", "子供のご入居が可能か確認いただいております", "お子様可ですか？", "小学生以下は入居できますか", "年齢制限はありますか"]) ok(isOccupantConditionText(s), `当たらない: ${s}`);
  for (const s of ["子供の声NGです", "大人2人、子供2人、犬2匹でいい物件があれば", "お子様のお部屋と分けやすい間取り", "入居日はいつですか", "子供の入居日は3月末です", "子供が入居する部屋を探しています", "子どもの入居時期は春です"]) ok(!isOccupantConditionText(s), `当たる: ${s}`);
  for (const s of ["お子様のご入居可能となります", "中学生以下のお子様のご入居が出来ないとのことです"]) ok(isOccupantConditionText(s), `結果の文に当たらない: ${s}`);
});

it("入力: 可否が要る・条件ありは条件が要る・物件名なしは触れない", () => {
  let threw = false; try { buildOccupantMgmtInfo({ policy: "OK" }); } catch { threw = true; } ok(threw, "可否なしで通る");
  threw = false; try { buildOccupantMgmtInfo({ policy: "条件あり", condition: " " }); } catch { threw = true; } ok(threw, "条件なしで通る");
  const a = buildOccupantMgmtInfo({ policy: "条件あり", condition: "中学生以上のお子様", propertyName: "サンライトあべの8 202号室" });
  ok(a.includes("お子様のご入居：条件あり") && a.includes("条件（管理会社の回答のまま）：中学生以上のお子様") && a.includes("物件名：サンライトあべの8 202号室"), a);
  ok(buildOccupantMgmtInfo({ policy: "不可" }).includes("物件名：入力なし"), "物件名なし");
});

it("型: 二人入居の2行の型・条件の字に お子様 があれば重ねない", () => {
  ok(occupantFormat("可能").endsWith("お子様のご入居可能となります😊！！"), occupantFormat("可能"));
  ok(occupantFormat("不可").includes("お子様のご入居が出来ないお部屋となります。"), occupantFormat("不可"));
  ok(occupantFormat("条件あり", "中学生以上のお子様").endsWith("[条件]でしたらご入居可能となります😊！！"), occupantFormat("条件あり", "中学生以上のお子様"));
  ok(occupantFormat("条件あり", "1階のお部屋のみ").endsWith("[条件]でしたらお子様のご入居可能となります😊！！"), occupantFormat("条件あり", "1階のお部屋のみ"));
  ok(occupantConditionLine("1階のお部屋のみ") === "1階のお部屋のみでしたらお子様のご入居可能となります😊！！", "1階");
  ok(/絶対に書かない/.test(OCCUPANT_RULES) && /謝罪表現/.test(OCCUPANT_RULES), "決まり");
});

it("出口: 条件の字が無ければ2行目を差し替える・あれば触らない", () => {
  const bad = "サンライトあべの8 202号室にお子様のご入居可能か管理会社に確認させて頂きましたところ\n小さいお子様でもご入居可能となります😊！！";
  const fixed = ensureOccupantCondition(bad, "条件あり", "中学生以上のお子様");
  ok(fixed.split("\n")[1] === "中学生以上のお子様でしたらご入居可能となります😊！！", fixed);
  const good = "…確認させて頂きましたところ\n中学生以上のお子様でしたらご入居可能となります😊！！";
  ok(ensureOccupantCondition(good, "条件あり", "中学生以上のお子様") === good, "触った");
  ok(ensureOccupantCondition(bad, "可能", "") === bad, "可能で触った");
  const head = "サンライトあべの8 202号室にお子様のご入居可能か管理会社に確認させて頂きましたところ";
  const yes = `${head}\nお子様のご入居可能となります😊！！`, no = `${head}\nお子様のご入居が出来ないお部屋となります。`;
  ok(ensureOccupantCondition(yes, "不可", "") === no, "不可なのに可能が残る");
  ok(ensureOccupantCondition(no, "不可", "") === no, "不可を触った");
  ok(ensureOccupantCondition(no, "可能", "") === yes, "可能なのに不可が残る");
  ok(ensureOccupantCondition(yes, "可能", "") === yes, "可能を触った");
});

it("必ず Claude（お子様の有無・年齢＝ご家族の事情・切替に関係なく）", () => {
  const env = { LLM_ALT_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "k", LLM_ALT_ACTIONS: "property_check_result" };
  const must = aixRequestMustUseClaude({ action: "property_check_result", check_pattern: "mgmt_occupant" });
  ok(must, "Claude 固定でない");
  ok(!willRouteAlt("property_check_result", { postApply: must }, env), "DeepSeek に回る");
});

it("off: 約束の台帳・ブレイン・網・カタログは今まで通り", () => {
  withSwitch(undefined, () => {
    ok(confirmObjectOf("サンライトあべの8 202号ただいま管理会社担当さんに子供のご入居が可能か確認いただいております！！") !== "入居者の条件", "台帳が変わる");
    ok(checkPatternForConfirmTopic("入居者の条件") === null, "要件→ピッカー");
    ok(normalizeBrainCheckPattern("mgmt_occupant") === null, "ブレインの値を読む");
    ok(!brainCheckPatternSchemaField({}).includes("mgmt_occupant"), "出力の説明に出る");
    ok(detectPropertyCheckPattern("202は子ども不可ですか")?.check_pattern !== "mgmt_occupant", "網が出す");
    ok(!catalogBlockForBrain(null, { includeAll: true, env: {} }).includes("mgmt_occupant"), "カタログに出る");
  });
});

it("on: 約束の台帳（入居時期より先）・ブレイン・網・カタログ", () => {
  withSwitch("on", () => {
    ok(confirmObjectOf("サンライトあべの8 202号ただいま管理会社担当さんに子供のご入居が可能か確認いただいております！！") === "入居者の条件", String(confirmObjectOf("子供のご入居が可能か確認いただいております")));
    ok(confirmObjectOf("11月中旬でのご入居が可能か確認させて頂きます") === "入居時期", "入居時期を奪う");
    ok(checkPatternForConfirmTopic("入居者の条件") === "mgmt_occupant", "要件→ピッカー");
    ok(normalizeBrainCheckPattern("mgmt_occupant") === "mgmt_occupant", "ブレインの値");
    ok(brainCheckPatternSchemaField({ AIX_OCCUPANT_PICKER: "on" }).includes("mgmt_occupant"), "出力の説明");
    ok(detectPropertyCheckPattern("202は子ども不可ですか")?.check_pattern === "mgmt_occupant", "網");
    ok(propertyCheckKindFor("mgmt_occupant")?.ui_button === "確認した（条件・交渉）", "ボタン");
    ok(catalogBlockForBrain(null, { includeAll: true, env: { AIX_OCCUPANT_PICKER: "on" } }).includes("mgmt_occupant"), "カタログ");
  });
  ok(confirmTopicForCheckPattern("mgmt_occupant") === "入居者の条件", "送った AIX が閉じる要件");
});

it("見張りの手打ちの分け: 入居者の条件のピッカーへ", () => {
  const r = classifyHandFulfillment("担当者に確認させていただき、中学生以下のお子様のご入居が出来ないとのことです。");
  ok(r.checkPattern === "mgmt_occupant", JSON.stringify(r));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
