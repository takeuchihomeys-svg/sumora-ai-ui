// app/lib/__tests__/brain-dplan.test.ts — D案の核（読み手 flash → 指揮官が材料を選ぶ）の決まった計算
//   実行: npx tsx app/lib/__tests__/brain-dplan.test.ts
import { dPlanOn, dPlanGate, MATERIAL_KEYS, buildCoreUserText, trimmedKeys, digestBlock, parseReaderOut, parseNeedMaterials, recalledBlock, coreOverTwoStage, readerUser, readerSystem, clipHistory, READERS, READER_KEYS, catalogPicks, compactCatalog, type Materials, type ReaderResult } from "../brain-dplan";
import { applyOverride, markCoreWins, type DemotedOverride } from "../override-demote";
import { altPiiSignal } from "../alt-pii-gate";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`); } };

// スイッチ
t("既定 off", !dPlanOn({}));
t("BRAIN_D_PLAN=on", dPlanOn({ BRAIN_D_PLAN: "on" }));
t("知らない値は off", !dPlanOn({ BRAIN_D_PLAN: "shadow" }));

// 個人情報の入口
const g0 = { postApply: false, cutoffKind: "all", applicationForm: false, personalImage: false, parallelSecond: false, readerText: "駐車場ありますか", piiSignal: altPiiSignal };
t("普通の番は通す", dPlanGate(g0).ok);
t("申込以降は通さない", !dPlanGate({ ...g0, postApply: true }).ok);
t("時刻の線 cut は通さない", !dPlanGate({ ...g0, cutoffKind: "cut" }).ok);
t("印なしは通さない", !dPlanGate({ ...g0, cutoffKind: null }).ok);
t("申込フォームは通さない", !dPlanGate({ ...g0, applicationForm: true }).ok);
t("個人の書類の画像は通さない", !dPlanGate({ ...g0, personalImage: true }).ok);
t("2番手で申込中は通さない", !dPlanGate({ ...g0, parallelSecond: true }).ok);
t("携帯の番号が残っていれば通さない", dPlanGate({ ...g0, readerText: "連絡先は090-1234-5678です" }).reason === "個人の値（携帯電話の番号）");

// 並び: 何も削らなければ今の素の入力と同じ
const m: Materials = {};
MATERIAL_KEYS.forEach((k, i) => { m[k] = `\n【${k}】${"あ".repeat(i === 19 ? 400 : 150)}`; });
const tail = "\n\n会話履歴（…）:\n[顧客] こんにちは";
const same = MATERIAL_KEYS.map((k) => m[k]).join("") + tail;
t("削らなければ1文字も変わらない", buildCoreUserText(m, [], "", tail) === same);

// 外す材料: 読めた読み手の物だけ・keep_full と失敗は外さない・小さい物は外さない
const r = (key: ReaderResult["key"], ok: boolean, keepFull = false): ReaderResult => ({ key, ok, out: ok ? { points: [`${key} の要点`], keepFull } : null, error: ok ? null : "x", ms: 1, usd: 0, inTok: 0, outTok: 0, cacheHit: 0 });
const res1 = [r("state", true), r("promise", false), r("props", true, true), r("dates", true), r("aixfacts", true), r("intent", true)];
const tk = trimmedKeys(res1, m);
t("お客様の状態は外す", tk.includes("customerState"));
t("失敗した読み手（約束）の材料は外さない", !tk.includes("ledger") && !tk.includes("aixHistory"));
t("keep_full の読み手（物件）の材料は外さない", !tk.includes("sentProps"));
t("ナレッジは外す", tk.includes("rag"));
t("小さい材料は外さない", !trimmedKeys([r("state", true)], { customerState: "短い" }).length);
const out = buildCoreUserText(m, tk, digestBlock(res1, tk, m), tail);
t("外した材料の本文は無い", !out.includes("【customerState】") && !out.includes("【rag】"));
t("外していない材料は残る", out.includes("【ledger】") && out.includes("【aixCatalog】"));
t("目次に外した物の名前", out.includes("- customerState: お客様の状態"));
t("下ごしらえは履歴の前", out.indexOf("state の要点") < out.indexOf("会話履歴（…）"));
t("核の決まり（原則の優先）が入る", out.includes("原則の優先順位") && out.includes("need_materials"));
t("失敗した読み手は下ごしらえに出ない", !out.includes("promise の要点"));

// 読み手の答え
t("読める", parseReaderOut('```json\n{"points":["a","b"],"keep_full":false}\n```')?.points.length === 2);
t("崩れは null", parseReaderOut("points: a") === null);
t("8行まで", parseReaderOut(JSON.stringify({ points: Array.from({ length: 12 }, (_, i) => `p${i}`) }))?.points.length === 8);
t("keep_full", parseReaderOut('{"points":["a"],"keep_full":true}')?.keepFull === true);
t("読み手の頭はブレインの印の語で始めない", READER_KEYS.every((k) => !readerSystem(k).startsWith("あなたはスモラAI")));
t("今回の連投は最後の方", (() => { const u = readerUser("state", m, "履歴", "今回の発言"); return u.indexOf("今回の発言") > u.indexOf("履歴"); })());
t("材料は読む物だけ", !readerUser("dates", m, "", "x").includes("【材料: ナレッジ】") && readerUser("aixfacts", m, "", "x").includes("【材料: ナレッジ】"));
t("履歴は新しい方を残す", clipHistory("古い\n".repeat(100) + "新しい", 50).endsWith("新しい"));
t("読み手は7人・全員に仕事", READER_KEYS.length === 7 && READER_KEYS.every((k) => READERS[k].task.length > 20));

// 呼び戻し
t("呼び戻し: 目次の名前だけ", JSON.stringify(parseNeedMaterials({ need_materials: ["customerState", "aixCatalog", "rag"] }, ["customerState", "rag"])) === JSON.stringify(["customerState", "rag"]));
t("いつもの JSON が出ていれば呼び戻さない", parseNeedMaterials({ need_materials: ["rag"], reply_direction: "x" }, ["rag"]).length === 0);
t("呼び戻しの文に本文", recalledBlock(["rag"], { rag: "ナレッジ本文" }).includes("ナレッジ本文"));

// 2段の約束を核で決める
t("約束を言っていれば2段のまま", !coreOverTwoStage({ asks: [{ route: "promise" }] }).demote);
t("依頼が無ければ2段のまま", !coreOverTwoStage({ asks: [] }).demote);
t("返信だけ→2段を外し返信", JSON.stringify(coreOverTwoStage({ asks: [{ route: "reply" }] })) === JSON.stringify({ demote: true, replyOnly: true }));
t("AIX を言えば AIX のまま", JSON.stringify(coreOverTwoStage({ asks: [{ route: "aix" }, { route: "reply" }] })) === JSON.stringify({ demote: true, replyOnly: false }));
t("閉じる番は AIX のまま", coreOverTwoStage({ asks: [{ route: "none" }], close_only: true }).replyOnly === false);

// 核を勝たせる（上書きの関所）
const l1: DemotedOverride[] = [];
t("既定で上書きする家族（signal_decided）は上書き", applyOverride(l1, "signal_decided", "s", "x", null, {}) === true);
const l2: DemotedOverride[] = []; markCoreWins(l2);
t("D案の番は下げる（記録だけ）", applyOverride(l2, "signal_decided", "s", "x", null, {}) === false && l2.length === 1);
t("印は一覧ごと（別の一覧に漏れない）", applyOverride([], "search_exhausted", "s", "x", null, {}) === true);

// AIX のボタン一覧の縮め（2周目）
const cat = ["【返信か AIX かの決め方】", "① 決め方", "【AIX のボタン×ピッカー】",
  "- property_check_result【確認した（条件・交渉）】 送る情報: 管理会社に確認した結果",
  "    ・誰に確認したか: 管理会社に確認した／代表に確認した",
  "    ・駐車場について（mgmt_parking）: 物件の駐車場の有無｜資料にある時は返信",
  "    ・ペット飼育について（mgmt_pet）: ペット可否・条件",
  "- phone_call【電話をかける】 送る情報: 定型の文｜使う時: 電話の依頼",
  "    ・押された実績（30日）: 1",
  "- 今の場面の外のボタン: guarantor_info【審査について】"].join("\n");
const picks = catalogPicks(cat, ["property_check_result/mgmt_parking: 駐車場の空き", "unknown_x"]);
t("候補の値を拾う", picks.includes("property_check_result") && picks.includes("mgmt_parking") && !picks.includes("unknown_x"));
const cc = compactCatalog(cat, ["mgmt_parking"]);
t("決め方はそのまま", cc.includes("① 決め方"));
t("候補のピッカーは全文", cc.includes("物件の駐車場の有無｜資料にある時は返信"));
t("候補でないピッカーは名前と値だけ", cc.includes("・ペット飼育について（mgmt_pet）") && !cc.includes("ペット可否・条件"));
t("候補でないボタンは名前とキーだけ", cc.includes("- phone_call【電話をかける】") && !cc.includes("電話の依頼") && !cc.includes("押された実績"));
t("誰に確認したかは残す", cc.includes("誰に確認したか"));
t("場面の外の1行は残す", cc.includes("今の場面の外のボタン: guarantor_info"));
t("縮めた一覧を差し込める", buildCoreUserText({ aixCatalog: "全文", status: "S" }, ["aixCatalog"], "", "", { aixCatalog: "縮め" }) === "縮めS");

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
