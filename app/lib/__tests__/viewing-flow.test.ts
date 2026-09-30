// 2026-09-30 竹内さん「内覧調整→日にち決定→待ち合わせ場所＝確定 の流れをちゃんとできるように・先走らないように」
//   app/lib/viewing-flow.ts（内覧の流れの段階を1か所で決める純関数）
// 本文は実物（みことさん 8a77820b・6fdadc8b・fbffca3d・cdf07418 ほか）。お客様の名前は YUMA に置き換えた
// 実行: npx tsx app/lib/__tests__/viewing-flow.test.ts（自己完結ハーネス。全 PASS で exit 0）
import { resolveViewingFlow, classifyCustomerDateReply, viewingFlowNextAix, buildViewingFlowBrainText, buildViewingFlowLedgerLine, viewingFlowStageDetail, type FlowMsg } from "../viewing-flow";
import { buildActionLedger, checkDonePresupposition, type LedgerMessage, type LedgerAixRow } from "../action-ledger";

let passed = 0, failed = 0; const failures: string[] = [];
function it(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); console.log(`  ✗ ${name}\n      ${e instanceof Error ? e.message : String(e)}`); }
}
function expect<T>(actual: T) {
  return {
    toBe(exp: T) { if (actual !== exp) throw new Error(`expected ${JSON.stringify(exp)} but got ${JSON.stringify(actual)}`); },
    toContain(sub: string) { if (!String(actual).includes(sub)) throw new Error(`expected to contain ${JSON.stringify(sub)} but got ${JSON.stringify(actual)}`); },
    notToContain(sub: string) { if (String(actual).includes(sub)) throw new Error(`expected NOT to contain ${JSON.stringify(sub)} but got ${JSON.stringify(actual)}`); },
  };
}
/** JST の「M/D HH:MM」→ ISO（2026年） */
const at = (md: string, hm: string) => { const [m, d] = md.split("/").map(Number); const [h, mi] = hm.split(":").map(Number); return new Date(Date.UTC(2026, m - 1, d, h - 9, mi)).toISOString(); };
const c = (md: string, hm: string, text: string): FlowMsg => ({ sender: "customer", text, createdAt: at(md, hm) });
const s = (md: string, hm: string, text: string): FlowMsg => ({ sender: "staff", text, createdAt: at(md, hm) });

// ── みことさん（8a77820b）: 候補日のやり取り中に別の質問が続いた ──
const INVITE1 = "かしこまりました！！\nレジュールアッシュ北大阪 GRAND STAGE 206号室、ご内覧可能です😊！！\n直近ですと\n本日 9/28(月) 15:00〜17:00\n明日 9/29(火) 12:00〜16:00にてご案内可能です😊！！\nYUMAさんご都合よろしいお日にち御座いますでしょうか！！";
const INVITE2 = "YUMAさん\nお世話になっております！！\n10/2日ですと13:00〜16:00ご内覧可能です！！\nYUMAさんご都合如何でしょうか😌！！";
const MIKOTO: FlowMsg[] = [
  c("9/27", "02:37", "レジュールアッシュ内見可能ですか？"),
  s("9/28", "12:20", INVITE1),
  c("9/29", "22:29", "2日はどうですか？"),
  s("9/30", "12:07", INVITE2),
  c("9/30", "15:13", "3日はおやすみですよね💦"),
  s("9/30", "15:22", "10/3日は終日予定が入っておりご案内が出来ないお日にちとなります！！\n10/2日のご予定はいかがでしょうか😌！！"),
  c("9/30", "15:23", "保証会社はどこですか？"),
  s("9/30", "15:25", "保証会社はナップ賃貸保証となります！！\n独立系の保証会社となりますので比較的審査通過しやすいお部屋となります😌！！"),
  c("9/30", "15:26", "夜職なのですがアリバイ会社使えますか？"),
];
const MIKOTO_INVITES = [at("9/28", "12:20"), at("9/30", "12:07")];
const upTo = (n: number) => MIKOTO.slice(0, n);
const mk = (n: number, now: string) => resolveViewingFlow({ messages: upTo(n), inviteAts: MIKOTO_INVITES.filter((x) => upTo(n).some((m) => m.createdAt === x)), nowMs: Date.parse(now) + 1000 });

console.log("\n① みことさん: 段階が先走らない");
it("内見可能ですか？ → wished・次は内覧調整", () => {
  const f = mk(1, at("9/27", "02:37"));
  expect(f.stage).toBe("wished"); expect(viewingFlowNextAix(f)).toBe("viewing_invite"); expect(f.confirmed).toBe(false);
});
it("AIX【内覧調整】を送った → proposing・候補2つ・次の AIX は無し（返事待ち）", () => {
  const f = mk(2, at("9/28", "12:20"));
  expect(f.stage).toBe("proposing"); expect(f.slots.length).toBe(2); expect(viewingFlowNextAix(f)).toBe(null);
});
it("「2日はどうですか？」（日だけ）→ proposing のまま・内覧調整をもう1回", () => {
  const f = mk(3, at("9/29", "22:29"));
  expect(f.stage).toBe("proposing"); expect(f.currentReply).toBe("day_only"); expect(f.askedDay).toBe("10/2"); expect(viewingFlowNextAix(f)).toBe("viewing_invite");
});
it("「3日はおやすみですよね💦」（否定の確かめ）→ proposing・ask_back・内覧調整（決まっていない）", () => {
  const f = mk(5, at("9/30", "15:13"));
  expect(f.stage).toBe("proposing"); expect(f.currentReply).toBe("ask_back"); expect(f.askedDay).toBe("10/3"); expect(viewingFlowNextAix(f)).toBe("viewing_invite");
  expect(buildViewingFlowBrainText(f)).toContain("事実として reply_direction に書かない");
});
it("「保証会社はどこですか？」（別の質問）→ 段階は進まない・次の AIX の候補なし", () => {
  const f = mk(7, at("9/30", "15:23"));
  expect(f.stage).toBe("proposing"); expect(f.currentReply).toBe("none"); expect(viewingFlowNextAix(f)).toBe(null); expect(f.confirmed).toBe(false);
});
it("「アリバイ会社使えますか？」→ ブレインの材料・台帳の注記とも「まだ決まっていない」", () => {
  const f = mk(9, at("9/30", "15:26"));
  expect(f.stage).toBe("proposing"); expect(f.currentReply).toBe("none");
  const b = buildViewingFlowBrainText(f);
  expect(b).toContain("まだ決まっていない"); expect(b).toContain("その質問・用件にだけ答える"); expect(b).notToContain("次の一手は meeting_place");
  const l = buildViewingFlowLedgerLine(f);
  expect(l).toContain("まだ決まっていない"); expect(l).toContain("内覧を決まった予定として書かない");
  expect(viewingFlowStageDetail(f) ?? "").toContain("候補日を提示");
});

// ── 成約した流れ（6fdadc8b 型）: 内覧調整 → 日＋時刻 → 待ち合わせ場所 ──
const INVITE_914 = "直近ですと\n9/14(月) 12:00〜14:00\n9/15(火) 11:00〜13:00にてご案内可能です😊！！\nご都合よろしいお日にち御座いますでしょうか！！";
const MEETING_914 = "かしこまりました！！\n9/14（月）16:00〜ご案内させて頂きます！！\n9/14 16:00にS-RESIDENCE難波大国町Deux\n現地エントランスお待ち合わせで何卒よろしくお願い致します！！\n住所: 大阪府大阪市浪速区";
const WON: FlowMsg[] = [
  c("9/11", "10:00", "3件とも内覧行きたいのですが…いつ頃行けますか？"),
  s("9/11", "10:30", INVITE_914),
  c("9/11", "11:00", "では14日の16:00でお願いしたいです！"),
  s("9/11", "11:20", MEETING_914),
  c("9/11", "11:30", "ありがとうございます！よろしくお願いします！"),
];
console.log("\n② 成約した会話の流れ: 内覧調整 → 日にち決定 → 待ち合わせ場所＝確定");
it("日＋開始時刻がそろった → date_agreed（まだ確定ではない）・次は待ち合わせ場所", () => {
  const f = resolveViewingFlow({ messages: WON.slice(0, 3), inviteAts: [at("9/11", "10:30")], nowMs: Date.parse(at("9/11", "11:01")) });
  expect(f.stage).toBe("date_agreed"); expect(f.label).toBe("9/14 16:00"); expect(f.timeFixed).toBe(true); expect(f.confirmed).toBe(false);
  expect(viewingFlowNextAix(f)).toBe("meeting_place");
  expect(buildViewingFlowBrainText(f)).toContain("次の一手は meeting_place");
  expect(buildViewingFlowLedgerLine(f)).toContain("まだ確定ではない");
  expect(viewingFlowStageDetail(f) ?? "").toContain("待ち合わせ場所は未送信");
});
it("AIX【待ち合わせ場所】を送った → confirmed・もう一度は勧めない", () => {
  const f = resolveViewingFlow({ messages: WON, inviteAts: [at("9/11", "10:30")], meetings: [{ at: at("9/11", "11:20"), dateMD: "9/14", time: "16:00" }], appointment: { dateMD: "9/14", time: "16:00" }, nowMs: Date.parse(at("9/11", "11:31")) });
  expect(f.stage).toBe("confirmed"); expect(f.confirmed).toBe(true); expect(f.label).toBe("9/14 16:00"); expect(viewingFlowNextAix(f)).toBe(null);
  expect(buildViewingFlowBrainText(f)).toContain("meeting_place をもう一度提案しない");
  expect(buildViewingFlowLedgerLine(f)).toBe("");
});
it("日にち決定の後に別の質問 → date_agreed のまま・段階を進めない", () => {
  const msgs = [...WON.slice(0, 3), c("9/11", "11:05", "ここは初期費用いくらですか？")];
  const f = resolveViewingFlow({ messages: msgs, inviteAts: [at("9/11", "10:30")], nowMs: Date.parse(at("9/11", "11:06")) });
  expect(f.stage).toBe("date_agreed"); expect(f.confirmed).toBe(false);
  expect(buildViewingFlowBrainText(f)).toContain("待ち合わせ場所");
});
it("内覧後のお礼 → done", () => {
  const msgs = [...WON, s("9/14", "17:30", "本日お時間頂きありがとうございました！！\nお気に召されましたらお申込しお部屋抑えさせて頂きます！")];
  const f = resolveViewingFlow({ messages: msgs, inviteAts: [at("9/11", "10:30")], meetings: [{ at: at("9/11", "11:20"), dateMD: "9/14", time: "16:00" }], done: { thankedAt: at("9/14", "17:30") }, nowMs: Date.parse(at("9/14", "18:00")) });
  expect(f.stage).toBe("done"); expect(buildViewingFlowBrainText(f)).toBe("");
});

// ── fbffca3d: 日にちだけ決まり、待ち合わせ場所は後 ──
console.log("\n③ 日にち決定・待ち合わせ前（場所は追って）");
it("候補が1日の時の「大丈夫です！13:00〜お願いします！」→ date_agreed／「待ち合わせ場所追ってご連絡」→ やる事が残る", () => {
  const msgs: FlowMsg[] = [
    c("9/18", "10:00", "24日とかはどうですか？"),
    s("9/18", "10:20", "9/24日ですと13:00〜16:00ご内覧可能です！！\nYUMAさんご都合如何でしょうか😌！！"),
    c("9/18", "10:40", "大丈夫です！13:00〜お願いします！"),
  ];
  const f1 = resolveViewingFlow({ messages: msgs, inviteAts: [at("9/18", "10:20")], nowMs: Date.parse(at("9/18", "10:41")) });
  expect(f1.stage).toBe("date_agreed"); expect(f1.label).toBe("9/24 13:00"); expect(viewingFlowNextAix(f1)).toBe("meeting_place");
  const f2 = resolveViewingFlow({ messages: [...msgs, s("9/18", "11:00", "9/24日13:00からはよろしくお願いいたします😊！！\n待ち合わせ場所追ってご連絡させていただきます！！")], inviteAts: [at("9/18", "10:20")], nowMs: Date.parse(at("9/18", "11:01")) });
  expect(f2.stage).toBe("date_agreed"); expect(f2.placePromised).toBe(true); expect(f2.confirmed).toBe(false);
  expect(buildViewingFlowBrainText(f2)).toContain("追ってご連絡");
});

// ── 段階が戻った例 ──
console.log("\n④ 段階が戻る（変更・取りやめ・保留・古い打診）");
const CONFIRMED_BASE = { messages: WON, inviteAts: [at("9/11", "10:30")], meetings: [{ at: at("9/11", "11:20"), dateMD: "9/14", time: "16:00" }], appointment: { dateMD: "9/14", time: "16:00" } };
it("確定の後「15日の方が助かるんですけど変更お願いしても行けますか」→ proposing に戻る（内覧調整をもう1回）", () => {
  const f = resolveViewingFlow({ ...CONFIRMED_BASE, messages: [...WON, c("9/12", "09:00", "15日の方が助かるんですけど変更お願いしても行けますか")], nowMs: Date.parse(at("9/12", "09:01")) });
  expect(f.stage).toBe("proposing"); expect(f.askedDay).toBe("9/15"); expect(f.confirmed).toBe(true);
});
it("確定の後、日＋時刻で変更 → date_agreed（待ち合わせを送り直す）", () => {
  const f = resolveViewingFlow({ ...CONFIRMED_BASE, messages: [...WON, c("9/12", "09:00", "すみません、15日の12時からに変更お願いできますか？")], nowMs: Date.parse(at("9/12", "09:01")) });
  expect(f.stage).toBe("date_agreed"); expect(f.label).toBe("9/15 12:00"); expect(viewingFlowNextAix(f)).toBe("meeting_place");
});
it("確定の後「いったんキャンセルでお願いいたします。」→ none", () => {
  const f = resolveViewingFlow({ ...CONFIRMED_BASE, appointment: null, messages: [...WON, c("9/12", "09:00", "いったんキャンセルでお願いいたします。")], nowMs: Date.parse(at("9/12", "09:01")) });
  expect(f.stage).toBe("none");
});
it("候補日の後「日程調整してまた連絡させて頂きます。」→ proposing・保留・催促しない（次の AIX なし）", () => {
  const f = resolveViewingFlow({ messages: [...WON.slice(0, 2), c("9/11", "11:00", "日程調整してまた連絡させて頂きます。")], inviteAts: [at("9/11", "10:30")], nowMs: Date.parse(at("9/11", "11:01")) });
  expect(f.stage).toBe("proposing"); expect(f.currentReply).toBe("hold"); expect(viewingFlowNextAix(f)).toBe(null);
  expect(buildViewingFlowBrainText(f)).toContain("日程を催促しない");
});
it("候補が複数ある時の「了解です！」→ 決まらない（proposing のまま）", () => {
  const f = resolveViewingFlow({ messages: [...WON.slice(0, 2), c("9/11", "11:00", "了解です！")], inviteAts: [at("9/11", "10:30")], nowMs: Date.parse(at("9/11", "11:01")) });
  expect(f.stage).toBe("proposing"); expect(viewingFlowNextAix(f)).toBe(null);
});
it("日にちが合意した後「やっぱり16時以降は少しきびしいですよね」→ proposing に戻る", () => {
  const f = resolveViewingFlow({ messages: [...WON.slice(0, 3), c("9/11", "11:10", "やっぱり14日の16時以降は少しきびしいですよね")], inviteAts: [at("9/11", "10:30")], nowMs: Date.parse(at("9/11", "11:11")) });
  expect(f.stage).toBe("proposing"); expect(f.label).toBe(null);
});
it("打診から8日動いていない → none（古い打診で「候補日のやり取り中」を出し続けない）", () => {
  const f = resolveViewingFlow({ messages: WON.slice(0, 2), inviteAts: [at("9/11", "10:30")], nowMs: Date.parse(at("9/19", "12:00")) });
  expect(f.stage).toBe("none"); expect(buildViewingFlowLedgerLine(f)).toBe("");
});
it("候補日を待たずにお客様が日時を指定（「23日に内覧…時間12時からお願いできますか？」）→ date_agreed", () => {
  const f = resolveViewingFlow({ messages: [c("9/20", "10:00", "23日に内覧行けるこの2部屋お願いします！！\n時間12時からお願いできますか？")], nowMs: Date.parse(at("9/20", "10:01")) });
  expect(f.stage).toBe("date_agreed"); expect(f.label).toBe("9/23 12:00"); expect(viewingFlowNextAix(f)).toBe("meeting_place");
});
it("待ち合わせを「如何でしょうか」で送った → まだ打診（proposing）・お客様の了承で confirmed", () => {
  const ask = "はい！！\n10日(水)12:00に現地エントランスお待ち合わせ如何でしょうか！！\n住所: 大阪府大阪市";
  const base: FlowMsg[] = [c("9/8", "10:00", "内覧したいです！"), s("9/8", "10:30", ask)];
  const mt = [{ at: at("9/8", "10:30"), dateMD: "9/10", time: "12:00" }];
  const f1 = resolveViewingFlow({ messages: base, meetings: mt, nowMs: Date.parse(at("9/8", "10:31")) });
  expect(f1.stage).toBe("proposing"); expect(f1.meetingOffered).toBe(true);
  const f2 = resolveViewingFlow({ messages: [...base, c("9/8", "11:00", "大丈夫です！")], meetings: mt, appointment: { dateMD: "9/10", time: "12:00" }, nowMs: Date.parse(at("9/8", "11:01")) });
  expect(f2.stage).toBe("confirmed");
  // 見直し: 台帳に待ち合わせ案内がある（confirmed=true）時、打診中の注記で「まだ決まっていない」「別に決まった内覧がある」を重ねない
  const f3 = resolveViewingFlow({ messages: base, meetings: mt, appointment: { dateMD: "9/10", time: "12:00" }, nowMs: Date.parse(at("9/8", "10:31")) });
  expect(f3.stage).toBe("proposing"); expect(f3.confirmed).toBe(true);
  expect(buildViewingFlowLedgerLine(f3)).toBe("");
  expect(buildViewingFlowBrainText(f3)).notToContain("これとは別に");
  expect(buildViewingFlowBrainText(f3)).toContain("meeting_place をもう一度提案しない");
});

console.log("\n⑤ お客様の日にちの返事の読み（classifyCustomerDateReply）");
const ctx = { atMs: Date.parse(at("9/11", "11:00")), offeredDays: ["9/14", "9/15"], offeredStart: { "9/14": "12:00", "9/15": "11:00" }, inFlow: true };
const kind = (t: string, x = ctx) => classifyCustomerDateReply(t, x).kind;
it("「9/9の15時からお願いします!」→ date_time", () => expect(kind("9/9の15時からお願いします!")).toBe("date_time"));
it("「明日の13時でも行けますか?」→ date_time", () => expect(kind("明日の13時でも行けますか?")).toBe("date_time"));
it("「16日は行けますか?」（候補に無い日）→ day_only", () => expect(kind("16日は行けますか?")).toBe("day_only"));
it("「土日は可能ですか?」→ day_only", () => expect(kind("土日は可能ですか?")).toBe("day_only"));
it("「14日でお願いします」（候補の日）→ day_pick", () => expect(kind("14日でお願いします")).toBe("day_pick"));
it("「16時以降は少しきびしいですよね」→ ask_back", () => expect(kind("16時以降は少しきびしいですよね")).toBe("ask_back"));
it("「週末行けるか確認してみます!」→ hold", () => expect(kind("週末行けるか確認してみます!")).toBe("hold"));
it("「ここは初期費用いくらですか?」→ none", () => expect(kind("ここは初期費用いくらですか?")).toBe("none"));
it("「入居は11月1日でお願いします」（入居の日）→ none", () => expect(kind("入居は11月1日でお願いします")).toBe("none"));
it("「10/2の午前中も空きございますか？もしくは10/4の13時半でお願いします」（2つ並べた）→ 決まっていない", () => expect(kind("10/2の午前中も空きございますか？もしくは10/4の13時半でお願いします")).toBe("day_only"));

// ── 行動台帳・出口の関所と同じ線 ──
console.log("\n⑥ 行動台帳・出口（viewing_presumed）が同じ段階を見る");
const lm = (xs: FlowMsg[]): LedgerMessage[] => xs.map((m) => ({ sender: m.sender, text: m.text ?? "", createdAt: m.createdAt ?? "" }));
const inviteRow = (iso: string, text: string) => ({ aix_type: "viewing_invite", created_at: iso, sent_at: iso, generated_text: text }) as unknown as LedgerAixRow;
it("日にち決定・待ち合わせ前: 台帳の段階は date_agreed・「ご内覧時に〜」は止める", () => {
  const l = buildActionLedger({ messages: lm(WON.slice(0, 3)), recentAixRows: [inviteRow(at("9/11", "10:30"), INVITE_914)], lineTasks: [], lastCustomerAt: at("9/11", "11:00"), now: Date.parse(at("9/11", "11:01")) });
  expect(l.facts.viewingFlow?.stage ?? "").toBe("date_agreed"); expect(l.facts.viewingFlow?.confirmed ?? true).toBe(false);
  const v = checkDonePresupposition("かしこまりました！！\nご内覧時に内覧担当より詳しくご案内させて頂きます😌！！", l, { name: "YUMA", customerMessage: "では14日の16:00でお願いしたいです！" });
  expect(v.some((x) => x.key === "viewing_presumed")).toBe(true);
});
it("みことさん: 台帳の段階は proposing・未確定", () => {
  const l = buildActionLedger({ messages: lm(MIKOTO), recentAixRows: [inviteRow(MIKOTO_INVITES[0], INVITE1), inviteRow(MIKOTO_INVITES[1], INVITE2)], lineTasks: [], lastCustomerAt: at("9/30", "15:26"), now: Date.parse(at("9/30", "15:27")) });
  expect(l.facts.viewingFlow?.stage ?? "").toBe("proposing"); expect(l.facts.viewingFlow?.currentReply ?? "").toBe("none");
});

// ── 2026-09-30 見直し（scripts/audit-viewing-stage.ts DUMP=1 で「日にち決定」に誤って進んでいた実物）──
console.log("\n⑨ 見直し: 決まっていないのに日にち決定にしない（監査の実物）");
{
  const ctx = (md: string, hm: string, offeredDays: string[], offeredStart: Record<string, string> = {}) => ({ atMs: Date.parse(at(md, hm)), offeredDays, offeredStart, knownDay: null, inFlow: true });
  it("「27日以降で18時頃って可能でしょうか？」（9b9b81ba）は範囲の問い＝日＋時刻の指定ではない → day_only（内覧調整をもう1回）", () => {
    const v = classifyCustomerDateReply("27日以降で18時頃って可能でしょうか？", ctx("9/25", "16:08", ["9/26"]));
    expect(v.kind).toBe("day_only"); expect(v.day).toBe(null);
  });
  it("「平日18時半以降か今週土曜日なら16時以降です。」（d3f7f5f3）は開始時刻の指定ではない → date_time にしない", () => {
    const v = classifyCustomerDateReply("平日18時半以降か今週土曜日なら16時以降です。", ctx("8/24", "14:48", []));
    expect(v.kind === "date_time").toBe(false); expect(v.time).toBe(null);
  });
  it("「今週土曜日終日埋まりました。日曜日午前中なら可能。」（d3f7f5f3）は土曜を選んでいない → ask_back", () => {
    const v = classifyCustomerDateReply("今週土曜日終日埋まりました。日曜日午前中なら可能。", ctx("8/24", "13:41", ["8/29"]));
    expect(v.kind).toBe("ask_back");
  });
  it("「今日ではなくていいのですが」（c7ca2f04・候補が本日）は選んでいない → ask_back", () => {
    const v = classifyCustomerDateReply("今日ではなくていいのですが", ctx("9/6", "14:45", ["9/6"], { "9/6": "17:30" }));
    expect(v.kind).toBe("ask_back");
  });
  it("「今日はありがとうございました！／花園の駐車場の確認だけお願いします🥹」（ad97cd40・内覧の後）は日にちの返事ではない → none", () => {
    const v = classifyCustomerDateReply("今日はありがとうございました！\n花園の駐車場の確認だけお願いします🥹", ctx("9/22", "18:35", ["9/22"]));
    expect(v.kind).toBe("none");
  });
  it("「今日の内見の部屋の件なんですが、」（60e6d3ab・当日の内覧の話）は日を選んだ返事ではない → none", () => {
    const v = classifyCustomerDateReply("わかりました！\nありがとございます。\n今日の内見の部屋の件なんですが、", ctx("8/20", "13:05", ["8/20"]));
    expect(v.kind).toBe("none");
  });
  it("候補1日の後、別の質問へのこちらの答えに「よろしくお願いします。」→ 日にち決定にしない（打診の直後の了承だけ決まる）", () => {
    const head: FlowMsg[] = [c("9/29", "22:29", "レジュールアッシュ内見可能ですか？"), s("9/30", "12:07", INVITE2)];
    const inv = [at("9/30", "12:07")];
    const direct = resolveViewingFlow({ messages: [...head, c("9/30", "12:30", "はい！大丈夫です！")], inviteAts: inv, nowMs: Date.parse(at("9/30", "12:31")) });
    expect(direct.stage).toBe("date_agreed");
    const other = resolveViewingFlow({ messages: [...head, c("9/30", "15:23", "保証会社はどこですか？"), s("9/30", "15:25", "保証会社はナップ賃貸保証となります！！"), c("9/30", "15:30", "よろしくお願いします。")], inviteAts: inv, nowMs: Date.parse(at("9/30", "15:31")) });
    expect(other.stage).toBe("proposing"); expect(other.currentReply).toBe("none"); expect(viewingFlowNextAix(other)).toBe(null);
  });
  // 狭めすぎていないこと（成約した流れの実物はそのまま）
  it("変えない: 「でしたら16日でお願いします！」「8/25日火曜日日程でお願いします」「10日まだ空いてますか？」は候補の日を選んだ返事のまま", () => {
    expect(classifyCustomerDateReply("でしたら16日でお願いします！", ctx("6/15", "13:56", ["6/16", "6/18"])).kind).toBe("day_pick");
    expect(classifyCustomerDateReply("8/25日火曜日日程でお願いします(お願いします)", ctx("8/23", "19:21", ["8/25"])).kind).toBe("day_pick");
    expect(classifyCustomerDateReply("10日まだ空いてますか？", ctx("8/9", "10:41", ["8/10"])).kind).toBe("day_pick");
  });
  it("変えない: 「18日の17時以降なら可能です！」は候補の日を選んだ返事・「明日の内見、15時でお願いします」は日＋時刻", () => {
    expect(classifyCustomerDateReply("18日の17時以降なら可能です！", ctx("6/16", "21:20", ["6/16", "6/18"])).kind).toBe("day_pick");
    expect(classifyCustomerDateReply("明日の内見、15時でお願いします", ctx("6/16", "19:00", [])).kind).toBe("date_time");
    expect(classifyCustomerDateReply("では14日の16:00でお願いしたいです！", ctx("9/11", "11:00", ["9/14", "9/15"])).kind).toBe("date_time");
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
