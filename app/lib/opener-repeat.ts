// app/lib/opener-repeat.ts
// 2026-10-06 ⑫ 竹内さん「かしこまりました が並んでいるの文としておかしい。文としておかしいか判断できる部分は機能しているのか」（ゆいと 10/03 の下書き）:
//   「かしこまりました！！\nかしこまりました😊！！\n\n10月後半ご入居可能なお部屋も…」。開口語の出口（greeting.enforceOpener）は先頭の1つしか見ず、
//   banned-phrasing.normalizeShochi（承知しました→かしこまりました）は「行頭どうしの重なり」を落とさない（文中に対象付きがある時だけ落とす）ので、
//   開口語の行が2つ続くと最後まで残った。→ 最後の網: 続く開口語の行（絵文字・！！を除いて同じ語）を1つにまとめる（純関数）。
//   人の手打ちで変わる文は scripts/audit-opener-repeat.ts で確かめる（誤削除0の時だけ出口に入れる）
const OPENER_LINE_RE = /^[ \t　]*(かしこまりました|承知(?:いた|致)?しました|はい|承りました)[😊😌✨]*[！!。]*[ \t　]*$/;

/** 続く同じ開口語だけの行を1つにまとめる（1つ目を残す・間の空行は残さない）。変わらなければ同じ文を返す */
export function collapseRepeatedOpener(text: string | null | undefined): { text: string; collapsed: number } {
  const lines = String(text ?? "").split("\n");
  const out: string[] = []; let collapsed = 0; let lastOpener: string | null = null;
  for (const line of lines) {
    const m = line.match(OPENER_LINE_RE);
    const key = m ? (m[1].startsWith("承知") ? "かしこまりました" : m[1]) : null;
    if (key && lastOpener === key) { collapsed++; continue; }
    if (key) lastOpener = key;
    else if (line.trim()) lastOpener = null; // 本文が来たら区切り（空行は区切りにしない）
    out.push(line);
  }
  return { text: collapsed ? out.join("\n") : String(text ?? ""), collapsed };
}

// ─── 2026-10-20 竹内さん（設計知見 18c6ef71「かしこまりましたの位置」・かしこまりましたの重なりの指摘）──────────────
//   collapseRepeatedOpener は「続く行」の重なりだけを落とす。同じ段の中の「同じ行に2つ」「行頭＋〜との事承知いたしました」は残っていた（見張り 60日）。
//   ①dedupeKashikomarimashita: 同じ段の中で重なった「かしこまりました」を1つに（同じ行に2つ・行まるごと・行頭）。段が違う受けは触らない。
//     文の中の「〜の件かしこまりました」は落とすと文が崩れるので触らない＝落とすのは重なった開口語だけ。戻す: ACK_DEDUPE=off（既定 on）
//   ②placeAckInContentBlock: 挨拶の段（〇〇さんお世話になっております）の直後に付いた受けの行を、空行の後の中身の段の頭へ移す。
//     竹内さんの決定（受けは受けている中身の段の頭）。並べ替え＝文を変えるので既定 off（ACK_BLOCK_PLACE=on で入る）
const ACK_ONLY_LINE_RE = /^[ \t　]*(?:かしこまりました|承知(?:いた|致)?しました)[😊😌✨]*[！!。]*[ \t　]*$/;
// 受けの後が記号・絵文字・空白で区切れている時だけ（「承知しましたが／承知しましたら」の文の途中を削らない）
const ACK_HEAD_RE = /^([ \t　]*)(?:かしこまりました|承知(?:いた|致)?しました)(?:[😊😌✨！!。、]+[ \t　]*|[ \t　]+)(?=\S)/u;
const ACK_ANY_RE = /かしこまりました|承知(?:いた|致)?しました/;

export function ackDedupeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ACK_DEDUPE ?? "").toLowerCase() !== "off";
}
export function ackBlockPlaceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ACK_BLOCK_PLACE ?? "").toLowerCase() === "on";
}

/** 同じ行で受けの言葉が2つ続く（「かしこまりました😊！！かしこまりました😌！！」） */
const ACK_TOKEN = "(?:かしこまりました|承知(?:いた|致)?しました)[😊😌✨]*[！!。]*";
const ADJACENT_ACK_RE = new RegExp(`(${ACK_TOKEN})[ \\t　]*${ACK_TOKEN}`, "u");
/** 行頭の受け＋同じ行の「〜との事・〜で 承知いたしました」（受けが1行に2つ） */
const HEAD_PLUS_TOKUSHO_RE = /^([ \t　]*)(?:かしこまりました|承知(?:いた|致)?しました)(?:[😊😌✨！!。、]+[ \t　]*|[ \t　]+)(?=[^\n]*(?:との事|とのこと|との旨|で)[、,]?\s*(?:承知(?:いた|致)?しました|かしこまりました))/u;

/**
 * 同じ段（空行で区切った塊）の中で重なった開口語の「かしこまりました」を1つにする（変わらなければ同じ文）。
 *   ⚠ 段が違う受けは触らない: 依頼が2つあれば受けはそれぞれの段に置く（竹内さん 18c6ef71・スタッフの手打ちにもある）。
 *   見張り 60日 829番の重なりの型は「同じ行に2つ」「行頭＋同じ行の〜との事承知」。スタッフの送信（1通ずつ）で変わる通は scripts/audit-day-subject.ts で数える
 */
export function dedupeKashikomarimashita(text: string | null | undefined): { text: string; removed: number } {
  const src = String(text ?? "");
  if ((src.match(/かしこまりました|承知(?:いた|致)?しました/g) ?? []).length < 2) return { text: src, removed: 0 };
  const out: string[] = [];
  let seenInBlock = false; let removed = 0;
  for (const raw of src.split("\n")) {
    let line = raw;
    if (!line.trim()) { seenInBlock = false; out.push(line); continue; }
    while (ADJACENT_ACK_RE.test(line)) { line = line.replace(ADJACENT_ACK_RE, "$1"); removed++; }
    if (HEAD_PLUS_TOKUSHO_RE.test(line)) { line = line.replace(HEAD_PLUS_TOKUSHO_RE, "$1"); removed++; }
    if (seenInBlock && ACK_ONLY_LINE_RE.test(line)) { removed++; continue; }
    if (seenInBlock && ACK_HEAD_RE.test(line)) { line = line.replace(ACK_HEAD_RE, "$1"); removed++; }
    if (ACK_ANY_RE.test(line)) seenInBlock = true;
    out.push(line);
  }
  if (!removed) return { text: src, removed: 0 };
  return { text: out.join("\n"), removed };
}

const GREETING_LINE_RE = /お世話になっております[！!。]*[😊😌]*[ \t　]*$/;
const GREETING_WITH_ACK_RE = /^(.*お世話になっております[！!。]*[😊😌]*)[ \t　]*((?:かしこまりました|承知(?:いた|致)?しました)[😊😌✨]*[！!。]*)[ \t　]*$/;
/** 挨拶の段に付いた受けの行を、次の中身の段の頭に移す（挨拶→受け→空行→中身 の形・挨拶と受けが同じ行の形）。変わらなければ同じ文 */
export function placeAckInContentBlock(text: string | null | undefined): { text: string; moved: boolean } {
  const src = String(text ?? "");
  const lines = src.split("\n");
  for (let i = 0; i < Math.min(lines.length, 3); i++) {
    // 形1: 挨拶の行 → 受けだけの行 → 空行 → 中身
    if (GREETING_LINE_RE.test(lines[i]) && lines[i + 1] != null && ACK_ONLY_LINE_RE.test(lines[i + 1]) && lines[i + 2] != null && !lines[i + 2].trim() && lines[i + 3]?.trim()) {
      const ack = lines[i + 1].trim();
      const next = [...lines.slice(0, i + 1), "", ack, ...lines.slice(i + 3)];
      return { text: next.join("\n"), moved: true };
    }
    // 形2: 挨拶と受けが同じ行 → 空行 → 中身
    const m = lines[i].match(GREETING_WITH_ACK_RE);
    if (m && lines[i + 1] != null && !lines[i + 1].trim() && lines[i + 2]?.trim()) {
      const next = [...lines.slice(0, i), m[1], "", m[2], ...lines.slice(i + 2)];
      return { text: next.join("\n"), moved: true };
    }
  }
  return { text: src, moved: false };
}

/** 出口の最後の網（切り替えつき）。重なりを落としてから置き場所を直す */
export function tidyAckForm(text: string, env: Record<string, string | undefined> = process.env): string {
  let t = text;
  if (ackDedupeEnabled(env)) t = dedupeKashikomarimashita(t).text;
  if (ackBlockPlaceEnabled(env)) t = placeAckInContentBlock(t).text;
  return t;
}
