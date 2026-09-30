// app/lib/walk-minutes-text.ts — お客様の文の「駅から徒歩 N 分以内」を決定論で読む（純関数・DB も fetch も無し）
//
// 2026-09-30 YUMA「これからは駅10分以内でお願いします」:
//   ブレインは「条件そのものを変える」（permanent・text_permanent_future「これからは」）と決めたのに、登録の徒歩（walk_minutes）は 15 のままだった。
//   原因: 登録を書く P4（line-webhook-text extractConditionsFromCasualReply）の入口の語彙が「駅…徒歩」の形だけで、
//   「駅10分以内」「徒歩10分以内」「駅から5分以内」に当たらず、スタッフの直前の文も聞き取りの文でなかったので P4 が始まらなかった
//   （ブレインの側には登録を書く道が無い＝書くのは P4・ブレインの橋・条件ブレインで、橋は follow の時に数字の列へ触らない）。
//   直し: 家賃（rent-raise.ts）・帖・初期費用と同じく、徒歩も決定論で拾い、P4 の入口を開けて、Haiku が返さなかった時だけこの値で埋める。
//
// 読む形（上限を言い切っている時だけ）:
//   「駅10分以内」「駅から5分以内」「駅より徒歩7分以内」「最寄り駅まで徒歩10分以内」「徒歩10分以内」「歩いて5分圏内」「駅徒歩10分まで」
// 読まない形:
//   ・通勤（目的の駅まで電車で N 分）: 「梅田駅まで30分以内」「なんばまで電車で20分」「職場まで30分以内」→ commute_station / commute_minutes の話（P4 の Haiku が読む）
//   ・上限でない: 「徒歩5分の物件よかったです」「駅徒歩3分と書いてありました」「徒歩10分以上かかるのは…」（以上は上限でない）
//   ・駅名の付いた駅: 「梅田駅10分以内」（駅までの電車の時間とも徒歩とも読める）→ 読まない（迷ったら書かない）
//   ・自転車・バス・車: 「自転車で10分以内」「バス10分以内」
//   物件の問い合わせの文（「この物件は駅から何分ですか」）は入口の見分け（condition-source-gate）が先に外す

const nfkc = (s: string | null | undefined) => String(s ?? "").normalize("NFKC");

const LIMIT = "(?:以内|圏内|以下|まで|未満)";
// 「駅」の前: 文の頭・助詞・読点・「最寄り（の）」だけ（駅名の付いた「梅田駅」「なんば駅」は読まない）
const STATION_HEAD = "(?:^|[はをでもがに、。,.\\s!！?？]|最寄り?の?|最寄)";
const RES: ReadonlyArray<RegExp> = [
  // 駅（から／より／まで）徒歩 N 分以内・最寄り駅まで歩いて N 分以内
  new RegExp(`${STATION_HEAD}駅(?:から|より|まで)?\\s?(?:徒歩|歩いて|歩きで)\\s?(?:で)?\\s?(\\d{1,2})\\s?分\\s?${LIMIT}`),
  // 駅（から／より）N 分以内（「駅まで N 分」は通勤とも読めるので徒歩の語が要る＝上の形だけ）
  new RegExp(`${STATION_HEAD}駅(?:から|より)?\\s?(\\d{1,2})\\s?分\\s?${LIMIT}`),
  // 徒歩 N 分以内・歩いて N 分圏内（駅の語が無くても徒歩の上限）
  /(?:徒歩|歩いて|歩きで)\s?(?:で)?\s?(\d{1,2})\s?分\s?(?:以内|圏内|以下|まで|未満)/,
];
// 駅でない場所からの徒歩（実物 2026-09-30 監査: 「ミナミから徒歩40分圏内の場所にして欲しい」「ミナミ周辺(徒歩15分圏内)」）は
//   駅までの徒歩（walk_minutes）ではなく場所の広さの話 → 読まない（エリアの読みは P4 の Haiku・resolve-area の仕事）
const AREA_ORIGIN_RE = /(?:[^駅\s]|^)(?:から|より)\s?(?:徒歩|歩いて)|(?:周辺|付近|近辺|あたり|辺り|エリア)\s?[(（]?\s?(?:徒歩|歩いて)/;
// 通勤・他の乗り物の節は読まない
const NOT_WALK_RE = /電車|乗り換え|乗換|通勤|通学|職場|会社|学校|大学|自転車|チャリ|バス(?!・?トイレ)|車で|ドアtoドア|ドアツードア/i;

/**
 * 文の「駅から徒歩 N 分以内」の N（1〜60）。読めなければ null。節（。！？改行・読点）ごとに見て、通勤・他の乗り物の節は飛ばす。
 * 2つ以上あれば最初の節の値（「徒歩10分以内、できれば5分以内」→ 10＝言い切った上限）
 */
export function walkMinutesInText(text: string | null | undefined): number | null {
  const t = nfkc(text);
  if (!t.trim()) return null;
  for (const clause of t.split(/[。！!？?\n]+/)) {
    const c = clause.trim();
    if (!c) continue;
    // 読点で分けた小さい節ごとに乗り物の語を見る（「梅田まで電車で20分、駅から徒歩10分以内」の後ろは読む）
    for (const seg of c.split(/[、,]/)) {
      const s = seg.trim();
      if (!s || NOT_WALK_RE.test(s)) continue;
      for (let i = 0; i < RES.length; i++) {
        const m = s.match(RES[i]);
        if (!m) continue;
        // 駅の語の無い形（徒歩 N 分以内）は、駅でない場所からの徒歩なら読まない
        if (i === 2 && AREA_ORIGIN_RE.test(s)) continue;
        const n = Number(m[1]);
        if (Number.isInteger(n) && n >= 1 && n <= 60) return n;
      }
    }
  }
  return null;
}
