// app/lib/__tests__/aix-meaning-learn.test.ts — AIX の意味を DB から学ぶ物差し・学んだ意味のブレインへの渡し方（実行: npx tsx app/lib/__tests__/aix-meaning-learn.test.ts）
import { contentTopicsOf, misPressOf, handTypedAixTopic, maskExemplar, groupsOfKey, customerIntentOf, structureOf, learnedLine, SIMILAR_GROUPS } from "../aix-meaning-learn";
import { catalogBlockForBrain, isSceneUncertain, aixMeaningForGenerator, learnedMeaningFor, AIX_CATALOG } from "../aix-catalog";
import { AIX_LEARNED } from "../aix-catalog-learned";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

// 中身の話題
t("御見積書の文は estimate・amount", (() => { const x = contentTopicsOf("最大限割引させて頂きました御見積書お送りさせて頂きました！！ 初期費用：159,830円"); return x.includes("estimate") && x.includes("amount"); })());
t("ピックアップさせて頂きました は物件の束", contentTopicsOf("ご条件に合ったお部屋ピックアップさせて頂きました😊！！").includes("property_list"));
t("ご案内可能の日時は内覧の日時", contentTopicsOf("直近ですと 10/28(水) 15:00〜18:00 にてご案内可能です！！").includes("viewing_dates"));
t("募集に出ていない は募集終了の結果", contentTopicsOf("募集状況確認させて頂きましたところ、現在募集に出ていないお部屋となっております！！").includes("availability_ng"));

// 押し間違い
t("内覧日調整で候補日なら押し間違いでない", misPressOf("viewing_invite/通常", "かしこまりました！！ 直近ですと 10/28(水) 15:00〜18:00 10/29(木) 12:00〜14:00 にてご案内可能です！！ ご都合いかがでしょうか") === null);
t("見積書送るで金額も見積も無い文は押し間違い", misPressOf("estimate_sheet", "かしこまりました！！ 内覧の日程につきまして明日ご連絡させて頂きますのでよろしくお願い致します！！")?.reason.includes("約束") === true);
t("物件確認した→物件なかった で募集中の文は押し間違い（物件あったを勧める）", misPressOf("property_check_result/unavailable", "お送り頂きました物件の募集状況確認しましたところ、まだ募集中のお部屋となります！！ ご内覧も可能です😊！！")?.suggest === "property_check_result/available");
t("物件あった＋御見積書の同封は押し間違いでない（定義どおり）", misPressOf("property_check_result/available", "お待たせ致しました！！ 最大限割引しました初期費用御見積書同封させて頂きました。お手隙の際にご査収ください！！") === null);
t("短い文は判断しない", misPressOf("estimate_sheet", "よろしくお願いします") === null);
t("新着1件 で「中でも」の文は 継続ピックアップ を勧める", misPressOf("property_recommendation/新着1件", "お送りさせて頂きましたお部屋の中でも特にオススメ出来るお部屋となります！！ 家賃も抑えられます！！")?.suggest === "property_recommendation/継続ピックアップ");

// 手打ちの AIX
t("手打ちの申込フォーマットは AIX", handTypedAixTopic("下記の記入欄にご記入くださいませ！！\n・氏名\n・生年月日\n・ご住所") === "application_push/format");
t("手打ちの約束は AIX でない", handTypedAixTopic("管理会社に募集状況確認させて頂きます！！確認出来次第ご連絡させて頂きます！！") === null);
t("手打ちの管理会社の答え（募集終了）は AIX", handTypedAixTopic("お世話になっております！！ 高殿サンク管理会社確認しましたところお申込が入り、現在内覧出来ないとの事です！！") === "property_check_result/unavailable");

// 伏せ方
const masked = maskExemplar("【サンプル荘 101】のご案内です\n大阪市北区梅田1丁目2-3\nTEL 090-1234-5678 https://example.com/x mail a@b.co");
t("物件名・住所・電話・URL・メールを伏せる", !/サンプル荘|梅田1丁目|090-1234|example\.com|a@b\.co/.test(masked), masked);

// 意図・型
t("お礼の意図", customerIntentOf("かしこまりました！") === "お礼・了承");
t("費用の意図", customerIntentOf("ここ初期費用いくらですか？") === "費用");
t("受けと締めを数える", (() => { const s = structureOf("YUMAさん\nかしこまりました！！\n何卒よろしくお願い致します！！"); return s.uke && s.close; })());

// 似た組
t("似た組は鍵のボタンの部分でも当たる", groupsOfKey("property_send/new_arrival").some((g) => g.name === "束か1件か"));
t("似た組の鍵は全部カタログにある", SIMILAR_GROUPS.every((g) => g.keys.every((k) => AIX_CATALOG.some((e) => e.key === k || e.aixType === k))), SIMILAR_GROUPS.flatMap((g) => g.keys).filter((k) => !AIX_CATALOG.some((e) => e.key === k || e.aixType === k)).join(","));

// 場面の読み
t("other は弱い", isSceneUncertain("other", "none"));
t("cost/cost は弱くない", !isSceneUncertain("cost", "cost"));
t("viewing_time は弱い", isSceneUncertain("viewing", "viewing_time"));

// ブレインへの渡し方（切替 off は今まで通り）
const off = catalogBlockForBrain("cost", { env: {} });
t("切替 off は学んだ行が出ない", !off.includes("竹内さんの文の中身") && !off.includes("場面の読みが弱いので全部"));
t("AIX_CATALOG_LEARNED=on は学んだ行が出る（学んだデータがある時）", Object.keys(AIX_LEARNED).length === 0 || catalogBlockForBrain("cost", { env: { AIX_CATALOG_LEARNED: "on" } }).includes("竹内さんの送信から学んだ意味"));
const full = catalogBlockForBrain("cost", { env: { AIX_CATALOG_UNCERTAIN_FULL: "on" }, sceneUncertain: true });
t("場面が弱い＋切替 on は全部のピッカーの細目（内覧の候補日も出る）", full.includes("場面の読みが弱いので全部") && full.includes("内覧日指定あり（内覧日指定あり）"));
t("場面が強い時は切替 on でも絞ったまま", catalogBlockForBrain("cost", { env: { AIX_CATALOG_UNCERTAIN_FULL: "on" }, sceneUncertain: false }) === off);
t("場面が弱くても切替 off なら今まで通り", catalogBlockForBrain("cost", { env: { AIX_CATALOG_UNCERTAIN_FULL: "off" }, sceneUncertain: true }) === off);
t("既定 on（2026-10-22）: 場面が弱い番は全部", catalogBlockForBrain("cost", { env: {}, sceneUncertain: true }).includes("場面の読みが弱いので全部"));

// 学んだデータ: 個人の値が無い・従業員の押下で意味を作っていない
const dump = JSON.stringify(AIX_LEARNED);
t("学んだデータに電話・メール・URL が無い", !/0[789]0[-‐－ー]?\d{4}[-‐－ー]?\d{4}|[\w.+-]+@[\w-]+\.[a-z]{2,}|https?:\/\//i.test(dump));
t("お手本が足りない物はお手本も中身も持たない", Object.values(AIX_LEARNED).every((m) => !m.needsOwnerGold || (m.exemplars.length === 0 && m.writeContains.length === 0)));
t("learnedMeaningFor はピッカー→ボタンの順", Object.keys(AIX_LEARNED).length === 0 || learnedMeaningFor("estimate_sheet", "single")?.key.startsWith("estimate_sheet") === true);
t("生成側の塊は目的を持つ", aixMeaningForGenerator("meeting_place").includes("目的:"));
t("learnedLine は無い時に空", learnedLine(undefined) === "");
t("お手本に号室を残さない", !/[0-9０-９]s*号室/.test(dump) && !/[0-9]号室/.test(maskExemplar("セレニテ 1501号室です")));
{ const fake = { key: "estimate_sheet/single", purpose: "", writeContains: ["金額（100%）", "入居日・退去日（100%）"], structure: null, nextStep: [], before: [], exemplars: [], counts: { owner: 9, all: 9, misPressStaff: 0, misPressOwner: 0 }, needsOwnerGold: false, kb: [] };
  t("定型の文の話題（御見積書の入居日）はブレインに見せない", learnedLine(fake).includes("金額") && !learnedLine(fake).includes("入居日")); }

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail) process.exit(1);
