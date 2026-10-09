// app/lib/time-greeting.ts
// 時刻の挨拶（こんばんは／こんにちは／おはようございます）を返信に書かない・下書きの挨拶を「送る今」に合わせる。純関数・DB 依存なし。
//
// 2026-10-08 竹内さん（り・イエヤス 8f705d16・スクショ付き）:
//   「こんばんは。この時間に送るのおかしいので、ちゃんと生成する際時間見る。また、お客さんに送る挨拶は『お世話になっております』となる」
// ■ 実物: お客様 10/07 20:40「こんばんは！⏎⏎サンライト阿倍野8⏎の202は⏎子ども不可ですか？」
//   → 下書き 10/07 20:41（bg-async・DeepSeek）「こんばんは！⏎サンライト阿倍野8の202号室の子ども入居可否…」
//   → 作り直し 10/08 11:07（generate-reply・DeepSeek・JST 11時）も「こんばんは！⏎⏎サンライト阿倍野8の202号室、お子様不可か…」
//   → 10/08 12:29 にそのまま送信。＝夜の下書きの持ち越しではなく、**昼に作っても**お客様の挨拶をまねた（オウム返し）。
//   挨拶の決定（greeting.resolveGreeting）は standard（今日まだ送っていない）で正しかったが、
//   ① 注記（buildGreetingNote）に時刻の挨拶を書くなという線が無い ② 出口（enforceOpening の GREETING_STRIP_RE）が
//   こんばんは等を挨拶の行として拾わない（standard は enforce=false なので LLM の書き出しがそのまま残る）、の2つで通っていた。
// ■ 実送信（scripts/audit-time-greeting.ts・messages 全期間・AIX を除く手打ち）:
//   竹内さん（staff_writer=takeuchi）1,812通で時刻の挨拶から書き出したのは 2通（どちらも朝の「おはようございます」）。
//   お客様が「こんばんは」で始めた番 2通 → 竹内さんは 2通とも「お世話になっております」。従業員 2,757通では 0通。
//   時刻の挨拶で始まる送信は、他は全部 AI の下書きをそのまま送った物（5月の初期の下書き・今回の1通）。
// ■ 直した形:
//   入口 … 注記に「時刻の挨拶は書かない・置くなら『〇〇さんお世話になっております！！』」（greeting.buildGreetingNote）
//          手本（ai_reply_examples）の頭の時刻の挨拶は「お世話になっております」に置き換えて見せる（replaceHeadTimeGreeting）
//   出口 … enforceOpening が時刻の挨拶の行も挨拶の行として剥がす（standard なら決定の挨拶「〇〇さんお世話になっております！！」に差し替わる・
//          今日すでに送っていれば挨拶なし）
//   画面 … 前に作った下書きを入力欄に出す時、送る今の日（JST）で挨拶を直す（refreshDraftGreetingForNow）:
//          時刻の挨拶 → 今日まだ会話文を送っていなければ「〇〇さんお世話になっております！！」・送っていれば外す／
//          お世話になっておりますを外す・足す向きはしない（外す向きは監査で誤削除 32/122 ＝入れない）。
// 戻す: TIME_GREETING_R11=off（生成の入口と出口）／NEXT_PUBLIC_DRAFT_GREETING_REFRESH=off（画面）

import { staffTalkedToday, applyDailyGreeting, type TalkMsg } from "./daily-greeting";

/** 時刻の挨拶の語（長い方を先に） */
// 「今晩は」は「今晩はご都合…」の文頭と見分けられないので入れない
const TIME_WORD_SRC = "(?:こんばんは|こんばんわ|こんにちは|こんにちわ|おはようございます|おはよう)";
/** 呼びかけ（〇〇さん）。挨拶の前・後どちらにも付く（「ゆうきさん、こんにちは😊」「おはようございます、ちあきさん！」） */
const CALL_SRC = "[^\\n！!。、,？?]{1,15}(?:さん|様)";
const DECOR_SRC = "[😊😌🌟✨☺️💛🙇‍♀♂️]*";

/**
 * 先頭（空行を飛ばした最初の行）の時刻の挨拶。
 * 1: 前の呼びかけ（あれば）2: 後ろの呼びかけ（あれば）。挨拶の後の本文は同じ行に残ってよい。
 */
export const TIME_GREETING_HEAD_RE = new RegExp(
  `^[ \\t　]*(?:(${CALL_SRC})[、,]?[ \\t　]*)?${TIME_WORD_SRC}(?:[、,]?[ \\t　]*(${CALL_SRC}))?${DECOR_SRC}[！!。、,]*${DECOR_SRC}[！!]*[ \\t　]*`,
  "u",
);

export function timeGreetingEnabled(): boolean {
  return process.env.TIME_GREETING_R11 !== "off";
}

export type TimeGreetingHead = { lineIndex: number; call: string; rest: string; matched: string };

/** 先頭の行が時刻の挨拶で始まるか（始まらなければ null） */
export function findHeadTimeGreeting(text: string): TimeGreetingHead | null {
  if (!text) return null;
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return null;
  const m = TIME_GREETING_HEAD_RE.exec(lines[i]);
  if (!m) return null;
  const rest = lines[i].slice(m[0].length);
  // 挨拶の語の直後に区切り（記号・絵文字・空白・呼びかけ・行末）が無ければ文の一部（「おはようの時間に…」）＝挨拶の行ではない
  if (rest.trim() && /[ぁ-んァ-ヶー一-龠a-zA-Z0-9]$/u.test(m[0])) return null;
  return { lineIndex: i, call: (m[1] ?? m[2] ?? "").trim(), rest: rest.trim(), matched: m[0] };
}

/**
 * 先頭の時刻の挨拶を外す（呼びかけも一緒に外す）。本文が同じ行に続く時は本文を残す。
 * 生成の出口（greeting.enforceOpening）で使う。外した後の挨拶の行は挨拶の決定が置く。
 */
export function stripHeadTimeGreeting(text: string): { text: string; removed: string | null } {
  const h = findHeadTimeGreeting(text);
  if (!h) return { text, removed: null };
  const lines = text.split("\n");
  const out = h.rest ? [...lines.slice(0, h.lineIndex), h.rest, ...lines.slice(h.lineIndex + 1)] : [...lines.slice(0, h.lineIndex), ...lines.slice(h.lineIndex + 1)];
  return { text: out.join("\n").replace(/^\s*\n/, "").replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n"), removed: h.matched.trim() };
}

/**
 * 先頭の時刻の挨拶を「〇〇さんお世話になっております！！」に置き換える（呼びかけは元の物を使う・無ければ name）。
 * 手本の入口と画面の下書きで使う。挨拶の行の後の空行は1つの改行にそろえる（竹内さんの形＝挨拶の行の次の行から本文）。
 */
export function replaceHeadTimeGreeting(text: string, name = ""): { text: string; replaced: boolean } {
  const h = findHeadTimeGreeting(text);
  if (!h) return { text, replaced: false };
  // 次の行にもう「お世話になっております」がある（「おはようございます、〇〇さん！⏎こちらこそ、いつもお世話に…」）→ 重ねず時刻の挨拶だけ外す
  const s0 = stripHeadTimeGreeting(text);
  if (/お世話になっております/.test(s0.text.split("\n").filter((l) => l.trim()).slice(0, 2).join("\n"))) return { text: s0.text, replaced: true };
  const call = h.call || name;
  const lines = text.split("\n");
  const head = `${call}お世話になっております！！`;
  let after = lines.slice(h.lineIndex + 1);
  if (!h.rest) { while (after.length && !after[0].trim()) after = after.slice(1); }
  const out = [...lines.slice(0, h.lineIndex), head, ...(h.rest ? [h.rest] : []), ...after];
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n"), replaced: true };
}

export type DraftGreetingRefresh = { text: string; fixes: string[] };

/**
 * 前に作った下書きを入力欄に出す時、送る今（JST の暦日）で挨拶を直す。足す向きはしない（挨拶は必須ではない＝実送信の1/3）。
 * @param messages 会話（こちらの会話文が今日あるかを見る。資料文・画像は数えない＝生成の computeAlreadyGreetedToday と同じ線）
 * @param name 「〇〇さん」（分からなければ ""）
 */
export function refreshDraftGreetingForNow(draft: string, opts: { messages: ReadonlyArray<TalkMsg>; name: string; now?: number; ensureDaily?: boolean }): DraftGreetingRefresh {
  if (!draft?.trim()) return { text: draft, fixes: [] };
  const now = opts.now ?? Date.now();
  const talkedToday = staffTalkedToday(opts.messages, now);
  const fixes: string[] = [];
  let text = draft;
  if (findHeadTimeGreeting(text)) {
    if (talkedToday) {
      const s = stripHeadTimeGreeting(text);
      text = s.text;
      fixes.push(`時刻の挨拶「${s.removed}」を外した（今日すでにこちらが送っている）`);
    } else {
      text = replaceHeadTimeGreeting(text, opts.name).text;
      fixes.push("時刻の挨拶を「お世話になっております」に置き換え（竹内さんの形・今日はじめての送信）");
    }
    return { text, fixes };
  }
  // 「お世話になっております」を今日すでに送った後に外す向きは入れない（監査 scripts/audit-time-greeting.ts D: AI の下書き 2,927件に当てて
  //   変わる 122件のうち送った文と挨拶の有無が合う 90／外れ 32＝スタッフが残して送った番がある＝誤削除0にならない。C: 人の手打ちでも 152通が変わる）
  // 2026-10-08 竹内さんの決定「今日初めての連絡なら『お世話になっております』を付ける。2回目以降なら入れない」で上の線を上書き（ensureDaily）:
  //   今日まだ会話文を送っていない → 挨拶が無ければ「〇〇さんお世話になっております！！」を足す（🌟物件カード・【】見積・初回のはじめまして・催促の謝罪には足さない）／
  //   今日すでに送っている → 冒頭の「お世話になっております」を外す（名前の行は残す）。足し外しは daily-greeting.applyDailyGreeting（AIX の仕上げと同じ関数）。
  //   戻す: NEXT_PUBLIC_DRAFT_GREETING_REQUIRED=off（画面）
  if (opts.ensureDaily) {
    const head = text.split("\n").filter((l) => l.trim()).slice(0, 2).join("\n");
    if (!talkedToday && /申し訳|お待たせ/.test(head)) return { text, fixes };
    // 外す向きは「お世話になっております」だけ（夜にこちらから届ける「夜分遅くに失礼致します」は竹内さんが2通目以降にも書く＝決定の対象外・監査 scripts/audit-1008-greeting-name.ts）
    if (talkedToday && !/お世話になっております/.test(head)) return { text, fixes };
    const call = opts.name.replace(/さん$/, "");
    const r = applyDailyGreeting(text, { staffSentToday: talkedToday, greetingPhrase: "お世話になっております！！", name: call ? `${call}さん` : "", joinNameLine: true });
    if (r.action === "added") fixes.push("今日はじめての会話文なので「お世話になっております」を足した（竹内さん 10/08）");
    if (r.action === "removed") fixes.push("今日すでに会話文を送っているので「お世話になっております」を外した（竹内さん 10/08）");
    // 外した後に「〇〇さん⏎⏎本文」と名前の行の後に空行が残る時は空行を詰める（監査で 10通・名前の行だけ残す形は書き手 B の形）
    const out = r.action === "removed" ? r.text.replace(/^([ \t　]*[^\n！!。、\s]{1,15}さん[ \t　]*)\n[ \t　]*\n+/, "$1\n") : r.text;
    return { text: out, fixes };
  }
  return { text, fixes };
}

/** 画面の旗（既定 on）。NEXT_PUBLIC_ は build 時に埋まる */
export function draftGreetingRefreshEnabled(flag: string | undefined): boolean {
  return (flag ?? "on").trim().toLowerCase() !== "off";
}
