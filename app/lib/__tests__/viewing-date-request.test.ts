// 2026-09-15 竹内（隼斗事例）: 内覧日指定ありの希望日の読み取り・返信の形・退去予定の補正の解除
// 実行: npx tsx app/lib/__tests__/viewing-date-request.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { extractRequestedViewingDates, requestedViewingDatesFromMessages, latestCustomerTurnText, buildViewingSpecificMessage, viewingDateLabel } from "../viewing-date-request";
import { staffOffersViewing, moveOutBlocksViewing, moveOutViewingReleased } from "../move-out-context";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return { toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); } };
}

// 2026-09-15(火) 14:44 JST
const NOW = Date.parse("2026-09-15T14:44:00+09:00");
const labels = (t: string) => extractRequestedViewingDates(t, NOW).map((d) => d.label).join(",");

// ─── 希望日の読み取り ───
it("隼斗「本日は厳しいので18日はどうでしょうか？」→ 9/18(金)（断りの「本日」は読まない・曜日は日本の暦）", () => expect(labels("本日は厳しいので18日はどうでしょうか？")).toBe("9/18(金)"));
it("月なしの D日 が今日より前なら来月「5日はどうですか」→ 10/5(月)", () => expect(labels("5日はどうですか")).toBe("10/5(月)"));
it("M月D日・M/D", () => { expect(labels("9月20日は可能ですか")).toBe("9/20(日)"); expect(labels("9/19なら行けます")).toBe("9/19(土)"); });
it("明日・明後日", () => expect(labels("明日か明後日でお願いしたいです")).toBe("9/16(水),9/17(木)"));
it("「今日はありがとうございました」の今日は希望日にしない", () => expect(labels("今日はありがとうございました")).toBe(""));
it("来週〇曜・〇曜", () => { expect(labels("来週の月曜日どうですか")).toBe("9/21(月)"); expect(labels("土曜日いけますか")).toBe("9/19(土)"); });
it("入居・退去の日付は読まない", () => expect(labels("入居は10月1日希望です")).toBe(""));
it("時刻（17:30〜18:30）を日付にしない", () => expect(labels("17:30〜18:30でお願いします")).toBe(""));
it("「明日は無理です、19日ならどうですか」→ 19日だけ", () => expect(labels("明日は無理です、19日ならどうですか")).toBe("9/19(土)"));
it("実データ「16,17,18,19日昼過ぎてから空いてます！」→ 4日とも", () => expect(labels("16,17,18,19日昼過ぎてから空いてます！")).toBe("9/16(水),9/17(木),9/18(金),9/19(土)"));
it("実データ「土曜日は仕事なので日曜日でお願いします。」→ 日曜だけ", () => expect(labels("土曜日は仕事なので日曜日でお願いします。")).toBe("9/20(日)"));
it("「20日と21日は何時空いてますか？」→ 両方", () => expect(labels("20日と21日は何時空いてますか？")).toBe("9/20(日),9/21(月)"));

// ─── お客様の最新の発言だけを見る ───
const hayatoMsgs = [
  { sender: "customer", text: "9/15にち17~でお願いします" },
  { sender: "staff", text: "かしこまりました。\n本日17:00からのご予約キャンセルさせていただきます！！" },
  { sender: "customer", text: "こちら内覧希望です" },
  { sender: "staff", text: "かしこまりました！！\n本日ご内覧如何でしょうか😊！！\n17:30〜18:30お部屋ご案内出来ます！！" },
  { sender: "customer", text: "本日は厳しいので18日はどうでしょうか？" },
];
it("最新の発言だけ（古い「9/15」は読まない）", () => expect(requestedViewingDatesFromMessages(hayatoMsgs, NOW).map((d) => d.ymd).join(",")).toBe("2026-09-18"));
it("最後がスタッフなら、その前のお客様の連投", () => expect(latestCustomerTurnText([...hayatoMsgs, { sender: "staff", text: "確認します" }])).toBe("本日は厳しいので18日はどうでしょうか？"));
it("曜日のラベル（日本の暦）", () => expect(viewingDateLabel("2026-09-18")).toBe("9/18(金)"));

// ─── 返信の形（スタッフの実送信 9/15 と同じ） ───
it("隼斗の実送信と同じ形", () => {
  const msg = buildViewingSpecificMessage({ dates: [{ md: "9/18", label: "9/18(金)", times: "10:30〜11:30 17:00〜18:30" }], customerName: "隼斗" });
  expect(msg).toBe("かしこまりました！！\n9/18お部屋ご案内させて頂きます！！\n\n9/18(金) 10:30〜11:30 17:00〜18:30\nご案内可能です😊！！\n隼斗さんご都合よろしいお時間御座いますでしょうか！！");
});
it("複数日は「お日にち・お時間」を伺う", () => {
  const msg = buildViewingSpecificMessage({ dates: [{ md: "9/18", label: "9/18(金)", times: "11:00〜13:00" }, { md: "9/19", label: "9/19(土)", times: "13:00〜16:00" }], customerName: "隼斗" });
  expect(msg.includes("9/18・9/19お部屋ご案内させて頂きます！！")).toBe(true);
  expect(msg.endsWith("ご都合よろしいお日にち・お時間御座いますでしょうか！！")).toBe(true);
});
it("時間が無い時は時間の行を出さない", () => expect(buildViewingSpecificMessage({ dates: [{ md: "9/18", label: "9/18(金)", times: "" }], customerName: "隼斗" })).toBe("かしこまりました！！\n9/18お部屋ご案内させて頂きます！！\n隼斗さんご都合よろしいお時間御座いますでしょうか！！"));

// ─── 退去予定の補正（申込へ）はスタッフが内覧を案内した後は効かない ───
const moveOutThenOffer = [ // 新しい順
  { sender: "customer", text: "本日は厳しいので18日はどうでしょうか？" },
  { sender: "staff", text: "かしこまりました！！\n本日ご内覧如何でしょうか😊！！\n17:30〜18:30お部屋ご案内出来ます！！" },
  { sender: "customer", text: "こちら内覧希望です" },
  { sender: "staff", text: "メゾンラトゥール 103号室現在募集中となります！！\n10月30日退去予定、11月末ごろご入居可能なお部屋となります！！" },
];
it("隼斗: 退去予定の後にスタッフが内覧を案内 → 補正しない", () => {
  expect(moveOutViewingReleased(moveOutThenOffer, "newest_first")).toBe(true);
  expect(moveOutBlocksViewing(moveOutThenOffer, "newest_first")).toBe(false);
});
it("退去予定の物件を送っただけ（先押さえの勧めなし）の「内覧希望です」は補正しない（実データ: スタッフは内覧を案内）", () => expect(moveOutBlocksViewing(moveOutThenOffer.slice(2), "newest_first")).toBe(false));
it("アヤ: スタッフが「先にお申込みしお部屋を抑え」を勧めた後の「内見可能でしょうか？」は補正（申込で先押さえ）", () => {
  const aya = [
    { sender: "customer", text: "わぁぁぁぁぁ！！、 めっちゃいいですねここ！！！！ 内見可能でしょうか？！？！" },
    { sender: "staff", text: "グランドコート難波702号室8月末退去予定物件で条件が良いお部屋となりますので、お申込みが入る可能性御座います！！\nアヤさんお気に召されましたら、先にお申込みしお部屋を抑えさせて頂きます！！" },
  ];
  expect(moveOutBlocksViewing(aya, "newest_first")).toBe(true);
});
it("はるか: 見積書の文の「退去予定のお部屋となりますので、お気に召されましたらお申込みしお部屋を抑え」も先押さえの勧め", () => {
  expect(moveOutBlocksViewing([{ sender: "customer", text: "一度内見してみたいです！" }, { sender: "staff", text: "クレール元町 203号室の初期費用御見積書同封させて頂きました！！\n退去予定のお部屋となりますので、お気に召されましたらお申込みしお部屋を抑えさせて頂きます！！" }], "newest_first")).toBe(true);
});
it("先押さえを勧めた後にスタッフが内覧を案内したら補正しない（最後の言及で決める）", () => {
  expect(moveOutBlocksViewing([
    { sender: "customer", text: "18日はどうですか" },
    { sender: "staff", text: "退去後の11/1以降でしたらお部屋ご案内可能です！！" },
    { sender: "staff", text: "10月30日退去予定のお部屋です。先にお申込みしお部屋を抑える事も可能です！！" },
  ], "newest_first")).toBe(false);
});
it("「退去前のため現在は現地ご案内ができませんが…」は内覧の案内に数えない", () => {
  expect(staffOffersViewing("こちらのお部屋は退去前のため現在は現地ご案内ができませんが、退去後すぐにご案内させて頂きます！！")).toBe(false);
});
it("物件送付の定型「お気に召されましたらご案内させて頂きます」は案内に数えない", () => expect(staffOffersViewing("お気に召されましたらお部屋のご案内させていただきます😊！！")).toBe(false));
it("「7/12日以降でお部屋ご案内可能です」は案内（日程調整に進む）", () => expect(staffOffersViewing("7/11日退去予定のお部屋で7/12日以降でお部屋ご案内可能です！！")).toBe(true));
it("退去予定の話が無ければ補正しない", () => expect(moveOutBlocksViewing([{ sender: "customer", text: "内覧したいです" }], "newest_first")).toBe(false));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
