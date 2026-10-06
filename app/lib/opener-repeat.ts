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
