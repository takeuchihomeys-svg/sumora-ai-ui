// app/lib/recommend-viewable.ts
// AIX【物件オススメ】の物件が「今ご内覧頂けるか」と、退去予定を伝える一文を、1通目と2通目が同じ関数・同じ材料で決める（純関数・DB 依存なし）。
//
// 2026-09-30 竹内さんの YUMA の実送信（資料が「現況居住中 入居可能時期2026年11月中旬」の2件＝レオンコンフォート梅田北 703・レオパレス天満 107）:
//   1通目（aix/action）: 「…お気に召されましたらご都合よろしいお日にちにお部屋ご案内させて頂きます😊！！」（退去予定に触れず内覧の誘導）
//   2通目（aix-template-generate）: 「退去予定のお部屋となり、2026年11月中旬が最短での入居可能時期となります！！お気に召されましたらお申込し…」
//   ＝1通目と2通目が食い違った。原因: 1通目の締めを決める notViewable がブレインの判断（会話全体）だけで、今回の物件の資料の現況を見ていなかった。
//     2通目は「1通目の本文の退去予定日 → 資料の現況 → ブレイン」の順で見ていた（判定が2か所に分かれていた）。
//   → ここに1本化。順番: ①本文（1通目・スタッフの入力）に退去予定日がある → ②売上サポの行の資料の現況 → ③ブレインの判断（会話全体）
//
// ■ 退去予定を伝える一文は創作しない（実送信・スタッフの文 13,152通・YUMA 除く・退去予定/居住中/入居中を含む 337通で数えた）
//   「◯月◯日退去予定のため、◯月◯日以降ご内覧可能となります！！」型 … 68通（最多）→ 退去日が分かる時
//   「退去予定のお部屋となり／で」… 104通 ／ 「◯月下旬ごろ（に）ご入居可能となります」型（旬・頃＋入居可能）… 27通
//     実物: 「こちら11/5日退去予定のお部屋で11月中旬ごろにご入居可能となります！！」「7月末退去予定、8月下旬ご入居可能なお部屋となります！！」
//   → 退去日が無く入居可能の時期だけある時: 「退去予定のお部屋となり、11月中旬ごろご入居可能となります！！」
//   「最短での入居可能時期となります」… 1通だけ（前の版が2通目に渡していた言い方）→ やめる。「居住中」0通・「入居中」5通 → お客様への言い方は「退去予定」。
//   年（2026年）は書かない（実送信の退去予定の文に年は無い）。
//
// ■ 2026-10-01 竹内さん「これ退去日分からない場合はスタッフ確認していれてるので、入居可能日はいれない」
//   資料に退去日が無く「居住中・入居可能時期11月中旬」だけの時、前の版は「退去予定のお部屋となり、11月中旬ごろご入居可能となります！！」を入れていた。
//   退去日が分からない時の入居可能日（時期）はスタッフが管理会社に確認して入れる物 → 文には入れない。退去予定であることを伝える一文だけ:
//   「退去予定のお部屋となります！！」（スタッフの文 13,152通で「退去予定のお部屋となります！」30通・うち is_aix_generated でない 20通。
//    実物は「6月末退去予定のお部屋となります！！」のように退去の時期が前に付く形が多いが、退去の時期も資料に無いので付けない＝作らない）
//   退去日が資料にある時の「10月17日退去予定のため、10月18日以降ご内覧可能となります！！」は今まで通り。
//   moveInWhen は読むだけ（文に入れない。出口 tidyVacatingAndClosing が前の版の一文を今の一文に戻す時の目印）

import { readPropertyStateFromText } from "./property-send-state";

/** property_pickups.terms のうち使う所（ゆるい型） */
export type ViewableMaterialRow = {
  terms?: {
    moveIn?: { kind?: string | null; current?: string | null; availableFrom?: string | null; date?: string | null; part?: string | null } | null;
    evidence?: { moveIn?: string | null } | null;
  } | null;
};

export type MaterialViewable = {
  /** まだご内覧頂けない（退去予定・居住中）。資料から分からなければ null */
  notViewable: boolean | null;
  /** 退去予定日（「10月17日」）。資料に無ければ null */
  vacancyDate: string | null;
  /** ご内覧可能日（「10月18日」）。退去予定日がある時だけ */
  viewableFrom: string | null;
  /** 入居可能の時期（「11月中旬」「11月11日」）。資料に無ければ null。⚠ 文には入れない（2026-10-01 竹内: 退去日が分からない時の入居可能日はスタッフが確認して入れる） */
  moveInWhen: string | null;
  /** 退去予定を伝える一文（実送信の形）。空室・分からない時は null */
  line: string | null;
};

const NONE: MaterialViewable = { notViewable: null, vacancyDate: null, viewableFrom: null, moveInWhen: null, line: null };
const half = (s: string) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 入居可能の時期を実送信の書き方に（年は書かない）。「2026-11」＋「中旬」→「11月中旬」／「2026-11-11」→「11月11日」 */
function moveInWhenOf(mi: NonNullable<NonNullable<ViewableMaterialRow["terms"]>["moveIn"]>): string | null {
  if (mi.kind !== "date") return null;
  const ym = String(mi.date ?? "").match(/^\d{4}-(\d{1,2})$/);
  if (ym && mi.part && /^(?:上旬|中旬|下旬|末)$/.test(mi.part)) return `${Number(ym[1])}月${mi.part}`;
  const ymd = String(mi.availableFrom ?? "").match(/^\d{4}-(\d{1,2})-(\d{1,2})$/);
  if (ymd && !mi.part) return `${Number(ymd[1])}月${Number(ymd[2])}日`;
  return null;
}

/**
 * 売上サポの行（資料の現況）から、今ご内覧頂けるかと退去予定の一文を読む。
 * ・現況 空き → 内覧できる（一文なし）
 * ・資料に退去予定日がある（リアプロ「退去予定(10/17)/相談」）→ その日付で決める（もう過ぎていれば内覧できる）
 * ・現況 居住中／退去予定で日付なし → まだ内覧できない。入居可能の時期が資料にあれば一文に入れる
 * ・「居住中なのに即入居可」のように食い違う資料・建築中・読めない → null（ここでは決めない＝ブレインの判断に任せる）
 */
export function readMaterialViewable(row: ViewableMaterialRow | null | undefined, nowMs: number = Date.now()): MaterialViewable {
  const mi = row?.terms?.moveIn ?? null;
  const ev = half(String(row?.terms?.evidence?.moveIn ?? ""));
  const cur = mi?.current ?? null;
  if (!mi && !ev) return NONE;
  if (cur === "vacant") return { ...NONE, notViewable: false };
  if (cur !== "leaving" && cur !== "occupied") return NONE;
  const vd = ev.match(/退去予定\s*[（(]\s*(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?\s*[）)]/);
  if (vd) {
    const st = readPropertyStateFromText(`${Number(vd[1])}月${Number(vd[2])}日退去予定`, nowMs);
    if (st.vacancyDate && st.viewableFrom) {
      return {
        notViewable: st.notViewable, vacancyDate: st.vacancyDate, viewableFrom: st.viewableFrom, moveInWhen: null,
        line: st.notViewable ? `${st.vacancyDate}退去予定のため、${st.viewableFrom}以降ご内覧可能となります！！` : null,
      };
    }
  }
  if (mi?.kind === "immediate") return NONE; // 居住中なのに即入居可＝資料が食い違う
  const when = mi ? moveInWhenOf(mi) : null;
  // 2026-10-01: 退去日が分からない時は入居可能日（時期）を文に入れない（スタッフが確認して入れる）→ 時期の有無に関わらず同じ一文
  return { notViewable: true, vacancyDate: null, viewableFrom: null, moveInWhen: when, line: VACATING_NO_DATE_LINE };
}

/** 退去日が資料に無い時の、退去予定を伝える一文（入居可能日・時期は入れない） */
export const VACATING_NO_DATE_LINE = "退去予定のお部屋となります！！";

export type RecommendViewable = {
  notViewable: boolean;
  viewableFrom: string | null;
  /** 退去予定を伝える一文（資料から作れた時だけ。本文・ブレインが出どころの時は null＝本文に既にある／日付はブレインの viewableFrom） */
  line: string | null;
  source: "text" | "material" | "brain";
  /** 資料の入居可能の時期（文には入れない・出口の目印だけ）。資料から決めた時だけ */
  moveInWhen?: string | null;
};

/**
 * 物件オススメの物件が今ご内覧頂けるか（1通目・2通目が同じこの関数を読む）。
 *   ① text（2通目なら1通目の本文・1通目ならスタッフが入れた退去予定日）に退去予定日がある → その日付
 *   ② 売上サポの行の資料の現況
 *   ③ ブレインの判断（会話全体の物＝別の物件の事がある）
 */
export function resolveRecommendViewable(i: {
  text?: string | null;
  material?: ViewableMaterialRow | null;
  brain: { notViewable: boolean; viewableFrom?: string | null };
  nowMs?: number;
}): RecommendViewable {
  const now = i.nowMs ?? Date.now();
  const t = readPropertyStateFromText(i.text ?? "", now);
  if (t.vacancyDate) return { notViewable: t.notViewable, viewableFrom: t.viewableFrom, line: null, source: "text" };
  const m = readMaterialViewable(i.material, now);
  if (m.notViewable !== null) return { notViewable: m.notViewable, viewableFrom: m.viewableFrom, line: m.notViewable ? m.line : null, source: "material", moveInWhen: m.notViewable ? m.moveInWhen : null };
  return { notViewable: i.brain.notViewable, viewableFrom: i.brain.viewableFrom ?? null, line: null, source: "brain" };
}

/** 本文が退去予定に触れているか（退去予定・退去後・退去の為・ご退去） */
const VACATING_MENTION_RE = /退去(?:予定|後|の為|のため|済|日)|ご退去/;

/** 本文が退去予定に触れているか */
export function mentionsVacating(text: string | null | undefined): boolean {
  return VACATING_MENTION_RE.test(String(text ?? ""));
}

/** 生成に渡す一文（資料から退去予定と分かった時だけ。無ければ空） */
export function buildVacatingLineNote(v: RecommendViewable, o: { closingInFirst?: boolean } = {}): string {
  if (!v.notViewable || !v.line) return "";
  return [
    "【このお部屋は退去予定（資料の現況から・まだご内覧頂けない）】",
    `・退去予定を伝える一文はこのまま書く: 「${v.line}」（言い回し・日付を変えない。年や「居住中」「入居中」は書かない）`,
    // 2026-10-01 竹内「退去日分からない場合はスタッフ確認していれてるので、入居可能日はいれない」
    ...(v.viewableFrom ? [] : ["・入居可能日・入居可能の時期（「11月中旬ごろご入居可能」等）は書かない（退去日が分からないお部屋は、スタッフが管理会社に確認して入れる）"]),
    o.closingInFirst
      // 2026-10-01 竹内「2通目を送らないと決めた時だけ、1通目に締めを付ける」
      ? "・この一文は本文の最後の段落に1回だけ置き、その次の段落に締めの1文（下の【この通の締め】の形）を置く。内覧の誘導（ご都合よろしいお日にちにご案内）は書かない。「即入居可能」も書かない"
      : "・この一文は最後の段落に1回だけ（2026-10-01: 1通目は締めを書かず、この一文で終える）。内覧の誘導（ご都合よろしいお日にちにご案内）は書かない。「即入居可能」も書かない",
  ].join("\n");
}

const paragraphsOf = (t: string) => t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
const CLOSING_ONLY_RE = /^(?:[^\n]{0,20}お気に召(?:され|し)(?:まし)?たら?[^\n]{0,70}|お手隙の際に[^\n]{0,24})$/;

/**
 * 出口（足すだけ）: 資料から退去予定と分かっているのに、本文が退去予定に1度も触れていない → 決まった一文を締めの直前に入れる。
 * 本文が既に退去予定に触れていれば何もしない（消さない・書き換えない）。line が無ければ何もしない。
 */
export function ensureVacatingLine(text: string, v: RecommendViewable): { text: string; added: boolean } {
  const src = String(text ?? "");
  if (!v.notViewable || !v.line || !src.trim() || VACATING_MENTION_RE.test(src)) return { text: src, added: false };
  const paras = paragraphsOf(src);
  const last = paras[paras.length - 1] ?? "";
  if (paras.length >= 2 && CLOSING_ONLY_RE.test(last)) paras.splice(paras.length - 1, 0, v.line);
  else paras.push(v.line);
  return { text: paras.join("\n\n"), added: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 退去予定の一文と締めの置き方をそろえる（出口・文は消さない）
// ─────────────────────────────────────────────────────────────────────────────

const SENTENCE_RE = /[^。！!？?\n]+[。！!？?]*(?:\p{Extended_Pictographic}\uFE0F?)*[！!]*/gu;
const CLOSING_SENTENCE_RE = /^(?:[^、。！\n]{0,12}さん)?(?:お気に召(?:され|し)(?:まし)?たら?|お手隙の際に)/;
/** 一文を比べる形（「ごろ」「に」・句読点・絵文字・空白の違いを無視） */
const looseKey = (s: string) => s.replace(/\p{Extended_Pictographic}|\uFE0F/gu, "").replace(/ごろ|頃|[、。！!\s　]|に(?=ご入居)|より|から/g, "");

/**
 * 出口: ①モデルが退去予定の一文を少しだけ変えて書いた時（「11月中旬ご入居可能」＝「ごろ」抜け等）、決まった一文の字に戻す
 *       ②退去予定の文と同じ行に締めの文を続けて書いた時、締めの文を次の段落に分ける（改行を足すだけ・文は消さない）
 *   2026-10-01 YUMA のローカル生成（1通目）: 「退去予定のお部屋となり、11月中旬ご入居可能となります！！お気に召されましたらお申込しお部屋抑えさせて頂きます😊！！」
 *   ①は「ごろ・に・句読点・絵文字」を除いて同じ文だけが対象（別の内容の退去予定の文は触らない）。
 */
export function tidyVacatingAndClosing(text: string, v: RecommendViewable | null | undefined): { text: string; applied: string[] } {
  const src = String(text ?? "");
  if (!src.trim()) return { text: src, applied: [] };
  const applied: string[] = [];
  const target = v?.notViewable && v.line ? looseKey(v.line) : null;
  // 2026-10-01 竹内「退去日分からない場合は入居可能日はいれない」: 前の版が渡していた一文（資料の時期入り）を書いた時は、今の一文に戻す。
  //   当てるのは「退去予定のお部屋となり（で）、{資料の時期}ごろご入居可能となります！！」の形だけ（年・ごろ・に・句読点の違いは無視）＝別の内容の文は触らない
  const oldKeys = new Set<string>();
  if (v?.notViewable && v.line && !v.viewableFrom && v.moveInWhen) {
    for (const head of ["退去予定のお部屋となり、", "退去予定のお部屋で"]) {
      for (const tail of ["ごろご入居可能となります！！", "ご入居可能となります！！", "が最短での入居可能時期となります！！"]) oldKeys.add(looseKey(`${head}${v.moveInWhen}${tail}`));
    }
  }
  const oldKeyOf = (t: string) => looseKey(t.replace(/\d{4}年(?=\d{1,2}月)/g, ""));
  const paras = src.split(/\n\s*\n/);
  const outParas: string[] = [];
  for (const para of paras) {
    const lines = para.split("\n");
    const last = lines[lines.length - 1] ?? "";
    const sents = last.match(SENTENCE_RE)?.map((s) => s.trim()).filter(Boolean) ?? [];
    let tail: string | null = null;
    if (sents.length >= 2 && CLOSING_SENTENCE_RE.test(sents[sents.length - 1]) && sents.join("").replace(/\s+/g, "").length === last.replace(/\s+/g, "").length
      // 手前の文も締めの文（「お気に召されましたら…ご案内させて頂きます！！お手隙の際にご査収ください！」）なら分けない（実送信にある形）
      && !sents.slice(0, -1).some((s) => CLOSING_SENTENCE_RE.test(s))) {
      tail = sents.pop()!;
      lines[lines.length - 1] = sents.join("");
      applied.push("closing_split");
    }
    let body = lines.join("\n");
    if (target && v?.line) {
      const line = v.line;
      body = body.replace(SENTENCE_RE, (s) => {
        const t = s.trim();
        if (t !== line && looseKey(t) === target) { applied.push("vacating_line_exact"); return s.replace(t, line); }
        if (oldKeys.size && oldKeys.has(oldKeyOf(t))) { applied.push("vacating_line_no_move_in"); return s.replace(t, line); }
        return s;
      });
    }
    outParas.push(body);
    if (tail) outParas.push(tail);
  }
  return applied.length ? { text: outParas.join("\n\n"), applied } : { text: src, applied: [] };
}
