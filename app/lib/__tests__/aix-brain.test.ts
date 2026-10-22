// 2026-10-22 AIX のブレイン（実行の指揮官＋実行役＋確かめ）の純関数。名前・物件は伏せた形
// 実行: npx tsx app/lib/__tests__/aix-brain.test.ts
import { aixBrainOn, aixBrainEnabledFor, copyNamesVerbatim, dupFunctionsOf, mustItemsOf, missingMust, unfoundedFacts, checkAixText, chooseText, parseConductorPlan, parseExecutorMessage, parseExecutorParts, assembleText, tokenizeName, restoreName, issueWeight, formHintOf, buildConductorUser, AIX_BRAIN_ACTION } from "../aix-brain";
import { staffInputsFromBody, pickerValueOf } from "../aix-brain-inputs";
import { isAltRouteDenied, shouldRouteAlt, targetConfigFor, type AltProviderConfig } from "../llm-alt-provider";

let passed = 0, failed = 0; const failures: string[] = [];
function ok(name: string, cond: boolean, detail = "") { if (cond) passed++; else { failed++; failures.push(`${name} ${detail}`); } }

// スイッチ（2026-10-23 ボタンごと・既定＝内覧日調整だけ）
ok("既定は内覧日調整だけ", aixBrainEnabledFor("viewing_invite", {}) && !aixBrainEnabledFor("property_send", {}) && !aixBrainEnabledFor("property_check_result", {}) && !aixBrainEnabledFor("property_recommendation", {}));
ok("既定で入っている", aixBrainOn({}));
ok("on は全部", aixBrainOn({ AIX_BRAIN: "on" }) && aixBrainEnabledFor("property_send", { AIX_BRAIN: "on" }) && aixBrainEnabledFor("viewing_invite", { AIX_BRAIN: "ON" }));
ok("off は全部止める", !aixBrainOn({ AIX_BRAIN: "off" }) && !aixBrainEnabledFor("viewing_invite", { AIX_BRAIN: "off" }));
ok("名前の並び", aixBrainEnabledFor("property_send", { AIX_BRAIN: "viewing_invite, property_send" }) && !aixBrainEnabledFor("property_check_result", { AIX_BRAIN: "viewing_invite,property_send" }));
ok("名前だけで内覧を外せる", !aixBrainEnabledFor("viewing_invite", { AIX_BRAIN: "property_send" }));

// 物件名は入力の字のまま（鳳Ⅱ→鳳II を抜けと数える・組み立てで戻す）
ok("ローマ数字を書き換えた名前は抜け", missingMust("プレミアス鳳II 102号室お部屋ご案内させて頂きます！！", ["プレミアス鳳Ⅱ"]).length === 1);
ok("入力の字のままなら抜けでない", missingMust("プレミアス鳳Ⅱ 102号室お部屋ご案内させて頂きます！！", ["プレミアス鳳Ⅱ"]).length === 0);
ok("必ず入れる字は入力の字のまま", mustItemsOf({ aixType: "viewing_invite", staffInputs: [["物件名", "プレミアス鳳Ⅱ 102号室"]] }).includes("プレミアス鳳Ⅱ"));
{
  const r = copyNamesVerbatim("プレミアス鳳IIの102号室にてご案内させて頂きます！！", ["プレミアス鳳Ⅱ 102号室"]);
  ok("書き換えた名前を入力の字に戻す", r.text === "プレミアス鳳Ⅱの102号室にてご案内させて頂きます！！" && r.fixes.length === 1, r.text);
  ok("字が同じ所は触らない", copyNamesVerbatim("プレミアス鳳Ⅱ 102号室", ["プレミアス鳳Ⅱ 102号室"]).fixes.length === 0);
  ok("別の名前（鳳III）は触らない", copyNamesVerbatim("プレミアス鳳III", ["プレミアス鳳Ⅱ"]).text === "プレミアス鳳III");
}
// 同じ働きの文を重ねない（2026-10-23 レビュー: 内覧のご希望承りました＋お部屋ご案内させて頂きます）
{
  const draft = "YUMAさん夜分遅くに失礼致します！！\nかしこまりました！！\nお部屋ご案内させて頂きます！！\n直近ですと\n10/24(土) 16:00〜18:00\n10/25(日) 14:00〜15:30にてご案内可能です！！\n\nYUMAさんご都合よろしいお日にち御座いますでしょうか😌！！";
  const plan = { drop: [], add: [{ part: "本題", after: "かしこまりました！！", brief: "物件名", facts: ["プレミアス鳳Ⅱ 102号室"] }, { part: "受け", after: "先頭", brief: "受け", facts: [] }] };
  const out = assembleText(draft, plan, ["プレミアス鳳Ⅱの102号室にてご案内させて頂きます😊！！", "内覧のご希望承りました！！"], { keyFacts: ["プレミアス鳳Ⅱ"] });
  ok("受けは重ねない", !out.includes("承りました") && (out.match(/かしこまりました/g) ?? []).length === 1, out);
  ok("ご案内の宣言は1回・物件名のある方に入れ替え", (out.match(/ご案内させて頂きます/g) ?? []).length === 1 && out.includes("プレミアス鳳Ⅱの102号室にてご案内させて頂きます"), out);
  ok("入れ替えは下書きの場所のまま", out.indexOf("プレミアス鳳Ⅱ") < out.indexOf("直近ですと"), out);
  ok("重なりの確かめ", checkAixText("かしこまりました！！\n内覧のご希望承りました！！\nお部屋ご案内させて頂きます！！\n物件にてご案内させて頂きます！！", { must: [], basis: "", staffBasis: "", callName: null }).dupParts.length === 2);
  ok("重なりなし", checkAixText(draft, { must: [], basis: "", staffBasis: "", callName: null }).dupParts.length === 0);
}
// 日時の段を割らない・ご都合の伺いは日時の後
{
  const draft = "かしこまりました！！\n\n直近ですと\n10/30(金) 13:00〜15:00\n10/31(土) 16:00〜17:30\nにてご案内可能です！！";
  const out = assembleText(draft, { drop: [], add: [{ part: "締め", after: "10/31(土) 16:00〜17:30", brief: "都合", facts: [] }] }, ["ご都合よろしいお日にち御座いますでしょうか😌！！"]);
  ok("日時の段を割らない", /17:30\nにてご案内可能です！！\n\nご都合よろしい/.test(out), out);
  const out2 = assembleText(draft, { drop: [], add: [{ part: "締め", after: "先頭", brief: "都合", facts: [] }] }, ["ご都合よろしいお日にち御座いますでしょうか😌！！"]);
  ok("ご都合の伺いは日時の後", out2.indexOf("ご都合") > out2.indexOf("にてご案内可能"), out2);
  const out3 = assembleText(draft, { drop: [], add: [{ part: "日時", after: "先頭", brief: "日時", facts: [] }] }, ["直近ですと\n10/30(金) 13:00〜15:00にてご案内可能です！！"]);
  ok("日時の段は2回足さない", (out3.match(/直近ですと/g) ?? []).length === 1, out3);
  // 試験 it2-view-r1（02c26493）: 下書きが3つ目の日時と「Ⅱ・号室」を落とした → 部品の段・物件名の文で入れ替える
  const d2 = "かしこまりました！！\n\nプレミアス鳳お部屋ご案内させて頂きます！！\n\n直近ですと\n10/24(土) 16:00〜18:00\n10/25(日) 14:00〜15:30にてご案内可能です😊！！\n\nYUMAさんご都合よろしいお日にち御座いますでしょうか😌！！";
  const out4 = assembleText(d2, { drop: [], add: [{ part: "日時", after: "締めの前", brief: "", facts: [] }, { part: "本題", after: "かしこまりました！！", brief: "", facts: [] }] },
    ["直近ですと\n10/24(土) 16:00〜18:00\n10/25(日) 14:00〜15:30\n10/26(月) 13:00〜15:00にてご案内可能です！！", "プレミアス鳳Ⅱ 102号室お部屋ご案内させて頂きます！！"], { keyFacts: ["プレミアス鳳Ⅱ"] });
  ok("日時の行が多い段に入れ替える", (out4.match(/直近ですと/g) ?? []).length === 1 && out4.includes("10/26(月) 13:00〜15:00にてご案内可能です") && out4.indexOf("10/26") < out4.indexOf("ご都合"), out4);
  ok("物件名の全部ある文に入れ替える", out4.includes("プレミアス鳳Ⅱ 102号室お部屋ご案内させて頂きます") && (out4.match(/ご案内させて頂きます/g) ?? []).length === 1, out4);
  // 試験 it2b-view-r3: 下書きの段が「最短ですと」（空行つき）→ 段として見て入れ替える
  const d3 = "かしこまりました😊！！\n\nプレミアス鳳Ⅱ 102号室にてご案内致します！！\n\n最短ですと\n\n10/24(土) 16:00〜18:00\n10/25(日) 14:00〜15:30にてご案内可能です！！\n\nYUMAさんご都合よろしいお日にち御座いますでしょうか😌！！";
  const out5 = assembleText(d3, { drop: [], add: [{ part: "日時", after: "最短ですと", brief: "", facts: [] }] }, ["直近ですと\n10/24(土) 16:00〜18:00\n10/25(日) 14:00〜15:30\n10/26(月) 13:00〜15:00\nにてご案内可能です！！"]);
  ok("最短ですとの段も1つにする", !/最短ですと/.test(out5) && (out5.match(/直近ですと/g) ?? []).length === 1 && (out5.match(/10\/24/g) ?? []).length === 1 && out5.includes("10/26"), out5);
  ok("字を落とした名前（鳳Ⅱ→鳳）は抜け", missingMust("プレミアス鳳お部屋ご案内させて頂きます！！", ["プレミアス鳳Ⅱ"]).length === 1);
  // 試験 it2c-all-default: 部品が抜けた日時の行だけを返した → 下書きの段の最後に足す（段を2つにしない・にてご案内可能は最後の行へ）
  const d4 = "かしこまりました😊！！\n\n直近ですと\n10/24(土) 16:00〜18:00\n10/25(日) 14:00〜15:30にてご案内可能です！！\n\nYUMAさんご都合よろしいお日にち御座いますでしょうか😌！！";
  const out6 = assembleText(d4, { drop: [], add: [{ part: "日時", after: "締めの前", brief: "", facts: [] }] }, ["直近ですと\n10/26(月) 13:00〜15:00にてご案内可能です！！"]);
  ok("抜けた日時の行だけ足す", /15:30\n10\/26\(月\) 13:00〜15:00にてご案内可能です！！/.test(out6) && (out6.match(/直近ですと/g) ?? []).length === 1 && (out6.match(/ご案内可能/g) ?? []).length === 1, out6);
  ok("「案内させて」も宣言", dupFunctionsOf("お部屋を案内させて頂きます！！\n内覧の日程もご案内させて頂きます！！").includes("ご案内の宣言"));
  ok("抜けが無くなる", missingMust(out4, ["10/26(月) 13:00〜15:00", "プレミアス鳳Ⅱ"]).length === 0, out4);
}

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
