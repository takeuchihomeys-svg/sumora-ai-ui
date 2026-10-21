// app/lib/__tests__/day-subject-reader.test.ts — 何の日か・確認の相手の読み（決まった処理）と、かしこまりましたの重なり・置き場所の網
//   実行: npx tsx app/lib/__tests__/day-subject-reader.test.ts
//   ※ 文は作った例（実際のお客様の文は使わない）
import { readDateKinds, readConfirmParties, readDaySubject, buildDaySubjectNote, daySubjectNoteIfEnabled, draftConfirmsOwnViewingTime, draftEchoesCustomerDeadline, draftKindNearDate, viewingSchedulingOpen, timeOfDayOf } from "../day-subject-reader";
import { dedupeKashikomarimashita, placeAckInContentBlock, tidyAckForm, ackDedupeEnabled, ackBlockPlaceEnabled } from "../opener-repeat";
import { draftToSendableText } from "../draft-text";

let pass = 0, fail = 0;
const t = (name: string, ok: boolean, extra = "") => { if (ok) { pass++; console.log(`  OK  ${name}`); } else { fail++; console.log(`  NG  ${name} ${extra}`); } };

const SLOTS = "直近ですと\n11/2(月) 13:00〜15:00\n11/3(火) 16:00〜17:30にてご案内可能です！！\nご都合よろしいお日にち御座いますでしょうか！！";
const ASK_MOVE = "大丈夫です！！\nご都合よろしいお日にちにお部屋ご案内させて頂きます！！\n何日でのご入居がご都合よろしいでしょうか！！";

console.log("── 何の日か ──");
{
  // 内覧の調整中（候補日を出した後）・直前の一文が入居を聞いた → 主の流れの内覧の日
  const r = readDateKinds({ customerText: "できれば月末か来月頭あたりが希望です。", staffBefore: [ASK_MOVE, SLOTS], viewingStage: "proposing" });
  t("調整中の『月末か来月頭が希望』は内覧の日", r.length === 1 && r[0].kind === "viewing" && r[0].source === "flow" && r[0].staffAskedMoveIn, JSON.stringify(r));
  const note = buildDaySubjectNote({ dates: r, parties: [] });
  t("注記: 入居の時期ではない・1行", /調整への答え（入居の時期ではない）/.test(note) && note.trim().split("\n").length === 1, note);
}
{
  const r = readDateKinds({ customerText: "10月中に入居したいです", staffBefore: [SLOTS], viewingStage: "proposing" });
  t("文に『入居』があれば調整中でも入居", r[0]?.kind === "move_in" && r[0].source === "explicit");
}
{
  const r = readDateKinds({ customerText: "10月中でいけたら！", staffBefore: ["何日でのご入居ご希望でしょうか！！"], viewingStage: "none" });
  t("調整中でなく直前に入居を聞いた → 入居", r[0]?.kind === "move_in" && r[0].source === "staff_question");
  t("直前の問いだけで読む入居は注記を出さない（自信が無い所は足さない）", buildDaySubjectNote({ dates: r, parties: [] }) === "");
}
{
  const r = readDateKinds({ customerText: "朝方は空いてないでしょうか？", staffBefore: ["土曜 14:00〜16:00 ご案内可能です！！"], viewingStage: "proposing" });
  t("時間帯だけ（朝方）→ 内覧の日時・朝", r[0]?.kind === "viewing" && r[0].timeOfDay === "morning" && r[0].dateText === null, JSON.stringify(r));
}
{
  const r = readDateKinds({ customerText: "全部見て今日中にまた連絡します！", staffBefore: ["お気に召されましたらご案内させて頂きます！！"], viewingStage: "none" });
  t("『今日中にまた連絡します』は お客様からの連絡の期日", r[0]?.kind === "contact");
  const note = buildDaySubjectNote({ dates: r, parties: [] });
  t("注記: 受けの中身（ごゆっくり・何時でもご連絡）＋期日を繰り返さない", /ごゆっくり/.test(note) && /何時でもご連絡/.test(note) && /繰り返さない/.test(note), note);
}
{
  const r = readDateKinds({ customerText: "本日内覧に行ってきたのですが、初期費用いくらになりますか？", staffBefore: [], viewingStage: "none" });
  t("済んだ内覧の報告の『本日』は日付の話にしない", r.length === 0, JSON.stringify(r));
}
{
  const r = readDateKinds({ customerText: "1/初期費用かからない所\n3/60m2以上でお願いします", staffBefore: [SLOTS], viewingStage: "proposing" });
  t("箇条の番号『3/60m2』は日付にしない", r.length === 0, JSON.stringify(r));
}
t("『夜分遅くに失礼します』は時間帯にしない", timeOfDayOf("夜分遅くに失礼致します") === null);
t("『夜なら』は夕方以降", timeOfDayOf("夜なら行けます") === "evening");
t("流れの段があれば段で決める（決まり文句の『ご都合よろしいお日にちにご案内』だけでは開かない）", viewingSchedulingOpen("none", ["お気に召されましたらご都合よろしいお日にちにご案内させて頂きます！！"]) === false);
t("段が無い時は候補日の時刻で開く", viewingSchedulingOpen(null, [SLOTS]) === true);

console.log("── 確認の相手 ──");
{
  const p = readConfirmParties({ customerText: "朝方は空いてないでしょうか？", staffBefore: ["土曜 14:00〜16:00 ご案内可能です！！"], viewingStage: "proposing" });
  t("調整中の『朝方は空いてない』は内覧の日時＝スタッフ（募集状況にしない）", p.length === 1 && p[0].topic === "viewing_datetime" && p[0].party === "staff", JSON.stringify(p));
}
{
  const p = readConfirmParties({ customerText: "このお部屋まだ空いてますか？ペットは大丈夫ですか？", staffBefore: [], viewingStage: "none" });
  t("募集状況・ペットは管理会社", p.some((x) => x.topic === "vacancy" && x.party === "management") && p.some((x) => x.topic === "pet" && x.party === "management"));
}
{
  const p = readConfirmParties({ customerText: "明日ってまだ空いてますか？\nこちらの物件も空いてますか？", staffBefore: [SLOTS], viewingStage: "proposing" });
  t("日付の無い『空いてますか』が残れば募集状況も残す", p.some((x) => x.topic === "vacancy") && p.some((x) => x.topic === "viewing_datetime"), JSON.stringify(p));
}
{
  const p = readConfirmParties({ customerText: "昨日今日と他の不動産屋さんで\n内覧したお家があり、初期費用を教えてほしいです", staffBefore: [], viewingStage: "wished" });
  t("済んだ内覧の話は内覧の日時の話題にしない", !p.some((x) => x.topic === "viewing_datetime"), JSON.stringify(p));
}
t("下書き『朝方のご案内が可能か確認させて頂きます』は自社の日時を確認の約束にした型", draftConfirmsOwnViewingTime("かしこまりました！！\n\n土曜の朝方のご案内が可能か確認させて頂きます！！\n確認出来次第ご連絡させて頂きます！！"));
t("下書き『もう少し先のお日にちの候補を確認出来次第』も同じ型", draftConfirmsOwnViewingTime("大丈夫です！！\nもう少し先のお日にちの候補を確認出来次第お送りさせて頂きます！！"));
t("管理会社への内覧開始日の確認は外の確認（型にしない）", !draftConfirmsOwnViewingTime("退去予定のため、ご内覧可能日を管理会社に確認させて頂きます！！"));
t("募集状況の確認は型にしない", !draftConfirmsOwnViewingTime("お送り頂きましたお部屋の募集状況確認させて頂きます！！"));
t("下書きが日付を入居として書いた", draftKindNearDate("月末か来月頭のご入居希望でかしこまりました！！", "月末") === "move_in");
t("期日の繰り返し（本日のご連絡お待ちしております）", draftEchoesCustomerDeadline("全部見て今日中にまた連絡します！", "はい！！\nごゆっくりご確認頂けますと幸いです！！\n本日のご連絡お待ちしております！！"));
t("期日を繰り返さない良い形は当たらない", !draftEchoesCustomerDeadline("全部見て今日中にまた連絡します！", "はい！！\nごゆっくりご確認頂けますと幸いです！！\n気になる点出てきましたら何時でもお気軽にご連絡ください！！"));

{
  // YUMA3 q140 の型: 設備の費用の問いは管理会社の確認にしない・注記も出さない
  const p = readConfirmParties({ customerText: "531,730にこれに駐車場もつけたら11000円プラスって感じですか？？", staffBefore: ["御見積書お送りさせて頂きます！！"], viewingStage: "none" });
  t("駐車場の費用の問いは設備（管理会社）の話題にしない", !p.some((x) => x.topic === "facility"), JSON.stringify(p));
  t("駐車場の有無の問いは設備のまま", readConfirmParties({ customerText: "駐車場ありますか？", staffBefore: [], viewingStage: "none" }).some((x) => x.topic === "facility"));
  const note = (ms: Array<{ sender: string; text: string }>, st: "none" | "proposing" = "none") => buildDaySubjectNote(readDaySubject(ms, st));
  const cost = note([{ sender: "staff", text: "御見積書お送りさせて頂きます！！" }, { sender: "customer", text: "531,730にこれに駐車場もつけたら11000円プラスって感じですか？？" }]);
  t("費用の問いの番は注記を出さない", cost === "", cost);
  const pet = note([{ sender: "staff", text: "お送りさせて頂きます！！" }, { sender: "customer", text: "このお部屋まだ空いてますか？ペットは大丈夫ですか？" }]);
  t("管理会社に聞く普通の確認は注記を出さない", pet === "", pet);
  const mv = note([{ sender: "staff", text: "お送りさせて頂きます！！" }, { sender: "customer", text: "10月中に入居したいです" }]);
  t("文に入居とある日付は注記を出さない（取り違えが起きない）", mv === "", mv);
  // YUMA3 q049 の型: 文に内覧の語がある決まった事の番に『AIX で送る』を足さない
  const decided = note([{ sender: "staff", text: "18日 13:00 南船場にて内覧確定です！！" }, { sender: "customer", text: "18日の南船場の内覧のあとに行けますか？" }]);
  t("文に内覧の語がある日付・話題の網だけの内覧の日時は注記を出さない", decided === "", decided);
}

console.log("── 切り替え ──");
{
  const msgs = [{ sender: "staff", text: SLOTS }, { sender: "customer", text: "朝方は空いてないでしょうか？" }];
  t("既定 off: 注記は空", daySubjectNoteIfEnabled(msgs, "proposing", {}) === "");
  const on = daySubjectNoteIfEnabled(msgs, "proposing", { DAY_SUBJECT_READER: "on" });
  t("on: 注記が出る（内覧の日時・1行・見出しの塊にしない）", /内覧の日時/.test(on) && /確認の約束にせず/.test(on) && on.trim().split("\n").length === 1 && !/【/.test(on), on);
  t("読み: お客様が最後でない時は空", readDaySubject([{ sender: "customer", text: "明日" }, { sender: "staff", text: "はい" }]).dates.length === 0);
}

console.log("── かしこまりましたの重なり・置き場所 ──");
{
  const r = dedupeKashikomarimashita("かしこまりました😊！！かしこまりました😌！！\n\n並行してお部屋も探してお送りさせて頂きます！！");
  t("同じ行に2つ → 1つ", r.removed === 1 && r.text.startsWith("かしこまりました😊！！\n\n並行"), JSON.stringify(r.text));
}
{
  const r = dedupeKashikomarimashita("かしこまりました！！大阪府全域での解釈で承知いたしました！！\n\nピックアップしてお送りさせて頂きます！！");
  t("行頭＋同じ行の『〜で承知いたしました』→ 行頭を落とす", r.removed === 1 && r.text.startsWith("大阪府全域での解釈で承知いたしました！！"), JSON.stringify(r.text));
}
{
  const src = "かしこまりました！！\nエアコンの設置は管理会社に交渉させて頂きます！！\n\nかしこまりました！！\n別のエリアからもピックアップしてお送りさせて頂きます！！";
  t("段が違う受け（依頼が2つ）は触らない", dedupeKashikomarimashita(src).removed === 0 && dedupeKashikomarimashita(src).text === src);
}
{
  const r = dedupeKashikomarimashita("かしこまりました！！\nご条件承りました！！\nかしこまりました！！ご条件でお探しさせて頂きます！！");
  t("同じ段の行頭の2回目は頭だけ落とす", r.removed === 1 && /\nご条件でお探しさせて頂きます！！$/.test(r.text), JSON.stringify(r.text));
}
t("文の中の『〜の件かしこまりました』1つだけは触らない", dedupeKashikomarimashita("ご入居日の件かしこまりました！！\nお送りさせて頂きます！！").removed === 0);
{
  const src = "Aさんお世話になっております！！\nかしこまりました！！\n\n明るめのお部屋もピックアップしてお送りさせて頂きます！！";
  const p = placeAckInContentBlock(src);
  t("挨拶の段の受けを中身の段の頭へ", p.moved && p.text === "Aさんお世話になっております！！\n\nかしこまりました！！\n明るめのお部屋もピックアップしてお送りさせて頂きます！！", JSON.stringify(p.text));
  const same = placeAckInContentBlock("Aさんお世話になっております！！かしこまりました！！\n\nお送りさせて頂きます！！");
  t("挨拶と受けが同じ行も分ける", same.moved && same.text === "Aさんお世話になっております！！\n\nかしこまりました！！\nお送りさせて頂きます！！", JSON.stringify(same.text));
  t("もう正しい形は動かさない", !placeAckInContentBlock("Aさんお世話になっております！！\n\nかしこまりました！！\nお送りさせて頂きます！！").moved);
  t("既定: 重なりの網も置き場所の網も on（10/21 竹内さん B6）", ackDedupeEnabled({}) && ackBlockPlaceEnabled({}));
  t("既定（on）で置き場所を直す", tidyAckForm(src, {}) !== src);
  t("ACK_BLOCK_PLACE=off で置き場所は変えない", tidyAckForm(src, { ACK_BLOCK_PLACE: "off" }) === src);
  t("ACK_DEDUPE=off で重なりを残す", tidyAckForm("かしこまりました！！かしこまりました！！", { ACK_DEDUPE: "off" }) === "かしこまりました！！かしこまりました！！");
}
// 査読: 「承知しましたが／承知しましたら」の文の途中を削らない（同じ段の2つ目でも区切れていない受けは触らない）
t("2つ目の行頭の『承知しましたが、』は残す", dedupeKashikomarimashita("かしこまりました！！\n承知しましたが、念のため確認します").removed === 0);
t("2つ目の行頭の『承知しましたら』は残す", dedupeKashikomarimashita("かしこまりました\n承知しましたら教えてください").removed === 0);
t("読みの失敗（材料が null）でも空文字で返る", daySubjectNoteIfEnabled(null as unknown as [], null, { DAY_SUBJECT_READER: "on" }) === "");
t("画面・送信の文（draftToSendableText）でも同じ行の重なりを1つに", (draftToSendableText("かしこまりました😊！！かしこまりました😌！！\n\nお送りさせて頂きます！！") ?? "").split("かしこまりました").length === 2);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
