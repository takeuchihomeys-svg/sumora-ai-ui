// scripts/lib/sheet-order.ts — 毎朝の1枚を竹内さんが朝に読む順に並べ直す（純関数・作業員N2・2026-11-23・台帳 #473 の一部・統括役の頼み）
//   先頭: 竹内さんに動いてほしい事（確認事項・未履行の約束）→ 今の質の数と見込み（AIX の番・組・申込までの地図の進み・決めに行く）
//   → 統括の受け持ち・穴（芯の点検・地図の穴・土台の埋まり・直しの候補）→ 作業の細かい行（伸びしろ・点検・試験・方針・次に何をなぜ）。
//   中身は変えない（見出しと、その下の行のまとまりを動かすだけ）。行を書く所（self-improve）は今のまま足してよい＝並びはここで決める。止める SELF_IMPROVE_SHEET_ORDER=off
export type SheetBucket = "owner" | "quality" | "conductor" | "detail";
export const SHEET_BUCKET_JA: Record<SheetBucket, string> = {
  owner: "竹内さんに動いてほしい事（確認事項・まだ果たしていない約束）",
  quality: "今の質の数と見込み（AIX の番・組・申込までの地図の進み・決めに行く）",
  conductor: "統括の受け持ち・穴",
  detail: "作業の細かい行",
};
/** 見出し → まとまり（上から順に当てる） */
export const SHEET_RULES: Array<[RegExp, SheetBucket]> = [
  [/竹内さんへの確認|竹内さんに動いてほしい/, "owner"],
  [/本番の物差し|（主の数）|^### (申込までの地図|AIX の番の一致|決めに行く|返信と AIX の組)|見込みと実測の突き合わせ/, "quality"],
  [/^### 芯: 数ごとの地図/, "quality"],
  [/^### 芯:|地図の穴|土台の埋まり|① 直しの候補|統括の受け持ち/, "conductor"],
];
/** まとまりの外でも、行そのものを「竹内さんに動いてほしい事」に上げる行（まだ果たしていない約束） */
export const OWNER_LINE_RE = /^- 行動台帳の約束|期日超えの約束|まだ果たしていない約束/;

type Section = { head: string | null; body: string[] };
export function bucketOfHead(head: string): SheetBucket {
  for (const [re, b] of SHEET_RULES) if (re.test(head)) return b;
  return "detail";
}

export function orderSheetLines(lines: readonly string[]): string[] {
  const title: string[] = [];
  const secs: Section[] = [];
  let cur: Section | null = null;
  for (const l of lines) {
    if (/^#{2,4} /.test(l)) { cur = { head: l, body: [] }; secs.push(cur); continue; }
    if (cur) cur.body.push(l); else title.push(l);
  }
  const by: Record<SheetBucket, string[]> = { owner: [], quality: [], conductor: [], detail: [] };
  const lifted: string[] = [];
  for (const s of secs) {
    const body = s.body.filter((l) => { if (OWNER_LINE_RE.test(l)) { lifted.push(l); return false; } return true; });
    const content = body.filter((l) => l.trim());
    // 中身の無い大見出し（## 2. 外れ・## 3. 組む）は外す（並べ直すと意味が無い）
    if (/^## /.test(s.head ?? "") && !content.length) continue;
    const b = bucketOfHead(s.head ?? "");
    by[b].push((s.head ?? "").replace(/^## /, "### "), ...body.filter((l, i, a) => l.trim() || (i > 0 && a[i - 1].trim())));
  }
  if (lifted.length) by.owner.unshift("### まだ果たしていない約束", ...lifted);
  const out = [...title];
  for (const b of ["owner", "quality", "conductor", "detail"] as const) {
    if (!by[b].length) continue;
    out.push(`## ${SHEET_BUCKET_JA[b]}`, ...by[b], "");
  }
  return out;
}
