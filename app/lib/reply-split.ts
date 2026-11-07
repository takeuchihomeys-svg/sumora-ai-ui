// app/lib/reply-split.ts — 返信を2〜3通に分けて出す下書き（書き手への1行と、下書きを通に分ける純関数）
//
// 2026-11-07 作業員9（竹内さん「下書きを通ごとに分けて出す」・統括役の分担・作業員7の TWO_MESSAGE_SEQUENCE と組む）:
//   竹内さん本人の 90日: 1つの番に返信を2通以上に分けた番 18%（2通 12.7%・3通以上 5.3%）。
//   分けた番の役目: 1通目＝受け止め（29%・2通目は 5%）＋答え（31%）、2通目＝答えの続き（43%）・誘い（20%）・締め（19%）。
//   1通 76〜94字・間は1分ほど。2通目の出だしに決まった語は無い（中身からそのまま始まる）。
//   下書き（分けた番 97）は1通目の中身に寄り、2通目以降の中身はほぼ入っていなかった（2通目の重なり 0.10）。
// 境目（作業員7と 11/07 に決めた）:
//   作業員7: ブレインが並びを決める（meta.send_sequence・meta.send_sequence_reply_count＝返信の通数 1〜3）・画面の表示と送信
//   作業員9: 書き手への1行（返信の通数が2以上の時だけ）・分け目の印「---」の行・splitReplyDraft
// 既定 off（REPLY_SPLIT_WRITER=on で入る）。

export const SPLIT_MARK = "---";
const SPLIT_LINE_RE = /^\s*-{3,}\s*$/;

export function replySplitWriterOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.REPLY_SPLIT_WRITER ?? "").trim().toLowerCase() === "on";
}

/** meta.send_sequence_reply_count を 1〜3 に丸める（無い・壊れている時は 1） */
export function replyCountOf(meta: { send_sequence_reply_count?: unknown } | null | undefined): number {
  const n = Number(meta?.send_sequence_reply_count);
  return Number.isFinite(n) ? Math.max(1, Math.min(3, Math.round(n))) : 1;
}

const ROLE_BY_COUNT: Record<number, string[]> = {
  2: ["受け止め＋答え（聞かれた事への答えの中心）", "答えの続き・誘い・締め"],
  3: ["受け止め＋答え（聞かれた事への答えの中心）", "答えの続き", "誘い・締め"],
};

/** 書き手への1行（返信の通数が2以上で、スイッチが on の時だけ）。roles は send_sequence の返信の役目（あればそれを使う） */
export function replySplitWriterNote(count: number, roles?: ReadonlyArray<string> | null, env?: Record<string, string | undefined>): string | null {
  if (!replySplitWriterOn(env) || count < 2) return null;
  const rs = roles && roles.length === count ? [...roles] : ROLE_BY_COUNT[count] ?? ROLE_BY_COUNT[2];
  const parts = rs.map((r, i) => `${i + 1}通目＝${r}`).join("／");
  return `- ✂️ この返信は${count}通に分けて送る（竹内さんの分け方）: ${parts}。通と通の間は「${SPLIT_MARK}」だけの行で区切る。受け止め（かしこまりました等）は1通目だけ・1通は 76〜94字ほど・2通目は中身からそのまま始める（「また」「なお」で始めない）。同じ事を2つの通で繰り返さない`;
}

/** 下書きを通に分ける（「---」だけの行で区切る）。空の通は捨てる。印が無ければ1通のまま */
export function splitReplyDraft(text: string | null | undefined): string[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const out: string[][] = [[]];
  for (const l of lines) {
    if (SPLIT_LINE_RE.test(l)) { out.push([]); continue; }
    out[out.length - 1].push(l);
  }
  return out.map((ls) => ls.join("\n").replace(/^\n+|\n+$/g, "")).filter((s) => s.trim());
}

/** 通に分けた物をつなぎ直す（最終チェック・出口の決定論を通ごとに当てた後に戻す時） */
export function joinReplyDraft(parts: ReadonlyArray<string>): string {
  return parts.map((p) => p.trim()).filter(Boolean).join(`\n${SPLIT_MARK}\n`);
}

/** 通ごとに同じ直しを当てる（最初の通だけ fnFirst があればそれ・例 挨拶の付け直しは1通目だけ） */
export function mapReplyParts(text: string, fn: (part: string, i: number) => string): string {
  const parts = splitReplyDraft(text);
  if (parts.length <= 1) return fn(text, 0);
  return joinReplyDraft(parts.map((p, i) => fn(p, i)));
}
