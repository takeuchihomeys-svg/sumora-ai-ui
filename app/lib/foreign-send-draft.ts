// app/lib/foreign-send-draft.ts
// 別の画面（同じ PC の別のタブ・別の端末・別のスタッフ）がこの会話に送った時、この画面の入力欄に残っている下書きをどうするか（純関数・依存なし）。
//
// 2026-10-20 竹内さん（12:42 の画面「文を送ったのにまだ下書きに同じのが新しく出てきているバグ」）:
//   調べると、同じ PC の Chrome で同じ会話が2つの画面（タブ）で開いていた（Supabase の edge_logs: 予約一覧の30秒ごとの読み直しが2組・ずれ2秒）。
//   1つ目の画面が 12:39:29 に下書きを入力欄に入れて「表示済み」（ai_draft='__SHOWN__'＋控え ai_draft_shown）にし、
//   2つ目の画面が 12:40:56 に開いた時に控えから同じ下書きを戻した（shown-draft-restore・10/08）。片方で直して 12:41:10 に送った後も、
//   もう片方の入力欄には直す前の下書きが「⚡ AI下書き」のまま残った。送った画面は入力欄を空にするが、別の画面の入力欄を空にする処理が無かった。
//   サーバーは作り直していない（送った後の reply_generate なし・ai_draft は null）。今日の直し（53d2a22b・31a908f2）はこの道を通らない。
//   → スタッフの送信（messages の INSERT が Realtime で届いた）を見て、この画面の入力欄が「直していない AI の下書き」か「送った文とほぼ同じ文」なら空にする。
//     スタッフが手で書き換えた別の文は消さない（知らせるだけ）。この画面自身の送信（直後に届く自分の通）は触らない。
//   戻す: NEXT_PUBLIC_FOREIGN_SEND_CLEAR=off

export type ForeignSendDecision = "keep" | "clear" | "notice";

export type ForeignSendInput = {
  /** 入力欄の今の文 */
  replyDraft: string | null | undefined;
  /** 入力欄が AI の下書きのまま（直していない）か（page.tsx の displaySource !== null） */
  draftIsAi: boolean;
  /** 届いたスタッフの通の本文（画像は "[画像]"） */
  staffText: string | null | undefined;
  /** 届いたスタッフの通の時刻 */
  staffAt: string | null | undefined;
  /** この画面が最後にスタッフの通を DB に入れた時刻（ms・自分の送信の見分け） */
  ownInsertAtMs: number | null | undefined;
  /** この画面が今送っている途中か */
  sending: boolean;
  nowMs: number;
};

/** 自分の送信と見なす幅（画面の insert の後に Realtime が返ってくるまで・遅れて届く2通目の予約は sendMessageText が印を付け直す） */
export const OWN_SEND_WINDOW_MS = 20_000;
/** 古い通（読み直しで後から届いた等）は触らない */
const STALE_EVENT_MS = 3 * 60_000;

/** 比べる前にそろえる（空白・句読点・感嘆符・絵文字を外す） */
function norm(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, "")
    .replace(/[。、，,．.！!？?・…「」『』（）()【】〜~ー－\-'"“”:：]/g, "")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "");
}

/**
 * 送った文と入力欄の文が「同じ下書きから出た物」か。片方がもう片方を含み、短い方が長い方の6割以上（直して1行消した・足した程度）。
 * 10/20 の例: 下書き3行 → 2行目まで送った（ご査収の行を消した）＝ 含む・約7割。
 */
export function isSameDraftFamily(composer: string | null | undefined, sent: string | null | undefined): boolean {
  const a = norm(composer), b = norm(sent);
  if (a.length < 6 || b.length < 6) return a.length > 0 && a === b;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.includes(short) && short.length >= long.length * 0.6;
}

export function decideForeignSendDraft(i: ForeignSendInput): ForeignSendDecision {
  const draft = (i.replyDraft ?? "").trim();
  if (!draft) return "keep";
  if (i.sending) return "keep";
  if (i.ownInsertAtMs != null && i.nowMs - i.ownInsertAtMs >= 0 && i.nowMs - i.ownInsertAtMs < OWN_SEND_WINDOW_MS) return "keep";
  const at = i.staffAt ? Date.parse(i.staffAt) : NaN;
  if (Number.isFinite(at) && i.nowMs - at > STALE_EVENT_MS) return "keep";
  // 画像・動画だけの送信は、入力欄の文と一緒に送るつもりの事がある（物件の画像の後に文）→ 消さずに知らせる
  if (/^\s*\[(?:画像|動画|ファイル)\]\s*$/.test(i.staffText ?? "")) return "notice";
  if (i.draftIsAi) return "clear";
  if (isSameDraftFamily(draft, i.staffText)) return "clear";
  return "notice";
}

/** 旗（既定 on） */
export function foreignSendClearEnabled(flag: string | undefined | null): boolean {
  return (flag ?? "on").trim().toLowerCase() !== "off";
}
