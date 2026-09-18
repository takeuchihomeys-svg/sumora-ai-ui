// app/lib/__tests__/auto-reply-policy.test.ts
// 2026-09-18 竹内「自動ボタンに切り替えたお客さんは AIX以外自動で返信される（9:00〜21:00・3〜21分ランダム・
//   長文は10分以上・分かりやすい時間差は避けて奇数）。自動モードにしていないお客さんは絶対に勝手に自動にしない」
// 実行: npx tsx app/lib/__tests__/auto-reply-policy.test.ts
import {
  canAutoReply, isWithinAutoWindow, pickDelayMinutes, resolveAutoSendAt,
  DELAY_CHOICES, LONG_DELAY_CHOICES, LONG_TEXT_CHARS, AUTO_REPLY_WINDOW, type AutoReplyInput,
} from "../auto-reply-policy";

let pass = 0, fail = 0;
function t(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log(`  OK  ${name}`); }
  else { fail++; console.log(`  NG  ${name}${extra ? ` -- ${extra}` : ""}`); }
}
const jst = (s: string) => new Date(s).toISOString();

/** 全部そろった「送ってよい」状態 */
const OK: AutoReplyInput = {
  autoSendEnabled: true, lastSender: "customer", replyMode: "auto_reply", suggestedAixAction: null,
  draft: "かしこまりました！！\nお送り頂きました物件の募集状況確認させて頂きます😊！！",
  draftHasBlock: false, status: "proposing", hasPendingScheduled: false,
};

console.log("── 絶対に勝手に自動にしない（一番大事）");
{
  t("切り替えていない（null）→ 送らない", !canAutoReply({ ...OK, autoSendEnabled: null }).ok);
  t("切り替えていない（undefined）→ 送らない", !canAutoReply({ ...OK, autoSendEnabled: undefined }).ok);
  t("明示的に false → 送らない", !canAutoReply({ ...OK, autoSendEnabled: false }).ok);
  t("理由が auto_off で分かる", canAutoReply({ ...OK, autoSendEnabled: null }).reason === "auto_off");
  t("true の時だけ送る", canAutoReply(OK).ok);
}

console.log("── AIX はスタッフが送る（自動にしない）");
{
  t("reply_mode=aix → 送らない", !canAutoReply({ ...OK, replyMode: "aix" }).ok);
  t("AIX が指されている → 送らない", !canAutoReply({ ...OK, suggestedAixAction: "property_send" }).ok);
  t("理由が aix_mode / aix_suggested",
    canAutoReply({ ...OK, replyMode: "aix" }).reason === "aix_mode" &&
    canAutoReply({ ...OK, suggestedAixAction: "estimate_sheet" }).reason === "aix_suggested");
}

console.log("── 送ってはいけない状態（fail-closed）");
{
  t("お客様の番でない → 送らない", !canAutoReply({ ...OK, lastSender: "staff" }).ok);
  t("下書きが空 → 送らない", !canAutoReply({ ...OK, draft: "" }).ok);
  t("社内の合図が入った下書き → 送らない", !canAutoReply({ ...OK, draft: "[AIX誘導中]" }).ok);
  t("短すぎる下書き → 送らない", !canAutoReply({ ...OK, draft: "はい！！" }).ok);
  t("最終チェックで止められた → 送らない", !canAutoReply({ ...OK, draftHasBlock: true }).ok);
  t("既に予約がある → 送らない（二重送信防止）", !canAutoReply({ ...OK, hasPendingScheduled: true }).ok);
  for (const s of ["applying", "screening", "contract", "closed_won", "closed_lost"]) {
    t(`${s} は人が対応 → 送らない`, !canAutoReply({ ...OK, status: s }).ok);
  }
}

console.log("── 時間帯 9:00〜21:00（JST）");
{
  t("9:00 は送る", isWithinAutoWindow(jst("2026-09-19T09:00:00+09:00")));
  t("20:59 は送る", isWithinAutoWindow(jst("2026-09-19T20:59:00+09:00")));
  t("8:59 は送らない", !isWithinAutoWindow(jst("2026-09-19T08:59:00+09:00")));
  t("21:00 は送らない", !isWithinAutoWindow(jst("2026-09-19T21:00:00+09:00")));
  t("深夜は送らない", !isWithinAutoWindow(jst("2026-09-19T03:00:00+09:00")));
  t("窓は 9〜21", AUTO_REPLY_WINDOW.startHour === 9 && AUTO_REPLY_WINDOW.endHour === 21);
}

console.log("── 待ち時間 3〜21分・奇数・切りのいい数を避ける");
{
  t("候補は全部奇数", DELAY_CHOICES.every((n) => n % 2 === 1), DELAY_CHOICES.join(","));
  t("3〜21分に収まる", DELAY_CHOICES.every((n) => n >= 3 && n <= 21));
  t("「分かりやすい」5・10・15・20 を含まない", [5, 10, 15, 20].every((n) => !DELAY_CHOICES.includes(n)));
  t("長文の候補は全部10分より大きい", LONG_DELAY_CHOICES.every((n) => n > 10), LONG_DELAY_CHOICES.join(","));
  t("長文の候補も奇数", LONG_DELAY_CHOICES.every((n) => n % 2 === 1));

  const short = "かしこまりました！！ご確認させて頂きます！！";
  const long = "あ".repeat(LONG_TEXT_CHARS);
  t("短文は短い候補から", DELAY_CHOICES.includes(pickDelayMinutes(short, "c1|t1")));
  t("長文は10分以上", pickDelayMinutes(long, "c1|t1") > 10, String(pickDelayMinutes(long, "c1|t1")));
  t("同じ場面なら毎回同じ（cron が何度回っても予約が動かない）",
    pickDelayMinutes(short, "c1|t1") === pickDelayMinutes(short, "c1|t1"));
  const spread = new Set(Array.from({ length: 60 }, (_, i) => pickDelayMinutes(short, `conv${i}|t`)));
  t("会話ごとにばらける（60会話で4種類以上）", spread.size >= 4, [...spread].join(","));
}

console.log("── 送る時刻（窓の外にははみ出さない）");
{
  const r1 = resolveAutoSendAt({ customerMsgAt: jst("2026-09-19T14:00:00+09:00"), draft: "短い文です！！ありがとうございます！！", nowIso: jst("2026-09-19T14:00:30+09:00"), seedKey: "c1" });
  t("昼のやり取りはそのまま待って送る", r1.shifted === "none" && isWithinAutoWindow(r1.sendAt), JSON.stringify(r1));

  const r2 = resolveAutoSendAt({ customerMsgAt: jst("2026-09-19T20:55:00+09:00"), draft: "あ".repeat(200), nowIso: jst("2026-09-19T20:55:30+09:00"), seedKey: "c2" });
  t("夜に長文 → 翌朝9時台にずれる", r2.shifted === "next_morning" && isWithinAutoWindow(r2.sendAt), JSON.stringify(r2));
  t("翌朝の分も窓の中", isWithinAutoWindow(r2.sendAt));

  const r3 = resolveAutoSendAt({ customerMsgAt: jst("2026-09-19T03:00:00+09:00"), draft: "深夜に来たメッセージへの返信です！！", nowIso: jst("2026-09-19T03:01:00+09:00"), seedKey: "c3" });
  t("深夜に来た分は当日の朝9時台", r3.shifted === "morning" && isWithinAutoWindow(r3.sendAt), JSON.stringify(r3));

  // 下書きが遅れて、もう待ち時間を過ぎている時
  const r4 = resolveAutoSendAt({ customerMsgAt: jst("2026-09-19T14:00:00+09:00"), draft: "遅れて出来た下書きです！！よろしくお願い致します！！", nowIso: jst("2026-09-19T14:40:00+09:00"), seedKey: "c4" });
  t("待ち時間を過ぎていたら今以降に送る", Date.parse(r4.sendAt) >= Date.parse(jst("2026-09-19T14:40:00+09:00")), r4.sendAt);

  t("同じ入力なら同じ時刻（予約が動かない）",
    resolveAutoSendAt({ customerMsgAt: jst("2026-09-19T14:00:00+09:00"), draft: "同じ文です！！よろしくお願いします！！", nowIso: jst("2026-09-19T14:00:30+09:00"), seedKey: "c9" }).sendAt ===
    resolveAutoSendAt({ customerMsgAt: jst("2026-09-19T14:00:00+09:00"), draft: "同じ文です！！よろしくお願いします！！", nowIso: jst("2026-09-19T14:00:30+09:00"), seedKey: "c9" }).sendAt);
}

console.log(`\n合計: ${pass}/${pass + fail}`);
if (fail > 0) process.exit(1);
