// app/lib/notation-mix.ts
// 漢字とひらがなの混ぜ方をスタッフの実送信に合わせる（純関数・DB 依存なし）。
//
// 2026-09-21 竹内「文の質が上がっていないってことは実際のスタッフが送るような文が
//   生成されていない可能性があるってこと？」
//
// ■ 見つけ方（scripts/audit-draft-vs-staff.ts）
//   下書きと実送信が揃う2,999件で、スタッフが直した1,969件（65.7%）について
//   **述部を消した／足した**で数えたら、1位同士がこれだった:
//     消される1位「内させて頂きます」201回（ご案内させて頂きます）
//     足される1位「せていただきます」262回（探させていただきます）
//   ＝ **同じ意味で表記だけ違う**。述部8字で見ると別物になるので原因が見えなかった。
//
// ■ 実測（scripts/audit-itadaku-notation.ts・直近120日・実送信11,610通／下書き2,984通）
//   ひらがな率（かな / (漢字+かな)）:
//     〜させて頂く / いただく   実送信 32.5%（漢4,481 / かな2,155）  AI  7.4%（漢3,755 / かな299）  **+25.1pt**
//     〜して頂く / いただく     実送信 48.1%（漢41 / かな38）        AI 11.1%（漢24 / かな3）      **+37.0pt**
//     致します / いたします     実送信 22.9%（漢1,137 / かな337）    AI  5.2%（漢791 / かな43）    **+17.7pt**
//     出来る / できる           実送信 22.4%                         AI 33.3%                      -10.8pt
//     何時でも / いつでも       実送信 69.7%                         AI 85.4%                      **-15.7pt**
//     御座います / ございます   実送信 86.5%                         AI 88.7%                      -2.2pt（合っている）
//     下さい / ください         実送信 98.1%                         AI 100.0%                     -1.9pt（合っている）
//   ＝ **AI は「頂く・致します」を漢字に寄せすぎ、「いつでも」をひらがなに寄せすぎ**。
//
// ■ 🔴 監査で止めた（2026-09-21・CLAUDE.md の手順8）— **生成には渡さない**
//   一度 generate-reply と aix/action の userPrompt の最後に率を材料として入れたが、
//   YUMA の本番経路で測ったら「させて頂く」のひらがな率は **0%** のままだった（実送信 32.5%）。
//   そこで「材料の渡し方が悪い」のではなく「**渡せる材料なのか**」を測り直した
//   （scripts/audit-notation-signal.ts・直近120日・スタッフ送信11,614件）:
//
//     ① 1通の中に1回しか出ない  「させて頂く」が2回以上出る通は 31.0%、「致します」は 3.0%。
//        1回しか出ない物に「32.5% でひらがなを混ぜろ」と言っても 0% か 100% にしかならない
//        （設計知見「中間を言葉で指定しても中間には落ちない・振り子になる」）。
//     ② その会話に合わせても当たらない
//        「その会話で過去に使った表記に合わせる」で当たる率 対 何も見ずに多い方に倒した率:
//          させて頂く  70.0% 対 67.5%   ／ 致します  76.7% 対 **77.2%**
//          いつでも    63.4% 対 **69.7%** ／ 出来る    75.0% 対 **77.6%**
//        ＝ 3組は会話に合わせる方が**悪い**。会話ごとに揃っているのは 10.4〜36.3% だけで、
//        1通の中ですら 15.5〜23.6% が混在している。
//     ③ ＝ **1通ごとにどちらを選ぶかを決める手がかりが実データに無い**。スタッフ自身がばらばら。
//
//   そして向きも見直した: 漢字が多数派（67.5%）なので、**AI が毎回漢字を選ぶのは1通ごとに見れば正しい**。
//   ずれているのは「ばらつきが無い」ことだけで、1通の質は下がっていない。
//   効かない材料をプロンプトに残すと、トークンを食って他の指示を薄める。だから配線しない。
//
//   残すのは**測る側だけ**（checkNotationMix / NOTATION_PAIRS）。
//   将来スタッフ個人ごとの癖など新しい手がかりが見つかったら、その時に材料に戻す。

export type NotationPair = {
  /** 人が読む名前 */
  name: string;
  /** 漢字の書き方 */
  kanji: RegExp;
  /** ひらがなの書き方 */
  kana: RegExp;
  /** 実送信のひらがな率（%） */
  sentKanaPct: number;
  /** AI の下書きのひらがな率（%）。材料に出して「ずれている」ことを見せる */
  draftKanaPct: number;
  /** 実送信の母数（漢字＋かな） */
  sample: number;
};

/** ⚠ 監査（scripts/audit-itadaku-notation.ts の PAIRS）と同じ正規表現にすること（四者同名） */
export const NOTATION_PAIRS: NotationPair[] = [
  { name: "させて頂く／させていただく", kanji: /させて頂(?:き|く|け)/g, kana: /させていただ(?:き|く|け)/g, sentKanaPct: 32.5, draftKanaPct: 7.4, sample: 6636 },
  { name: "致します／いたします", kanji: /致します/g, kana: /いたします/g, sentKanaPct: 22.9, draftKanaPct: 5.2, sample: 1474 },
  { name: "何時でも／いつでも", kanji: /何時でも/g, kana: /いつでも/g, sentKanaPct: 69.7, draftKanaPct: 85.4, sample: 218 },
  { name: "出来る／できる", kanji: /出来(?:る|ます|ました)/g, kana: /でき(?:る|ます|ました)/g, sentKanaPct: 22.4, draftKanaPct: 33.3, sample: 3301 },
];

/** ずれがこれ以上なら「ずれている」と見なす（pt）。監査の表示にだけ使う */
export const NOTATION_GAP_PT = 10;

/** 実送信との差が大きい組（監査の表示用。⚠ 生成には渡さない — ヘッダの「監査で止めた」を読むこと） */
export function notationGaps(): NotationPair[] {
  return NOTATION_PAIRS.filter((p) => Math.abs(p.sentKanaPct - p.draftKanaPct) >= NOTATION_GAP_PT);
}

export type NotationCount = { name: string; kanji: number; kana: number; kanaPct: number; sentKanaPct: number; gapPt: number };

/** 出来上がった文の表記を数える（検査だけ・本文は書き換えない） */
export function checkNotationMix(text: string | null | undefined): NotationCount[] {
  const t = text ?? "";
  const out: NotationCount[] = [];
  for (const p of NOTATION_PAIRS) {
    const k = (t.match(p.kanji) ?? []).length;
    const h = (t.match(p.kana) ?? []).length;
    if (k + h === 0) continue;
    const kanaPct = (h / (k + h)) * 100;
    out.push({ name: p.name, kanji: k, kana: h, kanaPct, sentKanaPct: p.sentKanaPct, gapPt: kanaPct - p.sentKanaPct });
  }
  return out;
}
