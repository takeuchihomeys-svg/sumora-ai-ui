// app/lib/own-property-jev.ts
// お客様が送ってきた画像の**読み取り文**が、こちらが前に送ったどの物件かを Jev（TypeSafe AI・System One）に選ばせる。
//
// 2026-09-23 竹内「お客さんが送ってきた画像が、こちらから送った画像かどうかの判定も Jev でできるのかな？
//   それで判定したら送ったどの画像なのか確認して会話生成する動き」
//
// ── なぜ Jev がここに向くか ──
//   ・Jev は**文字しか読めない**（画像は渡せない）。画像を読むのは今までどおり Claude（line-webhook の extractImageContent）で、
//     Jev が見るのはその書き起こしだけ。設計知見「画像は別クラウドに出さない」をそのまま守れる。
//   ・「こちらが送った物件の一覧から1つ選ぶ（どれでもないを含む）」は選択肢の問題＝Jev の choice そのもの。
//     確率が返るので「0.8 以上だけ使う」のような線を実測で引ける。
//
// ── 今の仕組み（決定論）との役割分担 ──
//   ①まず own-property-match（純関数）で物件名を取り出して照合する。名前が取れて号室も一致すれば Jev は呼ばない。
//   ②取り出せない・照合できない時だけ Jev に聞く。全件監査（180日 222通）では、物件名を取り出せたのは 58通（26.1%）で、
//     残りは書き起こしの形がばらばら（見出しが無い・間取りの説明だけ・ポータルの画面）だった。
//     正規表現の形を足し続けても追いつかないので、ここから先は分類器に渡す。
//   ③**最初は影の運用**（答えを記録するだけで judgement は変えない）。scripts/audit-own-property-image.ts --jev で
//     スタッフの実際の返し（募集状況確認したか／御見積書を出したか）と突き合わせてから繋ぐ。
//
// ⚠ 個人情報: 書き起こしは会話本文なので、渡す前に呼び出し側が仮名化する（pii-pseudonym）。本人確認書類は
//   そもそも書き起こしを保存していないので渡らない。申込以降の会話は呼ばない。
import { jevSystemOne, type JevAnswer, type JevQuestion, type JevResult } from "./jev-client";
import { normalizeRoom } from "./own-property-match";

/** 選択肢に出す「こちらが送った物件」 */
export type SentChoice = { name: string; room: string | null; sentAt: string | null };

/** 選択肢のキー（Jev が返す文字列）。物件名と号室から作る（同じ物件の重複は1つにまとめる） */
export function choiceKeyFor(s: SentChoice): string {
  const room = normalizeRoom(s.room);
  return `p_${s.name.replace(/\s+/g, "")}${room ? `_${room}` : ""}`.slice(0, 60);
}

/** 「どれでもない」（お客様が自分で見つけた物件） */
export const NONE_KEY = "none";
/** 選択肢の上限（Jev は 255 まで。多すぎる会話は新しい順に絞る） */
export const MAX_CHOICES = 60;

export type OwnPropertyJevInput = {
  /** お客様の画像の読み取り文（"[画像] …"・仮名化済み） */
  transcript: string;
  /** こちらが送った物件（新しい順でも古い順でもよい。新しい方を残す） */
  sent: ReadonlyArray<SentChoice>;
};

/** 同じ物件名＋号室は1つにまとめ、新しい順に MAX_CHOICES 件まで */
export function dedupeChoices(sent: ReadonlyArray<SentChoice>): SentChoice[] {
  const byKey = new Map<string, SentChoice>();
  for (const s of sent) {
    if (!s.name || s.name.trim().length < 2) continue;
    const k = choiceKeyFor(s);
    const prev = byKey.get(k);
    if (!prev || (s.sentAt ?? "") > (prev.sentAt ?? "")) byKey.set(k, s);
  }
  return [...byKey.values()].sort((a, b) => (b.sentAt ?? "").localeCompare(a.sentAt ?? "")).slice(0, MAX_CHOICES);
}

const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : "日付不明");

/** 質問を組み立てる。送った物件が1件も無ければ null（聞く意味が無い） */
export function buildOwnPropertyJevQuestion(sent: ReadonlyArray<SentChoice>): JevQuestion | null {
  const choices = dedupeChoices(sent);
  if (choices.length === 0) return null;
  const criteria: Record<string, string> = {
    [NONE_KEY]: "この一覧のどれでもない（お客様が自分で見つけた物件、または物件の画像ではない）",
  };
  for (const c of choices) {
    criteria[choiceKeyFor(c)] = `${c.name}${normalizeRoom(c.room) ? ` ${normalizeRoom(c.room)}号室` : ""}（こちらが${md(c.sentAt)}に送った物件）`;
  }
  return {
    type: "choice",
    // 指示は state を「データ」として読ませる（誘導しない）。建物が同じでも号室が違えば別の部屋である事を明示する
    instructions: "customer_image_text は、お客様が送ってきた画像に写っていた文字です。これはこの一覧のどの物件ですか。建物名が同じでも号室が違えば「どれでもない」を選ぶ",
    criteria,
  };
}

export type OwnPropertyJevDecision = {
  /** 選ばれた物件（none の時は null） */
  choice: SentChoice | null;
  key: string;
  prob: number;
  confidence: number | null;
};

export function parseOwnPropertyJevAnswer(answer: JevAnswer | undefined, sent: ReadonlyArray<SentChoice>): OwnPropertyJevDecision | null {
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") return null;
  const probabilities = answer.probabilities ?? {};
  const prob = typeof probabilities[answer.choice] === "number" ? probabilities[answer.choice] : 1;
  const confidence = typeof answer.confidence === "number" ? answer.confidence : null;
  if (answer.choice === NONE_KEY) return { choice: null, key: NONE_KEY, prob, confidence };
  const hit = dedupeChoices(sent).find((c) => choiceKeyFor(c) === answer.choice);
  if (!hit) return null;   // 知らない選択肢は使わない
  return { choice: hit, key: answer.choice, prob, confidence };
}

/**
 * Jev に聞く。鍵が無い・送った物件が無い・失敗は null（今までどおり決定論だけで動く）。
 * ⚠ transcript は仮名化済みで渡す。
 */
export async function askOwnPropertyJev(
  input: OwnPropertyJevInput & { conversationId?: string | null; timeoutMs?: number; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch },
): Promise<{ decision: OwnPropertyJevDecision; raw: JevResult } | null> {
  const q = buildOwnPropertyJevQuestion(input.sent);
  if (!q) return null;
  const raw = await jevSystemOne({
    state: { customer_image_text: input.transcript.replace(/^\[画像\]\s*/, "").slice(0, 1500) },
    questions: { which_property: q },
    action: "own_property", conversationId: input.conversationId ?? null,
    timeoutMs: input.timeoutMs, env: input.env, fetchImpl: input.fetchImpl,
  });
  if (!raw) return null;
  const decision = parseOwnPropertyJevAnswer(raw.answers.which_property, input.sent);
  return decision ? { decision, raw } : null;
}
