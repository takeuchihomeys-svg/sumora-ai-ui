// scripts/lib/exam-input-drift.ts — 試験の同じ問題・同じ回の LLM の要求が、前の録音とどこで違うかを【見出し】の区切りで分け、
//   違いの出所を4つに分ける（純関数・LLM も DB も使わない）。
//
// 2026-11-05 作業員8（統括役の5つの了承の 1「前の答えを本番の commit ごとに1回だけ作って使い回す」の土台）:
//   11/04〜05 の録音の brain_full 1,429組を見ると、前（main）の子の「下見（入力が前と同じなら呼ばない）」が 47依頼で一度も当たらなかった。
//   違った区切りの上位は、コードの変更ではなく
//     ① 写し・台帳（この番の帳面・行動台帳・使用済み AIX・直近 AIX・約束・物件検索統括・送った物件）: 同じ問題の同じ回でも「物件送付15件→36件」
//        「直近 AIX 10分前 → 0分前・4分前・6分前」のように、他の問題の行が入っている／前の問題の行が消えていない形
//     ② 時計（時間情報の曜日・「N分前」）: 走らせた日の曜日がそのまま入る
//     ③ 本番の DB が育つ（成約した返信例・RAG・AIX の当たりの統計・次打ちマップ）: 学習で毎日変わる
//     ④ コード（指示・JSON の形・竹内さんの決定の注記）
//   だった。①〜③が残る限り、main が進まなくても前の答えは使えない（録音が当たらない）。この関数で毎回の外れを①〜④に分けて数える。
//   KB: a62a4164⑤（録音の使い回し）・e9d2303e（質）。点検表 11（同じ会話を4レーンで取った）と同じ型を①で見る。

export type DriftKind = "ledger" | "clock" | "db" | "code" | "other";

/** 見出し → 出所。見出しは brain-core の【…】の名前（前方一致・部分一致） */
const RULES: Array<{ re: RegExp; kind: DriftKind }> = [
  { re: /確かな事実の帳面|行動台帳|送ったこと・約束したこと|使用済みのAIX|直近AIX|お客様との約束|物件検索統括|すでに送付済みの物件|こちらが送った物件|御見積書 送付済み|期限内|お客様の確認事項の候補|お客様のメモ|待ち合わせ場所|申込までの地図|気持ちの流れ|お客様の今の状況/, kind: "ledger" },
  { re: /時間情報/, kind: "clock" },
  { re: /成約した会話の実際の返信例|関連ナレッジ|あなたの過去の AIX 判断|成約実績・次打ちマップ|成約につながりやすいアクション|過去の会話から/, kind: "db" },
];

export function kindOfHeading(h: string): DriftKind {
  for (const r of RULES) if (r.re.test(h)) return r.kind;
  return "other";
}

/** 本文を【見出し】ごとの塊に分ける（同じ見出しが2回あれば足す）。見出しの前は「(頭)」 */
export function splitSections(body: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of body.split(/(?=【[^】]{1,40}】)/)) {
    const h = (s.match(/^【[^】]{1,40}】/) ?? ["(頭)"])[0];
    m.set(h, (m.get(h) ?? "") + s);
  }
  return m;
}

/** 区切りの中の「N分前・N時間前」と曜日を伏せた形（時計だけの違いを見分ける） */
export function maskClock(s: string): string {
  return s.replace(/\d+(?:分|時間|日)前/g, "<ago>").replace(/（[月火水木金土日]）/g, "（<wd>）");
}

export type DriftResult = {
  same: boolean;
  /** 違った見出し */
  headings: string[];
  /** 出所ごとの違った見出しの数。時計を伏せると同じになる台帳の違いは clock に数える */
  kinds: Record<DriftKind, number>;
  /** 一番重い出所（code ＞ ledger ＞ db ＞ clock ＞ other の順で、1つでもあればそれ） */
  primary: DriftKind | null;
};

const ORDER: DriftKind[] = ["code", "ledger", "db", "clock", "other"];

/**
 * 前と後の要求の本文を比べる。codeHeadings＝この差分のコードが足した・変えた見出し（分かる時だけ。無ければ「other」で受ける）。
 * JSON の形・指示の本文（見出しの無い頭の部分・RULES に無い見出し）の違いは code とみなす（安全側＝作り直す）。
 */
export function classifyDrift(prev: string, next: string, opts: { codeHeadings?: string[] } = {}): DriftResult {
  const kinds: Record<DriftKind, number> = { code: 0, ledger: 0, clock: 0, db: 0, other: 0 };
  if (prev === next) return { same: true, headings: [], kinds, primary: null };
  const A = splitSections(prev), B = splitSections(next);
  const headings: string[] = [];
  for (const h of new Set([...A.keys(), ...B.keys()])) {
    const a = A.get(h), b = B.get(h);
    if (a === b) continue;
    headings.push(h);
    if (opts.codeHeadings?.includes(h)) { kinds.code++; continue; }
    let k = kindOfHeading(h);
    if (k === "ledger" && a != null && b != null && maskClock(a) === maskClock(b)) k = "clock";
    if (k === "other") k = a == null || b == null || h === "(頭)" ? "code" : "other";
    kinds[k]++;
  }
  const primary = ORDER.find((k) => kinds[k] > 0) ?? null;
  return { same: headings.length === 0, headings, kinds, primary };
}

/** たくさんの組のまとめ（出所ごとの組の数・どれか1つでもあった組の数） */
export function tallyDrift(results: DriftResult[]): { pairs: number; same: number; byPrimary: Record<string, number>; anyOf: Record<DriftKind, number>; onlyNoise: number } {
  const byPrimary: Record<string, number> = {}; const anyOf: Record<DriftKind, number> = { code: 0, ledger: 0, clock: 0, db: 0, other: 0 };
  let same = 0, onlyNoise = 0;
  for (const r of results) {
    if (r.same) { same++; continue; }
    byPrimary[r.primary ?? "none"] = (byPrimary[r.primary ?? "none"] ?? 0) + 1;
    for (const k of ORDER) if (r.kinds[k] > 0) anyOf[k]++;
    if (r.kinds.code === 0 && r.kinds.other === 0) onlyNoise++; // コードは同じで、台帳・時計・DB だけ違った＝直せば使い回せた組
  }
  return { pairs: results.length, same, byPrimary, anyOf, onlyNoise };
}
