// app/lib/__tests__/reply-scene-brain.test.ts — 11巡目（10/08）場面をブレインの判断に寄せる（実行: npx tsx app/lib/__tests__/reply-scene-brain.test.ts）
//   文とブレインの判断は本番の実物（40日の変わる番を scripts/audit-r11-scene-brain.ts で1番ずつ読んだ物・名前は伏せた）
import { resolveReplySceneBrainFirst, splitThisTurnQuestions, replySceneBrainEnabled, type BrainSceneInput } from "../reply-scene-brain";
let pass = 0, fail = 0;
const t = (name: string, ok: boolean, got?: unknown) => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name}${got !== undefined ? ` → ${JSON.stringify(got)}` : ""}`); } };
const B = (o: Partial<BrainSceneInput>): BrainSceneInput => ({ fresh: true, intent: null, questions: [], conditionChangeType: null, hesitancy: null, action: null, ...o });
const sc = (text: string, b: BrainSceneInput | null) => resolveReplySceneBrainFirst({ customerText: text, brain: b }).scene;

console.log("■ ブレインが判断していない時は語の場面（予備）");
t("brain null → 語", sc("ありがとうございます！確認してみます！", null) === "other");
t("古い判断（fresh=false）→ 語", sc("本日電話連絡いける時間を教えてもらえますか？", B({ fresh: false, intent: "question", questions: ["本日電話できる時間はいつか"] })) === "other");
t("enabled=false → 語", resolveReplySceneBrainFirst({ customerText: "白基調の部屋はあんまりないですかね？💦", brain: B({ intent: "desire", conditionChangeType: "equip_add" }), enabled: false }).scene === "question");
t("REPLY_SCENE_BRAIN=off", replySceneBrainEnabled({ REPLY_SCENE_BRAIN: "off" }) === false && replySceneBrainEnabled({}) === true && replySceneBrainEnabled({}, "off") === false);

console.log("■ 形の場面は語のまま");
t("物件の URL", sc("https://suumo.jp/chintai/bc_100486584237/", B({ intent: "question", questions: ["この物件の初期費用を知りたい"] })) === "property_share");
t("条件のフォーム", sc("▶︎【お部屋お探し中！】\n（ご希望のお部屋探しご条件）\n①【ご入居の時期】⇒ 10.11月\n②【ご希望の家賃（◯万円〜◯万円）】⇒ 〜10万", B({ intent: "question", questions: ["提示した条件で初期費用が収まるか"], action: "property_send" })) === "conditions");

console.log("■ ブレインの判断で決まる（本番の実物）");
t("その他→質問: 電話の時間（0133b787）", sc("本日電話連絡いける時間を教えてもらえますか？", B({ intent: "question", questions: ["本日電話できる時間はいつか"], action: "property_search" })) === "question");
t("質問→条件: 白基調の部屋（9faff2ec・竹内さんはオススメ1件）", sc("白基調の部屋はあんまりないですかね？💦", B({ intent: "desire", questions: ["白基調の部屋は少ないか"], conditionChangeType: "equip_add", action: "property_send" })) === "conditions");
t("質問→条件: ブラックでも行けますか（c795e4d7・竹内さん「独立系に絞りピックアップ」）", sc("ペットなしでも可能です！\nブラックでも行けますか（ ; ; ）", B({ intent: "desire", questions: ["ブラックでも審査に通るか"], conditionChangeType: "equip_add", action: "property_send" })) === "conditions");
t("その他→検討中: 確認してみます（c1c065ce・竹内さん「気になる点出てきましたら」）", sc("ありがとうございます！確認してみます！", B({ intent: "positive", hesitancy: "thinking" })) === "considering");
t("その他→短いお礼: 15時以降にお電話いたします（8590144d）", sc("かしこまりました！\n15時以降にお電話いたします！", B({ intent: "chat" })) === "ack");
t("質問→費用: 礼金下げることは（ad97cd40）", sc("こちら、礼金下げることは厳しいですか🥲", B({ intent: "consultation", questions: ["堀江サン・ユー501号室の礼金を下げられるか"], action: "estimate_sheet" })) === "cost");
t("質問→申込: 在籍証明（5752c0d1）", sc("免許証ないです\n在籍証明どんなんですかね", B({ intent: "question", questions: ["免許証がない場合どうすればいいか", "在籍証明はどのような書類か"] })) === "apply");
t("質問→内覧: 集合時間の変更（5dd2d456）", sc("集合時間16:30か17:00に変更お願い出来ますでしょうか？？", B({ intent: "question", questions: ["本日の集合時間を16:30か17:00に変更できるか"], action: "meeting_place" })) === "viewing");
t("短いお礼→申込: 申込の意思＋AIX（969f0162）", sc("よろしくお願いします", B({ intent: "decision", action: "application_push" })) === "apply");
t("検討中→条件: 収納少ないので一旦なし（b50fd451）", sc("ごめんなさい収納少ないので一旦なしで😭😭", B({ intent: "desire", conditionChangeType: "equip_add" })) === "conditions");

console.log("■ 引きずり（今の番に無い前の判断）は使わない");
t("お願いします に cond=equip_add（ad97cd40）→ 短いお礼", sc("お願いします", B({ intent: "desire", conditionChangeType: "equip_add", action: "property_send" })) === "ack");
t("承知致しました に q=前の募集確認（0133b787）→ 短いお礼", sc("承知致しました。\n宜しくお願い致します。", B({ intent: "question", questions: ["エスリード難波ザ.ブライトの募集が出ているか確認してほしい"], hesitancy: "waiting" })) === "ack");
t("遅れます に cond=condition_relax（6fdadc8b）→ 内覧", sc("お世話になっております！\nこちらこそよろしくお願いいたします🙇‍♀️\nすみません道が混んでて5分から10分ほど遅れます🙇‍♀️", B({ intent: "desire", conditionChangeType: "condition_relax", action: "property_send" })) === "viewing");
t("付き添いで1人 に cond=pickup_request（84434172）→ 内覧", sc("かしこまりました。\n付き添いで1人着いてきます", B({ intent: "desire", conditionChangeType: "pickup_request", action: "property_send" })) === "viewing");
t("こんにちは！ に hes=callback（c024b7b9）→ その他（挨拶）", sc("こんにちは！", B({ intent: "chat", hesitancy: "callback" })) !== "considering");
t("もう少し探していただけますか？ に hes=callback（3db9db75・竹内さん「新着状況随時確認」）→ 条件のまま", sc("もう少し探していただけますか？", B({ intent: "desire", hesitancy: "callback", action: "property_send" })) === "conditions");
t("どっちも気になります（undecided・ae18c038・竹内さん「一度ご内覧如何でしょうか」）→ 検討中にしない", sc("どっちも気になります", B({ intent: "positive", hesitancy: "undecided", action: "viewing_invite" })) !== "considering");
t("こんなに安いんですね！（positive）→ 短いお礼にしない（訴求の材料が要る）", sc("こんなに安いんですね！", B({ intent: "positive" })) === "other");
t("2028/3月以降入居 4~7万 2LDK…（初回の条件・cond なし）→ 条件のまま", sc("2028/3月以降入居 4~7万 2LDK 20年以内 駅から徒歩10分 20万", B({ intent: "desire" })) === "conditions");
t("電話の時間の確認に AIX=待ち合わせ（58ae93f3）→ 内覧にしない", sc("14:30-15:00くらいに掛けても大丈夫でしょうか？", B({ intent: "decision", questions: ["14:30-15:00に電話しても大丈夫か"], action: "meeting_place" })) === "question");
t("質問ありの番で質問なしの判断（ブレインの漏れ）は語のまま: 初期費用は抑えること厳しいですか", sc("こちらの初期費用は抑えること厳しいですか？", B({ intent: "negative", action: "property_send" })) === "cost");

console.log("■ splitThisTurnQuestions（引きずりの線）");
{
  const r = splitThisTurnQuestions(["昭和グランドハイツ恵美須の初期費用はいくらか"], "ありがとうございます。");
  t("お礼だけの番の質問は引きずり", r.dragged.length === 1 && r.kept.length === 0, r);
  const r2 = splitThisTurnQuestions(["ヴィレ堺湊102号室はペット2匹飼育可能か"], "こちらペット2匹可能でしょうか？");
  t("「こちら」を物件名に読み替えた今の質問は残す", r2.kept.length === 1, r2);
  const r3 = splitThisTurnQuestions(["大阪難波Noah203号室を内覧したい"], "ここ見てみたいです!");
  t("問いの形の無い依頼（見てみたいです）は残す", r3.kept.length === 1, r3);
  const r4 = splitThisTurnQuestions(["アコード中之島1402号室の初期費用はいくらか"], "ありがとうございます！\nこちらの初期費用見積もりだしていただきたいです！");
  t("お礼＋依頼の番は残す", r4.kept.length === 1, r4);
}

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exitCode = 1;
