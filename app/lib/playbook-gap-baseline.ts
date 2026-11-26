// app/lib/playbook-gap-baseline.ts — 手順書の「抜け」（gaps）を基準と比べる（純関数・2026-11-27）
//
// 竹内さん「手順書ぬけのないように」「抜けのない仕組みもちゃんと作って強化する」。
//   手順書の gaps（抜けの一覧）は、録画や点検の数で文字（件数・欄名）が毎回変わる。
//   そこで「文の型」（数字と（…）の中身を外した形）で比べ、基準（memory/playbook_gaps_baseline.json）に
//   無い新しい抜けだけを「増えた」と出す。直すと「消えた」と出る。
//   ⚠ 基準は「受け入れた抜け」の一覧。増えたら、直すか・理由を書いて基準に加える（竹内さんの確認つき）。

/** 抜けの文を比べる形（件数・（…）の中身・前後の空白を外す。ネストした括弧も内側から順に外す） */
export function gapKey(text: string): string {
  let s = String(text ?? "");
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/（[^（）]*）/g, "").replace(/\([^()]*\)/g, "");
  }
  return s
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

export type GapDiff = {
  /** 基準に無い新しい抜け（文は今のまま・出す時に使う） */
  added: string[];
  /** 基準にあったが今は無い抜け（直った・消えた） */
  removed: string[];
  /** 基準どおりの抜けの数 */
  kept: number;
};

/** 今の抜け（current）と基準（baseline・型の一覧）を比べる */
export function diffGaps(current: ReadonlyArray<string>, baseline: ReadonlyArray<string>): GapDiff {
  const base = new Set(baseline.map(gapKey));
  const cur = new Map<string, string>();
  for (const t of current) {
    const k = gapKey(t);
    if (!cur.has(k)) cur.set(k, t);
  }
  const added: string[] = [];
  let kept = 0;
  for (const [k, t] of cur) {
    if (base.has(k)) kept++;
    else added.push(t);
  }
  const removed = [...base].filter((k) => !cur.has(k));
  return { added, removed, kept };
}

/** 基準の形（memory/playbook_gaps_baseline.json） */
export type GapBaseline = {
  at: string;
  note: string;
  /** サイトごとに受け入れた抜けの型（gapKey の形） */
  sites: Record<string, string[]>;
};
