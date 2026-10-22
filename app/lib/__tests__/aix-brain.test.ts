// 2026-10-22 AIX のブレイン（実行の指揮官＋実行役＋確かめ）の純関数。名前・物件は伏せた形
// 実行: npx tsx app/lib/__tests__/aix-brain.test.ts
import { aixBrainOn, mustItemsOf, missingMust, unfoundedFacts, checkAixText, chooseText, parseConductorPlan, parseExecutorMessage, parseExecutorParts, assembleText, tokenizeName, restoreName, issueWeight, formHintOf, buildConductorUser, AIX_BRAIN_ACTION } from "../aix-brain";
import { staffInputsFromBody, pickerValueOf } from "../aix-brain-inputs";
import { isAltRouteDenied, shouldRouteAlt, targetConfigFor, type AltProviderConfig } from "../llm-alt-provider";

let passed = 0, failed = 0; const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") { if (cond) passed++; else { failed++; failures.push(`${name} ${detail}`); } }

// スイッチ（既定 off）
ok("既定 off", !aixBrainOn({}));
ok("on", aixBrainOn({ AIX_BRAIN: "on" }));
ok("off", !aixBrainOn({ AIX_BRAIN: "off" }));

// 網: 必ず入れる字（カレンダーの行・物件名）
const must = mustItemsOf({ aixType: "viewing_invite", staffInputs: [["内覧の候補日時（カレンダー）", "10/16(金) 13:00〜15:00\n10/17(土) 16:00〜17:30にてご案内可能です！！"], ["物件名", "サンプル桜川 902号室"]] });
ok("カレンダーの行", must.includes("10/16(金) 13:00〜15:00") && must.includes("10/17(土) 16:00〜17:30"), JSON.stringify(must));
ok("物件名（号室を外す）", must.includes("サンプル桜川"), JSON.stringify(must));
ok("抜けを見つける", missingMust("はい😊！！何卒よろしくお願い致します😌！！", must).length === 3);
ok("全部ある", missingMust("かしこまりました😊！！\nサンプル桜川お部屋ご案内させて頂きます！！\n直近ですと\n10/16(金) 13:00〜15:00\n10/17(土) 16:00〜17:30にてご案内可能です！！", must).length === 0);
ok("曜日の表記の揺れ", missingMust("10/16（金）13:00〜15:00", ["10/16(金) 13:00〜15:00"]).length === 0);

// 確かめ: 材料に無い数字・埋め字・伏せ字・スタッフの入力に無い言い切り
ok("材料に無い金額", unfoundedFacts("家賃管理費込123,000円", "家賃113,000円・管理費10,000円").includes("金額:123000"));
ok("材料にある金額", unfoundedFacts("合計123,000円", "（合計123,000円）").length === 0);
ok("万円の言い方", unfoundedFacts("120,000円", "12万円まで").length === 0);
const c1 = checkAixText("YUMAさん本町駅から徒歩〇〇分以内のお部屋ピックアップさせて頂きました😊！！", { must: [], basis: "", staffBasis: "", callName: "YUMA", draft: "YUMAさん" });
ok("埋め字", c1.placeholder);
const c2 = checkAixText("〈名前〉さんお世話になっております！！", { must: [], basis: "", staffBasis: "", callName: "YUMA" });
ok("伏せ字の残り", c2.maskLeak);
const c3 = checkAixText("もう1件は募集終了となっております！！", { must: [], basis: "", staffBasis: "1件目 募集中", callName: null });
ok("入力に無い募集終了", c3.staffNoBasis.includes("募集終了"));
const c4 = checkAixText("こちら現在募集中となります！！", { must: [], basis: "", staffBasis: "1件目 募集中", callName: null });
ok("入力にある募集中", c4.staffNoBasis.length === 0);
ok("名前が消えた", checkAixText("お世話になっております！！", { must: [], basis: "", staffBasis: "", callName: "YUMA", draft: "YUMAさんお世話になっております！！" }).nameLost);

// 決めた締めの向き
ok("内覧へが無い", checkAixText("お手隙の際にご査収ください😌！！", { must: [], basis: "", staffBasis: "", callName: null, closeKind: "viewing" }).closeMissing === "viewing");
ok("内覧へがある", checkAixText("お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます！！", { must: [], basis: "", staffBasis: "", callName: null, closeKind: "viewing" }).closeMissing === null);
ok("日を伺う", checkAixText("YUMAさんご都合よろしいお日にち御座いますでしょうか😌！！", { must: [], basis: "", staffBasis: "", callName: null, closeKind: "ask_date" }).closeMissing === null);
// 選ぶ: 実行役の文が悪くなったら下書き
const chk = (t: string) => checkAixText(t, { must, basis: "10/16(金) 13:00〜15:00 10/17(土) 16:00〜17:30 サンプル桜川", staffBasis: "", callName: null });
const good = "かしこまりました😊！！\nサンプル桜川お部屋ご案内させて頂きます！！\n直近ですと\n10/16(金) 13:00〜15:00\n10/17(土) 16:00〜17:30にてご案内可能です！！";
ok("良くなれば実行役", chooseText("はい😊！！", good, chk).used === "brain");
ok("悪くなれば下書き", chooseText(good, "はい😊！！", chk).used === "draft");
ok("空は下書き", chooseText(good, "", chk).used === "draft");
ok("埋め字が出たら下書き", chooseText(good, `${good}\n〇〇万円`, chk).used === "draft");
ok("重さ", issueWeight(chk("はい")) > issueWeight(chk(good)));
// 2026-10-23 レビュー: 抜けを埋めても、下書きに無い事実（スタッフの入力に無い言い切り・材料に無い数字）を持ち込んだら下書き
ok("新しい言い切りを持ち込んだら下書き", chooseText("はい😊！！", `${good}
募集終了となっておりました！！`, chk).used === "draft");
ok("材料に無い数字を持ち込んだら下書き", chooseText("はい😊！！", `${good}
家賃は85,000円です！！`, chk).used === "draft");

// 設計図・本文の読み
const plan = parseConductorPlan('```json\n{"keep":false,"why":"日時が無い","drop":["何卒よろしくお願い致します😌！！"],"add":[{"part":"日時","after":"先頭","brief":"候補日","facts":["10/16(金) 13:00〜15:00"]}],"close":"質問"}\n```');
ok("設計図を読む", !!plan && !plan.keep && plan.add.length === 1 && plan.add[0].facts.length === 1 && plan.drop.length === 1 && plan.close === "質問");
ok("部品を読む", JSON.stringify(parseExecutorParts('{"parts":["A","B"]}', 2)) === '["A","B"]');
ok("部品の数が足りなければ null", parseExecutorParts('{"parts":["A"]}', 2) === null);
ok("多い部品は前から使う（飾りの文を足さない）", JSON.stringify(parseExecutorParts('{"parts":["A","B","C"]}', 2)) === '["A","B"]');
// 組み立て: 外す文を消し、部品を置く
const asm = assembleText("YUMAさん夜分遅くに失礼致します！！\nはい😊！！\n何卒よろしくお願い致します😌！！", { drop: ["何卒よろしくお願い致します😌！！"], add: [{ part: "本題", after: "先頭", brief: "", facts: [] }, { part: "締め", after: "締めの前", brief: "", facts: [] }] }, ["サンプル桜川お部屋ご案内させて頂きます！！", "ご都合よろしいお日にち御座いますでしょうか😌！！"]);
ok("組み立て（外す）", !/何卒/.test(asm), asm);
ok("組み立て（先頭の後）", asm.indexOf("サンプル桜川") > asm.indexOf("はい"), asm);
ok("組み立て（末尾）", asm.trim().endsWith("御座いますでしょうか😌！！"), asm);
const asm2 = assembleText("A文です！！\n\nお手隙の際にご査収ください😌！！", { drop: [], add: [{ part: "訴求", after: "締めの前", brief: "", facts: [] }] }, ["B訴求です！！"]);
ok("締めの前に置く", asm2.indexOf("B訴求") < asm2.indexOf("ご査収") && asm2.indexOf("A文") < asm2.indexOf("B訴求"), asm2);
ok("壊れた設計図は null", parseConductorPlan("設計図です") === null);
ok("本文を読む", parseExecutorMessage('{"message":"A\\nB"}') === "A\nB");
ok("読めない本文は空", parseExecutorMessage("A") === "");

// 名前の札
ok("札にして戻す", restoreName(tokenizeName("YUMAさんお世話になっております", "YUMA"), "YUMA") === "YUMAさんお世話になっております");
ok("札", tokenizeName("YUMAさん", "YUMA") === "〈名前〉さん");

// 組み立ての型・指揮官の材料（お手本の文を入れない）
ok("型（内覧日調整）", /直近ですと/.test(formHintOf("viewing_invite", null, "first")));
ok("型（2通目の物件オススメ）", /推す/.test(formHintOf("property_recommendation", "継続ピックアップ", "second")));
const cu = buildConductorUser({ aixType: "viewing_invite", picker: "通常", kind: "first", callName: "YUMA", staffInputs: [["物件名", "サンプル桜川 902号室"]], material: "", recent: [{ sender: "customer", text: "内見したいです" }], draft: "はい", meaning: "【このボタン・ピッカーの意味（竹内基準）】内覧日調整" }, ["サンプル桜川"]);
ok("指揮官の材料", /スタッフが入力した事/.test(cu) && /必ず入れる字/.test(cu) && /お客様: 内見したいです/.test(cu) && /下書き/.test(cu));

// スタッフが入力した事（ピッカーの文言のまま）
const si = staffInputsFromBody("property_check_result", { check_pattern: "other_room_check", other_room: "no_room", prop_statuses: ["available", "unavailable"], calendar_info: "" });
ok("ピッカーが示す確認済み", si.some(([k, v]) => k === "別の部屋の確認の結果" && /募集されていない/.test(v)), JSON.stringify(si));
const siU = staffInputsFromBody("property_check_result", { check_pattern: "unavailable" });
ok("物件なかった＝募集終了の根拠", checkAixText("現在募集に出ていないお部屋となります！！確認させて頂きましたところ", { must: [], basis: "", staffBasis: siU.map(([k, v]) => k + v).join("\n"), callName: null }).staffNoBasis.length === 0, JSON.stringify(siU));
ok("ピッカーの文言", si.some(([k, v]) => /確認結果/.test(k) && v === "別の部屋について確認した"), JSON.stringify(si));
ok("子のピッカー", si.some(([, v]) => v === "別の部屋が無い"), JSON.stringify(si));
ok("物件ごとの結果", si.some(([k, v]) => k === "物件ごとの確認の結果" && /1件目 募集中・2件目 募集終了/.test(v)), JSON.stringify(si));
ok("空は入れない", !si.some(([k]) => /カレンダー/.test(k)));
ok("ピッカーの値", pickerValueOf("property_send", { send_mode: "widen" }) === "widen");

// 出口の振り分け: AIX のブレインは DeepSeek の時 flash・振り分けの名前には書けない
const cfg = { provider: "deepseek", endpoint: "x", apiKey: "k", model: "deepseek-v4-pro", actions: new Set<string>(["reply_generate"]), fallbackToAnthropic: true, allowAutoSend: true, testMode: null, routes: new Map() } as unknown as AltProviderConfig;
ok("DeepSeek に回す", shouldRouteAlt(cfg, AIX_BRAIN_ACTION));
ok("flash", targetConfigFor(cfg, AIX_BRAIN_ACTION).model === "deepseek-flash");
ok("振り分けに書けない", isAltRouteDenied(AIX_BRAIN_ACTION));
ok("Qwen が主なら回さない", !shouldRouteAlt({ ...cfg, provider: "qwen" } as AltProviderConfig, AIX_BRAIN_ACTION));

console.log(`aix-brain: ${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log("  ✗", f); process.exit(1); }
