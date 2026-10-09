// app/lib/draft-coherence.ts — 下書きの「継ぎ目」（文のまとまりの崩れ）を見つける純関数（2026-10-09）
//
// 竹内さん（2026-10-09）「文の組み立てが、単語をつなげただけのような部分がたまにある。AI で生成した文が全体としてまとまりがない場合がある」。
//   出口（決定論の差し込み・削除・置き換え）と最終チェックの部分の書き直しが、文の途中を切ったり（「中に決められましたら」）、
//   同じ事を2回言わせたり、締めを重ねたりする。ここでは「継ぎ目の型」を決まった計算で数える（LLM なし）。
//
//   型（誤検知の線は人の実送信に当てて確かめる＝scripts/audit-draft-coherence.ts の「人の文での率」）:
//     FRAGMENT_HEAD  文の頭が助詞・接続のかけら（「を」「に」「中に」「ので」「、」から始まる）
//     DANGLING_TAIL  行の終わりが続きを待つ形（「〜ので、」「〜が、」「〜、」）のまま次の行が別の文
//     DUP_SENTENCE   同じ事を2回（12字以上の文で、ほぼ同じ文字の並び）
//     DOUBLE_CLOSE   締めの重なり（「よろしくお願い」2回・「何卒」2回・「全力で…サポート」2回）
//     PUNCT_JUNK     句読点の崩れ（「、。」「。。」「、、」「！！、」「ので。」・空の括弧）
//     PARTICLE_STOP  助詞で文が止まる（「物件を！！」「〜に。」）
//
//   使い方: 監査（scripts/audit-draft-coherence.ts）・出口の後の点検（generate-reply の coherenceAfterOutlet）。
//   本文は変えない（印だけ）。

export type SeamKind = "FRAGMENT_HEAD" | "DANGLING_TAIL" | "DUP_SENTENCE" | "DOUBLE_CLOSE" | "PUNCT_JUNK" | "PARTICLE_STOP";
export type Seam = { kind: SeamKind; evidence: string };

const TERMINAL_RE = /[。！!？?]+|[\u{1F300}-\u{1FAFF}✨⭐]+/u;

/** 行ごと・文ごとに分ける（「！！」「。」「？」と絵文字の後で切る）。空は落とす */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? "").split(/\n+/)) {
    const t = line.trim();
    if (!t) continue;
    // 終わりの記号（連続・直後の絵文字を含む）の後で切る
    const parts = t.split(/(?<=[。！!？?](?![。！!？?\u{1F300}-\u{1FAFF}✨⭐]))|(?<=[\u{1F300}-\u{1FAFF}✨⭐]+[。！!？?]*)(?=[^\u{1F300}-\u{1FAFF}✨⭐！!。？?])/u);
    for (const p of parts) { const s = p.trim(); if (s) out.push(s); }
  }
  return out;
}

/** 資料・一覧の行（🌟物件カード・【】見出し・・の箇条・URL・数字だけ）は文として見ない */
function isListOrMaterialLine(s: string): boolean {
  return /^(?:[・●■◆※▼▶→①-⑳\-–*]|【|🌟|https?:|\d+[.)．）]|[（(]\d)/u.test(s) || /^[\d\s,，.万円¥〜~ー－\-:：/／()（）%]+$/.test(s);
}

// 文の頭のかけら。日本語の普通の書き出し（もし・もちろん・では・でも・でしたら・はい・はじめまして・とても・ところで・にて）は外す
const FRAGMENT_HEAD_RE = /^(?:を|に(?!て|ゃ)|が(?!ん)|へ(?!や)|は(?!い|じめ|や)|で(?!し|は|も|き|す|ご|お)|や(?!は|っ)|中に|中で|ので|のため|ため[、に]|けど|けれど|から[、は]|まで[、は]|より[、は]|[、，。・]{1}(?![・]))/u;
// 行の終わりが続きを待つ形（読点・接続の助詞で終わる）
const DANGLING_TAIL_RE = /(?:ので|ため|けど|けれど|ですが|ますが|が|て|し|、|，)$/u;
const PUNCT_JUNK_RE = /、[。！!？?]|。[。、]|、、|！！[、。]|ので。|(?:（\s*）|「\s*」|【\s*】)/u;
const PARTICLE_STOP_RE = /(?:[^ぁ-ん]|^)(?:を|に|が|へ|で|と)(?:！！|！|。)(?!\S*[ぁ-ん]{0,1}$)/u;

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  const t = s.replace(/[\s。、！!？?😊😌🌟✨]/gu, "");
  for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}
function dice(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

/** 下書き（返信の本文）の継ぎ目を全部返す。本文は変えない */
export function findSeams(text: string): Seam[] {
  const seams: Seam[] = [];
  const body = String(text ?? "");
  if (!body.trim()) return seams;
  const lines = body.split(/\n/).map((l) => l.trim());
  const sentences = splitSentences(body).filter((s) => !isListOrMaterialLine(s));

  // FRAGMENT_HEAD（行頭・文頭）
  for (const s of sentences) {
    if (FRAGMENT_HEAD_RE.test(s)) seams.push({ kind: "FRAGMENT_HEAD", evidence: s.slice(0, 40) });
  }
  // DANGLING_TAIL（行の終わり・次の行が空でない普通の文の時だけ）
  for (let i = 0; i < lines.length - 1; i++) {
    const cur = lines[i], next = lines[i + 1];
    if (!cur || !next || isListOrMaterialLine(cur) || isListOrMaterialLine(next)) continue;
    if (TERMINAL_RE.test(cur.slice(-1))) continue;
    if (DANGLING_TAIL_RE.test(cur) && cur.length >= 6) seams.push({ kind: "DANGLING_TAIL", evidence: `${cur.slice(-20)}⏎${next.slice(0, 12)}` });
  }
  // 最後の行が続きを待つ形
  const last = lines.filter(Boolean).pop() ?? "";
  if (last && !isListOrMaterialLine(last) && /(?:ので|ため|けど|ですが|ますが|、)$/u.test(last)) seams.push({ kind: "DANGLING_TAIL", evidence: last.slice(-20) });

  // DUP_SENTENCE
  const long = sentences.filter((s) => s.replace(/\s/g, "").length >= 12);
  for (let i = 0; i < long.length; i++) {
    for (let j = i + 1; j < long.length; j++) {
      const a = long[i], b = long[j];
      if (a === b || dice(a, b) >= 0.72) { seams.push({ kind: "DUP_SENTENCE", evidence: `${a.slice(0, 24)}｜${b.slice(0, 24)}` }); break; }
    }
  }
  // DOUBLE_CLOSE
  const closeCounts: Array<[string, RegExp]> = [
    ["よろしくお願い", /よろしくお願い/g],
    ["何卒", /何卒/g],
    ["全力でサポート", /全力で(?:お部屋探し(?:の)?)?サポート/g],
    ["引き続き", /引き続き/g],
  ];
  for (const [k, re] of closeCounts) {
    const n = (body.match(re) ?? []).length;
    if (n >= 2) seams.push({ kind: "DOUBLE_CLOSE", evidence: `${k}×${n}` });
  }
  // PUNCT_JUNK
  const pj = body.match(PUNCT_JUNK_RE);
  if (pj) seams.push({ kind: "PUNCT_JUNK", evidence: body.slice(Math.max(0, (pj.index ?? 0) - 12), (pj.index ?? 0) + 6) });
  // PARTICLE_STOP（資料の行は見ない）
  for (const s of sentences) {
    const m = s.match(PARTICLE_STOP_RE);
    if (m && !/^(?:はい|いいえ)/.test(s)) { seams.push({ kind: "PARTICLE_STOP", evidence: s.slice(Math.max(0, (m.index ?? 0) - 12), (m.index ?? 0) + 4) }); break; }
  }
  return seams;
}

/** 型ごとの数（監査用） */
export function seamKinds(text: string): SeamKind[] {
  return [...new Set(findSeams(text).map((s) => s.kind))];
}
