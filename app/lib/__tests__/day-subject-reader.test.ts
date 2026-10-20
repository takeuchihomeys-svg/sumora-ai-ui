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
  t("注記: 入居の時期の答えとして受けない", /入居の時期の答えとして受けない/.test(note));
}
{
  const r = readDateKinds({ customerText: "10月中に入居したいです", staffBefore: [SLOTS], viewingStage: "proposing" });
  t("文に『入居』があれば調整中でも入居", r[0]?.kind === "move_in" && r[0].source === "explicit");
}
{
  const r = readDateKinds({ customerText: "10月中でいけたら！", staffBefore: ["何日でのご入居ご希望でしょうか！！"], viewingStage: "none" });
  t("調整中でなく直前に入居を聞いた → 入居", r[0]?.kind === "move_in" && r[0].source === "staff_question");
}
{
  const r = readDateKinds({ customerText: "朝方は空いてないでしょうか？", staffBefore: ["土曜 14:00〜16:00 ご案内可能です！！"], viewingStage: "proposing" });
  t("時間帯だけ（朝方）→ 内覧の日時・朝", r[0]?.kind === "viewing" && r[0].timeOfDay === "morning" && r[0].dateText === null, JSON.stringify(r));
}
{
  const r = readDateKinds({ customerText: "全部見て今日中にまた連絡します！", staffBefore: ["お気に召されましたらご案内させて頂きます！！"], viewingStage: "none" });
  t("『今日中にまた連絡します』は お客様からの連絡の期日", r[0]?.kind === "contact");
  const note = buildDaySubjectNote({ dates: r, parties: [] });
  t("注記: 期日を繰り返さない", /繰り返さない/.test(note));
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

console.log("── 切り替え ──");
{
  const msgs = [{ sender: "staff", text: SLOTS }, { sender: "customer", text: "朝方は空いてないでしょうか？" }];
  t("既定 off: 注記は空", daySubjectNoteIfEnabled(msgs, "proposing", {}) === "");
  const on = daySubjectNoteIfEnabled(msgs, "proposing", { DAY_SUBJECT_READER: "on" });
  t("on: 注記が出る（内覧の日時・スタッフ）", /何の日か・確認の相手/.test(on) && /内覧の日時/.test(on) && /確認の約束にしない/.test(on), on);
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
  t("既定: 重なりの網は on・置き場所の網は off", ackDedupeEnabled({}) && !ackBlockPlaceEnabled({}));
  t("既定（off）の置き場所は変えない", tidyAckForm(src, {}) === src);
  t("ACK_BLOCK_PLACE=on で動く", tidyAckForm(src, { ACK_BLOCK_PLACE: "on" }) !== src);
  t("ACK_DEDUPE=off で重なりを残す", tidyAckForm("かしこまりました！！かしこまりました！！", { ACK_DEDUPE: "off" }) === "かしこまりました！！かしこまりました！！");
}
t("画面・送信の文（draftToSendableText）でも同じ行の重なりを1つに", (draftToSendableText("かしこまりました😊！！かしこまりました😌！！\n\nお送りさせて頂きます！！") ?? "").split("かしこまりました").length === 2);

console.log(`\n${pass} OK / ${fail} NG`);
if (fail) process.exit(1);
