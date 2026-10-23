// 2026-10-18 flash-writer（書く役が flash の時だけの手当て）。お客様の発言は試験の問題の型（名前は伏せた）
// 実行: npx tsx app/lib/__tests__/flash-writer.test.ts
import { RESTATE_APOLOGY_HOW, buildFlashChecklist, missingFlashItems, renderFlashChecklistNote, isFlashModel, flashWriterParts, flashWriterAdaptOn, topExamples, buildFlashRewriteFeedback } from "../flash-writer";
import { testDeepseekModelOverride } from "../llm-alt-provider";
import type { TurnContract } from "../turn-contract";

let passed = 0, failed = 0; const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") { if (cond) passed++; else { failed++; failures.push(`${name} ${detail}`); } }

const base: TurnContract = { asks: [], leadWith: null, closeOnly: false, mustNot: [], proposals: [], alreadySaid: [], settled: [], feeling: { kind: null, acknowledge: false }, humanChecks: [], source: "brain" };

// モデル名・スイッチ
ok("flash 判定", isFlashModel("deepseek-flash") && isFlashModel("deepseek-v4-flash") && !isFlashModel("deepseek-v4-pro") && !isFlashModel(null));
ok("既定 on", flashWriterAdaptOn({}) && !flashWriterAdaptOn({ FLASH_WRITER_ADAPT: "off" }));
ok("既定の手当て", [...flashWriterParts({})].join(",") === "list,recheck");
ok("手当ての指定", [...flashWriterParts({ FLASH_WRITER_PARTS: "list,plan,bogus" })].join(",") === "list,plan");

// q032 型: 謝り＋条件の言い直し（ブレインは条件の約束だけを asks に入れた）
{
  const c: TurnContract = { ...base, asks: [{ quote: "大国町エリアで1K・7畳以上", topic: "pickup", kind: "request", route: "promise", answer: "大国町で1K7畳以上を新たにピックアップしてお送りする", basis: null, aixKey: null }] };
  const items = buildFlashChecklist({ contract: c, ledgerItems: [], customerUnits: ["何回も送ってもらっているのにすみません", "大国町エリアで1K・7畳以上でお願いします"] });
  ok("q032 謝りの行が足される", items.some((x) => /すみません/.test(x.label)), JSON.stringify(items.map((x) => x.label)));
  const miss = missingFlashItems(items, "かしこまりました！！大国町エリアで1K・7畳以上のお部屋を新たにピックアップしてお送りさせて頂きます！！");
  ok("q032 謝りを受けない下書きは抜け", miss.length === 1 && /すみません/.test(miss[0].label));
  ok("q032 受けた下書きは抜けなし", missingFlashItems(items, "全然大丈夫です😊！！大国町エリアで1K・7畳以上のお部屋をピックアップしてお送りさせて頂きます！！").length === 0);
  // 2026-10-23 317c7a7c: 要望の言い直しの謝りは「全然大丈夫です」でなく受け入れ＋ご満足頂けるお部屋が一番
  ok("q032 言い直しの謝りの受け方", items.some((x) => x.how === RESTATE_APOLOGY_HOW));
  ok("q032 317c7a7c の形は抜けなし", missingFlashItems(items, "かしこまりました！！大国町エリアで1K・7畳以上のお部屋をピックアップしてお送りさせて頂きます！！ご満足頂けるお部屋が見つかるのが一番ですのでご要望等出てきましたらいつでもお気軽にご連絡ください😊！！").length === 0);
  ok("言い直しでない謝りは今まで通り", buildFlashChecklist({ contract: base, ledgerItems: [], customerUnits: ["返信遅くなってすみません"] }).every((x) => x.how !== RESTATE_APOLOGY_HOW));
  ok("一覧の文", /答える項目の一覧/.test(renderFlashChecklistNote(items)) && /すみません/.test(renderFlashChecklistNote(items)));
}
// q157 型: 物件ごとの答え（物件名を書く）
{
  const c: TurnContract = { ...base, asks: [
    { quote: "クリエオーレ一津屋Ⅱのところは代理契約は難しいでしょうか", topic: "contract", kind: "question", route: "promise", answer: "代理契約が可能か管理会社に交渉する", basis: null, aixKey: null, axis: { about: "procedure", property: "クリエオーレ一津屋Ⅱ", when: null, whose: null, polarity: null } },
  ] };
  const items = buildFlashChecklist({ contract: c, ledgerItems: [], customerUnits: [] });
  ok("q157 物件名が無い下書きは抜け", missingFlashItems(items, "代理契約が可能か管理会社に交渉させて頂きます！！").length === 1);
  ok("q157 物件名がある下書きは抜けなし", missingFlashItems(items, "クリエオーレ一津屋Ⅱの代理契約につきましては管理会社に交渉させて頂きます！！").length === 0);
}
// AIX の項目は書き直しの理由にしない
{
  const c: TurnContract = { ...base, asks: [{ quote: "こちらの物件気になります", topic: "viewing", kind: "request", route: "aix", answer: null, basis: null, aixKey: "viewing_invite", axis: { about: "viewing_day", property: "グランパシフィック", when: null, whose: null, polarity: null } }] };
  const items = buildFlashChecklist({ contract: c, ledgerItems: [], customerUnits: [] });
  ok("AIX は lenient", missingFlashItems(items, "ありがとうございます！！").length === 0);
}
// 触れない項目は一覧に入れない
ok("route none は入れない", buildFlashChecklist({ contract: { ...base, asks: [{ quote: "了解です", topic: "other", kind: "report", route: "none", answer: null, basis: null, aixKey: null }] }, ledgerItems: [], customerUnits: [] }).length === 0);
// 本質が無い時は台帳
ok("台帳から", buildFlashChecklist({ contract: null, ledgerItems: [{ quote: "初期費用はいくらですか？", topic: "cost", route: "promise", saidAt: "", kind: "question" }], customerUnits: [] }).length === 1);
// 手本の切り出し
ok("手本の上位2つ", topExamples("\n\n【⭐ 例】\n\n[例1]\nお客様: a\n\n[例2]\nお客様: b\n\n[例3]\nお客様: c") === "[例1]\nお客様: a\n\n[例2]\nお客様: b");
ok("書き直しの依頼", /書き直し/.test(buildFlashRewriteFeedback([{ label: "x", how: "答える", keys: [], mustProperty: null, lenient: false }])));
// 試験だけのモデルの切り替え
ok("切替: テストの時だけ", testDeepseekModelOverride({ LLM_TEST_MODE: "deepseek-all", LLM_TEST_DS_MODEL_BY_ACTION: "reply_generate=deepseek-flash,final_check_*=deepseek-flash" }, "reply_generate") === "deepseek-flash");
ok("切替: 前方一致", testDeepseekModelOverride({ LLM_TEST_MODE: "deepseek-all", LLM_TEST_DS_MODEL_BY_ACTION: "final_check_*=deepseek-flash" }, "final_check_verify") === "deepseek-flash");
ok("切替: ブレインは替えない", testDeepseekModelOverride({ LLM_TEST_MODE: "deepseek-all", LLM_TEST_DS_MODEL_BY_ACTION: "reply_generate=deepseek-flash" }, "brain") === null);
ok("切替: 本番（テストの印なし）は無し", testDeepseekModelOverride({ LLM_TEST_DS_MODEL_BY_ACTION: "reply_generate=deepseek-flash" }, "reply_generate") === null);

console.log(`flash-writer: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  ✕", f); process.exit(1); }
