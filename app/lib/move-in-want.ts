// app/lib/move-in-want.ts（純関数・import なし）
// お客様の入居時期の自由文（property_customers.move_in_time）を「その日までに入りたい日（'YYYY-MM-DD'）」に直す。
// 物件側（listing-terms.ts の moveIn）と compareMoveIn で照らし、入れるのが希望日より 14日を超えて遅い時だけ MOVE_IN_LATE（保留）にする。
//
// 2026-09-25 竹内「敷金礼金と入居時期、組み込みたい」。実物（move_in_time 262行・175種類）の形:
//   「10月」「9月末」「11月頃」「10月1日」「8/1」「2026/8/1」「8月上旬」「10月下旬」「今月半ば」「来月上旬」
//   「4月か5月」「7〜8月」「10月~12月」「5.6.7月」「11.12月」「今年12〜3月」「10月〜3月までには」「来年3月までに」
//   「すぐにでも」「最短」「即日」「至急」「出来るだけ早く」「今年中」「年内」
//   「いつでも」「未定」「物件見つかり次第」「2ヶ月後くらい」「半年以内」「1ヶ月以内」「冬」「秋口」「5月以降」「7月末〜」
// 決まり（読み違いで保留にしない側に倒す）:
//   - 上旬・初旬・頭・初め・前半＝10日／中旬・半ば＝20日／下旬・末・後半・月だけ・頃＝末日／「N日」＝その日
//   - 月が複数（「4月か5月」「7〜8月」「9月前後、余裕あれば12月」）は一番遅い月（遅い方に合わせる＝LATE を出しにくくする）
//   - 年の無い月は、登録日（created_at）の前月より前なら来年（5月登録の「4月」は今年＝過ぎた日・「3月」は来年）。
//     2つ目からは前の月より小さければ翌年（「今年12〜3月」の 3月は来年）。「来年」「今年」「YYYY年」はそのまま
// 2026-09-25 全件監査（scripts/audit-move-in-want.ts・234人）: by 93／過ぎた日 63／決まっていない 35／すぐ 24／目安・季節 12／始まりだけ 7。
//   値ごとに目で読んで読み違い 0（初回は 5月登録の「4月」「4月か5月」を来年と読んでいた → 前月までは今年に直した）。
//   過ぎた日の 63人は 5〜7月登録の「7月」「8月上旬」等＝情報が古いので札を付けない
//   - 即入居・すぐ・最短・至急・早め＝今日（照らす時に 14日の猶予がある）／今月中＝今月末／来月＝来月末／今年中・年内＝12/31
//   - 札を付けない（kind が by・asap 以外）: 目安（「◯ヶ月後くらい」「◯ヶ月以内」「半年以内」）・季節（冬・夏頃・秋口）・
//     始まりだけ（「5月以降」「7月末〜」「4月から」）・決まっていない（未定・いつでも・見つかり次第）・日だけ（「21日16時希望」）・
//     過ぎた日（登録時の「7月」を 9月に照らす＝情報が古い）
//   - 括弧の中（「9~11月頃(9月以降の方が…)」「年内中(12月初旬までには決めたい)」）は読まない（補足で、入居の希望ではない）

export type MoveInWantKind = "by" | "asap" | "after" | "vague" | "none" | "past";
export type MoveInWant = {
  kind: MoveInWantKind;
  /** その日までに入りたい日（kind=by・asap の時だけ） */
  wantBy: string | null;
  /** 画面の短い言い方（「11月上旬まで」「すぐ」「5月以降」） */
  label: string | null;
  raw: string | null;
};

type YMD = { y: number; m: number; d: number };

function jstParts(d: Date | string | undefined): YMD {
  const x = d instanceof Date ? d : d ? new Date(d) : new Date();
  const t = Number.isFinite(x.getTime()) ? x : new Date();
  const j = new Date(t.getTime() + 9 * 3600_000);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate() };
}
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const fmt = (p: YMD) => `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;

const NONE_RE = /未定|まだ(?:決|分|わか|検討)|決まって(?:い)?ない|決めていない|分からない|わからない|いつでも|次第|(?:物件|部屋|ところ|とこ)(?:が|を)?(?:あれば|見つかれば)|部屋があれば/;
const ASAP_RE = /即入居|即日|^即$|即入|今すぐ|すぐ|最短|至急|急ぎ|早(?:く|め|い|ければ)|直近/;
const VAGUE_RE = /[0-9]+\s*(?:ヶ|ヵ|カ|か|ケ|箇)\s*月|半年|[0-9]+\s*週間|春|夏|秋|冬/;

/** 「今月半ば」「来月上旬」「月末」の日（part の語から） */
function dayOf(y: number, m: number, part: string | undefined, day?: number): number {
  if (day != null && day >= 1 && day <= lastDay(y, m)) return day;
  const p = part ?? "";
  if (/上旬|初旬|頭|初め|はじめ|前半/.test(p)) return 10;
  if (/中旬|半ば|なかば/.test(p)) return 20;
  return lastDay(y, m);
}

/**
 * 入居時期の自由文を読む（決定論・投げない）。
 * @param opts.registeredAt 年の無い「7月」を何年と読むかの基準（property_customers.created_at）。無ければ today
 * @param opts.today 過ぎた日の判定と「すぐ」の日（既定は今）
 */
export function parseMoveInWant(raw: string | null | undefined, opts?: { registeredAt?: Date | string | null; today?: Date | string }): MoveInWant {
  const src = String(raw ?? "").trim();
  const out = (kind: MoveInWantKind, wantBy: string | null = null, label: string | null = null): MoveInWant => ({ kind, wantBy, label, raw: src || null });
  if (!src) return out("none");
  const today = jstParts(opts?.today);
  const ref = opts?.registeredAt ? jstParts(opts.registeredAt) : today;
  // 全角→半角・括弧の中を外す・「~ ～ ー － -」を「〜」に（「7月ー8月」「2026年4-6月」）。日付の「2026/8/1」「2024-07-24」は先に読む
  const n = src.normalize("NFKC");
  const iso = n.match(/(20\d{2})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?/);
  let s = n.replace(/[(（][^)）]*[)）]?/g, " ").replace(/\s+/g, " ").trim();
  const finish = (p: YMD, label: string): MoveInWant => {
    const wb = fmt(p);
    if (wb < fmt(today)) return out("past", null, label);
    return out("by", wb, label);
  };
  if (iso) {
    const y = +iso[1], m = +iso[2], d = +iso[3];
    if (m >= 1 && m <= 12 && d >= 1 && d <= lastDay(y, m)) return finish({ y, m, d }, `${m}/${d}まで`);
  }
  s = s.replace(/[~～\-ー－―]/g, "〜");

  // 「今月」「来月」「今年中・年内・年末」（月の数字が無い時）
  const hasMonthNum = /\d{1,2}\s*月|\d{1,2}\s*\/\s*\d{1,2}/.test(s);
  if (!hasMonthNum) {
    const rel = s.match(/(今月|来月|再来月)(?:の)?(上旬|初旬|頭|初め|前半|中旬|半ば|下旬|末|後半|中)?/);
    if (rel) {
      const add = rel[1] === "今月" ? 0 : rel[1] === "来月" ? 1 : 2;
      let y = ref.y, m = ref.m + add;
      if (m > 12) { m -= 12; y += 1; }
      // 「来月半ばから後半」は遅い方（後半）
      const parts = [...s.matchAll(/(上旬|初旬|頭|初め|前半|中旬|半ば|下旬|末|後半)/g)].map((x) => x[1]);
      const part = parts.length ? parts[parts.length - 1] : rel[2];
      return finish({ y, m, d: dayOf(y, m, part) }, `${rel[1]}${part && part !== "中" ? part : ""}`);
    }
    if (/今年中|年内|年末|今年いっぱい/.test(s) && !/来年/.test(s)) return finish({ y: ref.y, m: 12, d: 31 }, "年内");
  }

  // 月の数字（「10月」「5.6.7月」「7〜8月」「10月29日〜11月1日」「8/1」）を文の順に集める
  type Tok = { m: number; y?: number; day?: number; part?: string; pos: number; end: number };
  const toks: Tok[] = [];
  const yearBefore = (pos: number): number | undefined => {
    const head = s.slice(Math.max(0, pos - 8), pos);
    const ym = head.match(/(20\d{2})\s*年\s*$/);
    if (ym) return +ym[1];
    if (/来年\s*(?:の)?\s*$/.test(head)) return ref.y + 1;
    if (/今年\s*(?:の)?\s*$/.test(head)) return ref.y;
    return undefined;
  };
  // 「5.6.7月」「11.12月」「10〜11月」「2026年4〜6月」: 月の前に並ぶ数字も月として拾う
  const reList = /(\d{1,2})((?:\s*[.・、,〜]\s*\d{1,2})*)\s*月(?:\s*(\d{1,2})\s*(?:〜\s*(\d{1,2}))?\s*日)?(?:\s*の?\s*(上旬|初旬|頭|初め|はじめ|前半|中旬|半ば|なかば|下旬|末|後半|中))?/g;
  for (const x of s.matchAll(reList)) {
    const pos = x.index ?? 0;
    // 「2ヶ月」「1、2ヶ月」は月ではない（reList は「\d月」だけ拾うので来ない）。月が 1〜12 でない物は捨てる
    const nums = [x[1], ...(x[2] ? x[2].split(/[.・、,〜]/).map((t) => t.trim()).filter(Boolean) : [])].map((t) => +t);
    if (nums.some((v) => !(v >= 1 && v <= 12))) continue;
    const y0 = yearBefore(pos);
    nums.forEach((m, k) => {
      const last = k === nums.length - 1;
      const day = last && x[3] ? +(x[4] ?? x[3]) : undefined;
      toks.push({ m, y: k === 0 ? y0 : undefined, day, part: last ? x[5] : undefined, pos, end: pos + x[0].length });
    });
  }
  // 「8/1」「10/1」「7/4,5あたり」（年の無い 月/日）
  for (const x of s.matchAll(/(?<![\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?![\d/])/g)) {
    const m = +x[1], d = +x[2];
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) toks.push({ m, day: d, pos: x.index ?? 0, end: (x.index ?? 0) + x[0].length });
  }
  toks.sort((a, b) => a.pos - b.pos);

  if (toks.length > 0) {
    // 年を決める（最初は登録日から・以後は前の月より小さければ翌年）
    let prev: { y: number; m: number } | null = null;
    const dated = toks.map((t) => {
      let y: number;
      if (t.y != null) y = t.y;
      // 登録月の前月までは今年（5月登録の「4月か5月」＝今年＝過ぎた日。listing-terms の年の無い入居時期と同じ線）
      else if (!prev) y = t.m < ref.m - 1 ? ref.y + 1 : ref.y;
      else y = t.m < prev.m ? prev.y + 1 : prev.y;
      prev = { y, m: t.m };
      return { ...t, y };
    });
    const lastTok = dated[dated.length - 1];
    const tail = s.slice(lastTok.end).replace(/頃|ごろ|くらい|ぐらい|位|あたり|辺り|予定|希望|です|！|!|。/g, "").trim();
    // 始まりだけ（「5月以降」「7月末〜」「4月から」）は札を付けない（それより早く入れる物件も困らない・遅い方の線が無い）
    if (/^(?:以降|以後|から|〜)\s*$/.test(tail) || (/^(?:以降|以後)/.test(tail))) {
      return out("after", null, `${lastTok.m}月${lastTok.part ?? ""}以降`);
    }
    // 「9月中旬から下旬」「6月中旬〜下旬」: 後ろの旬がその月の終わり
    const tailPart = tail.match(/^(?:から|〜)\s*(上旬|初旬|中旬|半ば|下旬|末|後半)/);
    if (tailPart) lastTok.part = tailPart[1];
    // 一番遅い日（順に並べた最後＝年を送ってあるので最大）
    let best = dated[0];
    let bestKey = "";
    for (const t of dated) {
      const k = fmt({ y: t.y, m: t.m, d: dayOf(t.y, t.m, t.part, t.day) });
      if (k > bestKey) { bestKey = k; best = t; }
    }
    const d = dayOf(best.y, best.m, best.part, best.day);
    const label = best.day != null ? `${best.m}/${d}まで` : `${best.m}月${best.part && best.part !== "中" ? best.part : ""}まで`;
    return finish({ y: best.y, m: best.m, d }, label);
  }

  // 月の数字が無い
  if (ASAP_RE.test(s)) return out("asap", fmt(today), "すぐ");
  if (NONE_RE.test(s)) return out("none");
  if (VAGUE_RE.test(s)) return out("vague", null, s.slice(0, 12));
  return out("none");
}
