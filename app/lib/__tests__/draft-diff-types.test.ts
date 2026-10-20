// app/lib/__tests__/draft-diff-types.test.ts — 下書き×送った文の中身の型（作り物の文だけ・LLM なし）
//   実行: npx tsx app/lib/__tests__/draft-diff-types.test.ts
import { classifyDraftDiff, maskText, addedKindOf, removedKindOf } from "../draft-diff-types";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, info?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}`, info ?? ""); } };

// 主の型
t("下書きなし", classifyDraftDiff(null, "はい！！").primary === "no_draft");
t("空白だけの下書きも下書きなし", classifyDraftDiff("  ", "はい！！").primary === "no_draft");
t("そのまま", classifyDraftDiff("かしこまりました！！\n確認致します😊！！", "かしこまりました！！\n確認致します😊！！").primary === "unchanged");
t("表面だけ（絵文字・！）", classifyDraftDiff("かしこまりました！\n確認致します😊", "かしこまりました！！\n確認致します😌！！").primary === "trivial");
t("表記の揺れ（頂き/いただき）", classifyDraftDiff("ご連絡頂きありがとうございます！！", "ご連絡いただきありがとうございます！！").primary === "trivial");
{
  const r = classifyDraftDiff("駐車場の空きは現在ございません。近隣の月極もお探し出来ます。", "犬の飼育は小型犬1匹まで可能です！！ペット敷金が別途かかります！！");
  t("丸ごと差し替え", r.primary === "replaced", r);
}

// 足した
{
  const r = classifyDraftDiff("テストさん\nご連絡ありがとうございます😊！！", "テストさん\nご連絡ありがとうございます😊！！\n管理会社に確認致しましたところ、ペット可となります！！");
  t("足した: スタッフだけが知る事", r.content.includes("added:staff_only") && r.primary === "content_edit", r);
}
{
  const r = classifyDraftDiff("かしこまりました！！", "かしこまりました！！\n空き状況を確認して本日中にご連絡させて頂きます😊！！");
  t("足した: 約束", r.content.includes("added:promise"), r);
}
{
  const r = classifyDraftDiff("ありがとうございます！！\n設備について承知しました。", "ありがとうございます！！\n設備について承知しました。\nよろしければ一度ご内覧いかがでしょうか😊！！");
  t("足した: 内覧の誘い", r.content.includes("added:invite_viewing"), r);
}
{
  const r = classifyDraftDiff("ご検討ありがとうございます😊！！", "ご検討ありがとうございます😊！！\nお気に召されましたらお申込も可能です！！");
  t("足した: 申込の誘い", r.content.includes("added:invite_apply"), r);
}
{
  const r = classifyDraftDiff("ご質問ありがとうございます！！", "ご質問ありがとうございます！！\n敷金は不要となります！！");
  t("足した: 答え", r.content.includes("added:answer"), r);
}
{
  const r = classifyDraftDiff("ご返信ありがとうございます😊！！", "テストさん\nお世話になっております😊！！\nご返信ありがとうございます😊！！");
  t("足した: 名前・挨拶", r.content.includes("added:name") && r.content.includes("added:greeting"), r);
}

// 消した
{
  const r = classifyDraftDiff("物件資料をお送りしました！！ご査収下さいませ😊", "物件資料をお送りしました！！");
  t("消した: ご査収", r.content.includes("removed:gosashu"), r);
}
{
  const r = classifyDraftDiff("かしこまりました！！\n本日はありがとうございました😊", "本日はありがとうございました😊");
  t("消した: かしこまりました（書き直しに入る）", r.content.includes("removed:kashikomari") && r.primary === "rewritten_tone", r);
}
{
  const r = classifyDraftDiff("ご連絡ありがとうございます！！\n管理会社に確認致しましたところ、募集終了となっておりました。", "ご連絡ありがとうございます！！");
  t("消した: スタッフだけが知る事（AI の言い切り）", r.content.includes("removed:staff_only"), r);
}
{
  const r = classifyDraftDiff("それでは10月12日の14時にお待ちしております！！", "それでは10月13日の14時にお待ちしております！！");
  t("直した: 違う日付", r.content.includes("removed:wrong_date") && r.primary === "content_edit", r);
}
{
  const r = classifyDraftDiff("テストハイツ201号室のお見積となります！！", "テストハイツ305号室のお見積となります！！");
  t("直した: 違う物件・号室", r.content.includes("removed:wrong_property"), r);
}
{
  const r = classifyDraftDiff("初期費用は約25万円となります！！", "初期費用は約28万円となります！！");
  t("直した: 違う数字", r.content.includes("removed:wrong_fact"), r);
}

// 文1つの種類
t("足した文の種類: 名前", addedKindOf("テストさん") === "name");
t("足した文の種類: お客様への依頼", addedKindOf("お手隙の際にご入力ください！！") === "request");
t("消した文の種類: 条件付きの内覧の誘い", removedKindOf("お気に召されましたら、ご都合よろしいお日にちにお部屋ご案内させて頂きます。") === "invite_viewing");
{ const m = maskText("Sample Court 本町テスト 201号室"); t("伏せ字: 英字・号室の前の物件名", !/Sample|Court|本町/.test(m), m); }
t("足した文の種類: 聞き返し", addedKindOf("何日でのご入居ご希望でしょうか！！") === "ask");
t("消した文の種類: 受け止め・決意", removedKindOf("お部屋探し全力でお手伝いさせて頂きます！！") === "empathy");
t("消した文の種類: 締め", removedKindOf("本日のご連絡お待ちしております😌！！") === "closing");
t("消した文の種類: 答え", removedKindOf("弊社でお申込みしてお部屋を抑えられます！！") === "answer");
t("画像の置き場所は足した文に数えない", classifyDraftDiff("ありがとうございます！！", "ありがとうございます！！\n[画像]").added.length === 0);
t("消した文の種類: その他", removedKindOf("なるほど") === "other");

// 伏せ字
{
  const m = maskText("テストさん 0901234567 サンプルハイツ201号 https://example.com/x");
  t("伏せ字: 名前・数字・カタカナ・URL", !/テスト|サンプル|\d|example/.test(m), m);
}
t("伏せ字: 長さで切る", maskText("あ".repeat(100), 10).length === 11);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
