// 2026-09-27 竹内「AIXのあとのひとこと…実際のスタッフが送った文のように質を上げる」
//   app/lib/template-optimize-context.ts: テンプレ最適化（🟣 AIX モード）の「お客様のメッセージ」の枠・ピッカーの注記・スタッフの実送信の手本
// 実行: npx tsx app/lib/__tests__/template-optimize-context.test.ts（自己完結ハーネス。全 PASS で exit 0）
import {
  resolveTemplateOptimizeMessage, pickerModeNote, applyPickerToTemplate, extractAixPropertyName, aixPropertyNameNote, maskStaffExample, findLeakedSpans, buildStaffExamplesNote, pickStaffExamples, aixSourceSurvivesCut, fixTemplateClosing,
  TEMPLATE_NO_NEW_CUSTOMER_MESSAGE, TEMPLATE_FALLBACK_MESSAGE,
} from "../template-optimize-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function eq<T>(a: T, b: T, msg = "") { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function ok(v: unknown, msg = "") { if (!v) throw new Error(msg || "expected truthy"); }

console.log("resolveTemplateOptimizeMessage");
// 実物: 9/21 𝒮（お客様「ありがとうございます！拝見させていただきます！」の後に🌟ファーストフィオーレ十三エリオを AIX で送った）
const sMsgs = [
  { sender: "customer", text: "ありがとうございます！拝見させていただきます！" },
  { sender: "staff", text: "[画像]", isAix: true },
  { sender: "staff", text: "🌟ファーストフィオーレ十三エリオ 205号室\n\n家賃管理費込…", isAix: true },
];
it("最後のお客様の発言の後にこちらが AIX を送っていれば「新着なし・AIX の続き」（返事の出だしを誘わない）", () => {
  const r = resolveTemplateOptimizeMessage(sMsgs, { afterAix: true });
  eq(r.reason, "aix_continuation"); eq(r.message, TEMPLATE_NO_NEW_CUSTOMER_MESSAGE);
});
it("AIX モードでない（🟠）時は旧来どおり最後のお客様の発言", () => {
  eq(resolveTemplateOptimizeMessage(sMsgs, { afterAix: false }).message, "ありがとうございます！拝見させていただきます！");
});
it("お客様の発言が最後（まだこちらが送っていない）なら、その発言（AIX モードでも）", () => {
  const m = [...sMsgs, { sender: "customer", text: "12階ではないのでしょうか？" }];
  const r = resolveTemplateOptimizeMessage(m, { afterAix: true });
  eq(r.reason, "last_customer"); eq(r.message, "12階ではないのでしょうか？");
});
it("画像だけの通は発言に数えない（旧来どおり）", () => {
  const m = [{ sender: "customer", text: "初期費用119.000円ですか？" }, { sender: "customer", text: "[画像]" }];
  eq(resolveTemplateOptimizeMessage(m, { afterAix: false }).message, "初期費用119.000円ですか？");
});
it("お客様の発言が1通も無ければ合成文（AIX は続きの文）", () => {
  eq(resolveTemplateOptimizeMessage([{ sender: "staff", text: "🌟A 101" }], { afterAix: true }).message, TEMPLATE_NO_NEW_CUSTOMER_MESSAGE);
  eq(resolveTemplateOptimizeMessage([], { afterAix: false }).message, TEMPLATE_FALLBACK_MESSAGE);
});

console.log("pickerModeNote");
it("新着1件だけ比べる言い方を止める注記", () => {
  ok(pickerModeNote("新着1件").includes("お送りさせて頂きましたお部屋の中でも"));
  eq(pickerModeNote("新規ピックアップ"), ""); eq(pickerModeNote("継続ピックアップ"), ""); eq(pickerModeNote(null), "");
});

console.log("applyPickerToTemplate");
// 実物: テンプレ「1件特にオススメ」の原文
const TPL_ONE = "お送りさせて頂きましたお部屋の中でも特に〇〇が築年数も新しく費用を抑える事ができ、アカウント名さんにかなりオススメ出来るお部屋となります！！\n\nアカウント名さんお気に召されたお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
it("新着1件: 比べる言い方を外し、物件名から書き出す骨格にする（残りの文字はそのまま）", () => {
  eq(applyPickerToTemplate(TPL_ONE, "新着1件"), TPL_ONE.replace("お送りさせて頂きましたお部屋の中でも特に", ""));
});
it("ピックアップ（新規・継続）・不明の時は触らない（比べる言い方が正しい）", () => {
  eq(applyPickerToTemplate(TPL_ONE, "新規ピックアップ"), TPL_ONE);
  eq(applyPickerToTemplate(TPL_ONE, "継続ピックアップ"), TPL_ONE);
  eq(applyPickerToTemplate(TPL_ONE, null), TPL_ONE);
});

console.log("extractAixPropertyName / aixPropertyNameNote");
it("実物: 🌟の行・【】の見出し（号室あり）から物件名をそのまま取る", () => {
  eq(extractAixPropertyName("🌟プレアデス本田 703\n\n新着でかなり条件のいいお部屋となります！！"), "プレアデス本田 703");
  eq(extractAixPropertyName("【サザンネスト住ノ江駅前 201号室】\n\n初期費用さらに\n🌟82,000円割引させて頂き\n初期費用：198,200円"), "サザンネスト住ノ江駅前 201号室");
});
it("🌟が2行以上（ピックアップの一覧）・先頭が物件名でない・号室の無い【】は取らない", () => {
  eq(extractAixPropertyName("🌟A 101\n家賃…\n🌟B 202\n家賃…"), "");
  eq(extractAixPropertyName("お世話になっております！！\n🌟A 101"), "");
  eq(extractAixPropertyName("【初期費用について】\n…"), "");
  eq(extractAixPropertyName(""), "");
});
it("注記: 物件名があれば「1文字も変えずに」、無ければ空", () => {
  ok(aixPropertyNameNote("プレアデス本田 703").includes("「プレアデス本田 703」を1文字も変えずに"));
  eq(aixPropertyNameNote(""), "");
});

console.log("maskStaffExample（実物の本文そのまま）");
it("慶次 9/21 の実送信を手本にした時: 区の地名・日だけの日付・時刻を伏せ、「ご査收」は「ご査収」に", () => {
  const r = maskStaffExample("慶次さんお世話になっております！！\n\n9/30日退去予定のプレアデス本田 703が西区本田の立地・3路線使える利便性・敷金礼金なしと、慶次さんにかなりオススメ出来るお部屋となります😊！！\n\nお手隙の際にご査收ください😌！！", ["慶次"]);
  eq(r.text, "〇〇さんお世話になっております！！\n\n〇月〇日退去予定の〇〇が〇〇の立地・3路線使える利便性・敷金礼金なしと、〇〇さんにかなりオススメ出来るお部屋となります😊！！\n\nお手隙の際にご査収ください😌！！");
  const r2 = maskStaffExample("お気に召されましたら21日の16:00より一緒にご案内させていただきます！！", []);
  eq(r2.text, "お気に召されましたら〇日の〇〇時より一緒にご案内させていただきます！！");
});
it("moe 9/25: 号室の無い物件名（中でも特に〇〇が）・号室の前の物件名（〇〇号室最大限割引し）・年も伏せる", () => {
  const r = maskStaffExample("お送りさせて頂きましたお部屋の中でも特にファステート難波ヴィラントが築年数も新しく、\n敷金礼金なしで、moeさんにかなりオススメ", ["m ◡̈⃝︎ e"]);
  eq(r.text, "お送りさせて頂きましたお部屋の中でも特に〇〇が築年数も新しく、\n敷金礼金なしで、〇〇さんにかなりオススメ");
  eq(r.masked, ["ファステート難波ヴィラント"]);
  eq(maskStaffExample("ジオタワー大阪十三414号室最大限割引しました初期費用の御見積書となります！！", []).text, "〇〇最大限割引しました初期費用の御見積書となります！！");
  eq(maskStaffExample("特に〇〇が2023年築で築年数浅く", []).text, "特に〇〇が〇〇年築で築年数浅く");
});
it("「1日ご入居の場合」の1日は日付として伏せない（形の語）", () => {
  eq(maskStaffExample("1日ご入居の場合", []).text, "1日ご入居の場合");
});
it("未桜 9/25【退去予定】: 名前・物件名・築年月・日付を伏せ、形（新着で・退去予定のため・ご査収）は残す", () => {
  const r = maskStaffExample("未桜さんお世話になっております！！\n新着で1件Veena弁天402が、2025年3月築で築年数も新しく費用を抑える事ができ、未桜さんにかなりオススメ出来るお部屋となります！！\n\n9月30日退去予定のため、10月1日以降ご内覧可能となります！！\n\nお手隙の際にご査収ください😊！！", ["未桜"]);
  eq(r.text, "〇〇さんお世話になっております！！\n新着で1件〇〇が、〇〇年〇月築で築年数も新しく費用を抑える事ができ、〇〇さんにかなりオススメ出来るお部屋となります！！\n\n〇月〇日退去予定のため、〇月〇日以降ご内覧可能となります！！\n\nお手隙の際にご査収ください😊！！");
  eq(r.masked, ["Veena弁天402"]);
});
it("慶次 9/21: 「特に」の後の物件名だけ・駅徒歩は物件名に食い込まない", () => {
  const r = maskStaffExample("お送りさせて頂きましたお部屋の中でも特にグランコート 201号室が十三駅徒歩4分・敷金礼金なし・独立系保証会社の日本セーフティーと、慶次さんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にご査収ください😊！！", ["慶次"]);
  eq(r.text, "お送りさせて頂きましたお部屋の中でも特に〇〇が〇〇駅徒歩〇分・敷金礼金なし・独立系保証会社の日本セーフティーと、〇〇さんにかなりオススメ出来るお部屋となります！！\n\nお手隙の際にご査収ください😊！！");
  eq(r.masked, ["グランコート 201号室"]);
});
it("隼斗: 号室の直後の「家賃管理費込89,000円」も物件名と金額を分けて伏せる", () => {
  const r = maskStaffExample("パレス城北401号室家賃管理費込89,000円の2LDK54㎡・敷金礼金なしのお部屋となります😊！！", ["隼斗"]);
  eq(r.text, "〇〇家賃管理費込〇〇円の2LDK〇帖・敷金礼金なしのお部屋となります😊！！");
  eq(r.masked, ["パレス城北401号室"]);
});
it("表示名と違う呼び名（H0N0KA. → HONOKAさん）・行頭のひらがなの名前（みなみさん）も伏せる", () => {
  eq(maskStaffExample("独立洗面台も備わったHONOKAさんにかなりオススメ", ["H0N0KA."]).text, "独立洗面台も備わった〇〇さんにかなりオススメ");
  eq(maskStaffExample("みなみさんお世話になっております！！", ["みなみ🫍⸒⸒"]).text, "〇〇さんお世話になっております！！");
});
it("9/27 検証: ひらがなの呼び名（読点の後・文の途中）も伏せ、前の文は残す（DeepSeek に「あいりさん」「かぁなさん」が届いていた）", () => {
  eq(maskStaffExample("家賃も抑えられ、あいりさんにかなりオススメ", []).text, "家賃も抑えられ、〇〇さんにかなりオススメ");
  eq(maskStaffExample("和室もなくかぁなさんにかなりオススメ", []).text, "和室も〇〇さんにかなりオススメ");
  eq(maskStaffExample("特にあいりさんに", []).text, "特に〇〇さんに");
});
it("9/27 検証: 定型の敬称（お客様・管理会社様・オーナー様・皆さん・お疲れ様）は壊さない", () => {
  eq(maskStaffExample("管理会社様へ確認し、お客様のご希望をオーナー様より了承頂きました！！皆さんお疲れ様です", []).text, "管理会社様へ確認し、お客様のご希望をオーナー様より了承頂きました！！皆さんお疲れ様です");
  eq(maskStaffExample("YUMA様お世話になっております", []).text, "〇〇様お世話になっております");
});
it("🌟の行・「・」の物件の並び・URL を伏せる", () => {
  const r = maskStaffExample("🌟レジュールアッシュ難波MINAMI 402号室\n・Dimora難波\n・ArtizA瓦屋町\n（室内イメージ）\nhttps://suumo.jp/chintai/jnc_000065555322/", []);
  eq(r.text, "🌟〇〇\n・〇〇\n・〇〇\n（室内イメージ）\n（URL）");
  eq(r.masked, ["レジュールアッシュ難波MINAMI 402号室", "Dimora難波", "ArtizA瓦屋町"]);
});
it("「お待たせ致しました」は手本に見せない（お世話になっております に置き換え）", () => {
  ok(!maskStaffExample("桜川さんお待たせ致しました！！", ["A"]).text.includes("お待たせ"));
});

console.log("aixSourceSurvivesCut（線のある会話で AIX の文を残してよいか）");
it("YUMA 9/27: 線より後の履歴に同じ見積書の AIX があれば残す・無ければ渡さない（fail-closed）", () => {
  const aix = "【エステムコート大阪WEST】\n初期費用さらに\n🌟124,050円割引させて頂き\n初期費用：137,980円";
  const kept = [{ sender: "customer", text: "見積もりをいただけますか？" }, { sender: "staff", text: aix }];
  eq(aixSourceSurvivesCut(aix, kept), true);
  eq(aixSourceSurvivesCut(aix, [{ sender: "customer", text: "見積もりをいただけますか？" }]), false);
  eq(aixSourceSurvivesCut(aix, [{ sender: "customer", text: aix }]), false, "お客様の発言は数えない");
  eq(aixSourceSurvivesCut("", kept), false);
});
it("テンプレ「1件特にオススメ」の崩れた締めを、スタッフの多数派の形にして見せる（他の文は触らない）", () => {
  const tpl = "〇〇が築年数も新しく費用を抑える事ができ、アカウント名さんにかなりオススメ出来るお部屋となります！！\n\nアカウント名さんお気に召されたお部屋ご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！";
  eq(fixTemplateClosing(tpl), "〇〇が築年数も新しく費用を抑える事ができ、アカウント名さんにかなりオススメ出来るお部屋となります！！\n\nアカウント名さんお気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！");
  eq(fixTemplateClosing("お気に召されましたらお申込みしお部屋抑えさせて頂きます！！"), "お気に召されましたらお申込みしお部屋抑えさせて頂きます！！");
});
console.log("findLeakedSpans");
it("伏せた物件名が生成に出たら漏れ・今回の材料にもあれば漏れではない", () => {
  eq(findLeakedSpans("特にグランコート 201号室が…", ["グランコート 201号室"], "🌟別の物件 101"), ["グランコート 201号室"]);
  eq(findLeakedSpans("特にグランコート 201号室が…", ["グランコート 201号室"], "🌟グランコート 201号室"), []);
  eq(findLeakedSpans("特にA", ["AB"], ""), []);
});

console.log("buildStaffExamplesNote / pickStaffExamples");
it("手本が無ければ空・あれば「形だけ参考・写さない」を添える", () => {
  eq(buildStaffExamplesNote([]), "");
  const n = buildStaffExamplesNote(["〇〇さんお世話になっております！！"]);
  ok(n.includes("手本1") && n.includes("手本から写さない"));
});
it("同じピッカーを優先・同じ会話は1つまで・同じ文は1つ・今の会話は除く", () => {
  const rows = [
    { text: "A", pickerMode: "新規ピックアップ", conversationId: "c1" },
    { text: "B", pickerMode: "新着1件", conversationId: "c2" },
    { text: "C", pickerMode: "新着1件", conversationId: "c2" },
    { text: "D", pickerMode: "新着1件", conversationId: "c3" },
    { text: " B ", pickerMode: "新着1件", conversationId: "c4" },
    { text: "E", pickerMode: "新着1件", conversationId: "self" },
    { text: "F", pickerMode: null, conversationId: "c5" },
  ];
  eq(pickStaffExamples(rows, { pickerMode: "新着1件", excludeConversationId: "self" }).map((r) => r.text), ["B", "D", "A"]);
  eq(pickStaffExamples(rows, { pickerMode: null, limit: 2 }).map((r) => r.text), ["A", "B"]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(" - " + f); process.exit(1); }
