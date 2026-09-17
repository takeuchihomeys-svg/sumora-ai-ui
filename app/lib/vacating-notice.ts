// app/lib/vacating-notice.ts
// 退去予定のお部屋の伝え方（AIX【物件確認した】ほか）。純関数・DB 依存なし。
//
// 2026-09-17 竹内「変に割引できる金額少ないや、費用かかる等いれないし、退去予定ともっと分かりやすくいれて、
//   入居ちゃんと出来るようにする。生成された文は文が分かりにくいし変な部分が出てお客さんからしたら意味が分からない」
//
// AI 生成（AIX 物件確認した・会話を合わせる）:
//   「お送りいただきましたジュネスニッコー1003号室、**現在募集中でご入居可能なお部屋**となっております！！／
//     初期費用の御見積書同封させて頂きました😊！！／
//     こちら9月27日に退去予定のお部屋となり、**割引出来る金額が少なく礎金もかかりますので初期費用はかなりかかってしまう形**となります！！」
// 実送信（竹内さん）:
//   「お送りいただきましたジュネスニッコー1003号室、**現在退去予定で募集中**となっております！！／
//     初期費用の御見積書同封させて頂きました😊！！／
//     こちら9月27日に退去予定のお部屋となりますので**9月28日以降ご内覧可能**となります！！」
//
// 実データ（365日・スタッフ実送信）:
//   「退去予定」を含む通 277件のうち
//     ・費用のマイナスの説明（割引できる金額が少ない／費用がかかってしまう／敷金も礎金もかかる）… **0件**
//     ・退去日の翌日を内覧解禁日として伝えている通 … 67件。日付が具体的な通は**例外なく翌日**
//       （9月27日→9月28日／8月31日→9月1日／9月30日→10月1日／8月末→9月1日／8月下旬→9月1日）
//   言い回しは「◯月◯日退去予定のため、◯月◯日以降にご内覧可能です！！」が 51件で最多
//   （「〜となりますので◯月◯日以降ご内覧可能」4件・「〜の為」2件）。
//   ＝退去予定の通で伝えるべきは「いつから見られるか」であって、初期費用がいくらかかるかではない。

/** 全角数字→半角 */
function toHalfWidth(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 年の記載が無い「9月27日」に年を補う（12月に「1月末」＝翌年、1月に「12月末」＝前年） */
function resolveYear(month1: number, nowMs: number): number {
  const jst = new Date(nowMs + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const diff = month1 - (jst.getUTCMonth() + 1);
  if (diff <= -6) return y + 1;
  if (diff >= 7) return y - 1;
  return y;
}

/**
 * 退去予定日 → 内覧解禁日（＝退去日の翌日）の表記。読めなければ null。
 * 「9月27日」→「9月28日」／「9月末」「9月下旬」→「10月1日」／「9月中旬」→「9月21日」／「9月上旬」→「9月11日」
 */
export function viewableFromVacancyDate(vacDateRaw: string, nowMs: number = Date.now()): string | null {
  const raw = toHalfWidth((vacDateRaw ?? "").trim());
  if (!raw) return null;
  const s = raw.replace(/^\d{4}年/, "");
  const mm = s.match(/(\d{1,2})月/);
  if (!mm) return null;
  const month = Number(mm[1]);
  if (month < 1 || month > 12) return null;
  const yearMatch = raw.match(/(\d{4})年/);
  const year = yearMatch ? Number(yearMatch[1]) : resolveYear(month, nowMs);
  const dm = s.match(/(\d{1,2})日/);
  let base: Date;
  if (dm) {
    const day = Number(dm[1]);
    if (day < 1 || day > 31) return null;
    base = new Date(Date.UTC(year, month - 1, day));
    if (base.getUTCMonth() !== month - 1) return null; // 2月30日 等の存在しない日
  } else if (/末|下旬/.test(s)) {
    base = new Date(Date.UTC(year, month, 0)); // その月の末日
  } else if (/中旬/.test(s)) {
    base = new Date(Date.UTC(year, month - 1, 20));
  } else if (/初旬|上旬/.test(s)) {
    base = new Date(Date.UTC(year, month - 1, 10));
  } else {
    return null;
  }
  const next = new Date(base.getTime() + 24 * 60 * 60 * 1000);
  return `${next.getUTCMonth() + 1}月${next.getUTCDate()}日`;
}

/** 表示用の退去日ラベル（年号を外して半角に揃える） */
export function vacancyDateLabel(vacDateRaw: string): string {
  return toHalfWidth((vacDateRaw ?? "").trim()).replace(/^\d{4}年/, "");
}

/** 実送信で最多の言い回し（51件）。読めない日付なら null */
export function vacatingViewableSentence(vacDateRaw: string, nowMs: number = Date.now()): string | null {
  const from = viewableFromVacancyDate(vacDateRaw, nowMs);
  if (!from) return null;
  return `${vacancyDateLabel(vacDateRaw)}退去予定のため、${from}以降にご内覧可能です！！`;
}

/**
 * 費用のマイナスの説明（実送信0件）。
 * 「最大限割引しました初期費用の御見積書」「敷金礼金なしのため初期費用をかなり抑えてご入居頂けます」
 * のような**プラスの**費用の話は残す＝「少ない」「かかってしまう」「高くなる」の向きが付いている時だけ落とす。
 */
const NEGATIVE_COST_RE =
  /割引[^\n。！!]{0,10}(?:金額|額)[^\n。！!]{0,8}少な|割引[^\n。！!]{0,8}(?:出来ません|できません|難しく|少なく)|(?:初期)?費用[^\n。！!]{0,12}かかってしま|(?:敷金|礼金|礎金|保証金|仲介手数料)[^\n。！!]{0,8}(?:も|が)かかり|費用[^\n。！!]{0,8}(?:高く|多く)(?:なって|なり|かかって)|(?:初期)?費用[^\n。！!]{0,8}(?:割高|高め|高額)/;

/**
 * 退去前なのに「今すぐ入居できる」と読める言い回し（退去予定の物件では誤り）。
 * 述部の終わりまで（読点・句点・！・行末まで）をまとめて置き換える＝途中で切って壊さない。
 */
const WRONG_READY_RE =
  /(?:現在)?募集中で[^\n、。！!]{0,8}ご?入居(?:可能|頂ける|いただける|出来る)[^\n、。！!]*/;
/** 実送信（竹内さん）の言い方 */
const VACATING_STATUS_PHRASE = "現在退去予定で募集中";
/** 上の言い回しを置き換える文（実送信そのまま） */
const VACATING_STATUS_CLAUSE = "現在退去予定で募集中となっております";

/** 文の区切り（！！・！・。・改行）を保ったまま分割する */
function splitSentences(line: string): string[] {
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < line.length; i++) {
    buf += line[i];
    if (/[。！!]/.test(line[i])) {
      // 「！！」はまとめて1つの区切りにする
      while (i + 1 < line.length && /[！!]/.test(line[i + 1])) { buf += line[i + 1]; i++; }
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 費用のマイナスの説明を文ごと落とす（落として空になる行は行ごと消す） */
export function stripNegativeCostTalk(text: string): { text: string; removed: string[] } {
  const src = text ?? "";
  if (!src.trim()) return { text: src, removed: [] };
  const removed: string[] = [];
  const lines: string[] = [];
  for (const line of src.split("\n")) {
    if (!NEGATIVE_COST_RE.test(line)) { lines.push(line); continue; }
    const kept = splitSentences(line).filter((s) => {
      if (!NEGATIVE_COST_RE.test(s)) return true;
      removed.push(s.trim());
      return false;
    });
    const joined = kept.join("").trim();
    if (joined) lines.push(joined);
  }
  if (removed.length === 0) return { text: src, removed: [] };
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!out) return { text: src, removed: [] }; // 全部落ちたら元のまま（安全側）
  return { text: out, removed };
}

/** 締めの行（この前に退去予定の案内を挟む） */
const CLOSER_RE = /ご査収|お気に召され|ご案内させて(?:頂|いただ)きます|お申込|抑えさせて(?:頂|いただ)き|如何でしょうか|いかがでしょうか/;

/**
 * 退去予定のお部屋の生成文を実送信の形に揃える。
 *  ①費用のマイナスの説明を落とす
 *  ②「募集中でご入居可能」→「現在退去予定で募集中」（まだ退去前のお部屋）
 *  ③「◯月◯日退去予定のため、◯月◯日以降にご内覧可能です！！」が無ければ足す
 *    （退去日に触れている文が既にあればその文を置き換え、無ければ締めの直前に入れる）
 * vacDates は物件ごとの退去予定日（空文字・読めない値は無視）。
 * insertWhenMissing=false の時は③の「無ければ足す」をやらない（複数物件の箇条書きは実送信が
 * 「・〇〇 ※ 9月30日退去予定」の形で、物件ごとに内覧解禁日の行を足す形は実送信に無い）。
 */
export function ensureVacatingNotice(
  text: string,
  vacDates: readonly (string | null | undefined)[],
  opts: { nowMs?: number; insertWhenMissing?: boolean } = {},
): { text: string; applied: string[] } {
  const nowMs = opts.nowMs ?? Date.now();
  const insertWhenMissing = opts.insertWhenMissing !== false;
  const applied: string[] = [];
  let out = text ?? "";
  if (!out.trim()) return { text: out, applied };

  const neg = stripNegativeCostTalk(out);
  if (neg.removed.length > 0) { out = neg.text; applied.push(`negative_cost:${neg.removed.length}`); }

  // 読める退去日だけを対象にする（重複は1つに）
  const dates: string[] = [];
  for (const d of vacDates) {
    const label = vacancyDateLabel(String(d ?? ""));
    if (!label || !viewableFromVacancyDate(label, nowMs)) continue;
    if (!dates.includes(label)) dates.push(label);
  }
  if (dates.length === 0) return { text: out, applied };

  if (WRONG_READY_RE.test(out)) {
    out = out.replace(WRONG_READY_RE, VACATING_STATUS_CLAUSE);
    applied.push("ready_phrase");
  }

  for (const label of dates) {
    const from = viewableFromVacancyDate(label, nowMs);
    if (!from) continue;
    // 既に「その内覧解禁日」を案内していれば触らない
    if (out.includes(`${from}以降`) || out.includes(`${from}から`)) continue;
    const sentence = `${label}退去予定のため、${from}以降にご内覧可能です！！`;
    const lines = out.split("\n");
    // 退去日に触れている行があれば、その行の退去予定の文だけ置き換える
    const hitIdx = lines.findIndex((l) => l.includes(label) && l.includes("退去"));
    if (hitIdx >= 0) {
      const sentences = splitSentences(lines[hitIdx]);
      const si = sentences.findIndex((s) => s.includes(label) && s.includes("退去"));
      if (si >= 0) {
        sentences[si] = sentence;
        lines[hitIdx] = sentences.join("").trim();
        out = lines.filter((l, i) => i !== hitIdx || l.length > 0).join("\n");
        applied.push(`replaced:${label}`);
        continue;
      }
    }
    if (!insertWhenMissing) continue;
    // 無ければ締めの直前に入れる（実送信も御見積書の後・お手隙の前）
    const closerIdx = lines.findIndex((l) => CLOSER_RE.test(l));
    if (closerIdx >= 0) lines.splice(closerIdx, 0, sentence);
    else lines.push(sentence);
    out = lines.join("\n");
    applied.push(`inserted:${label}`);
  }
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, applied };
}

/**
 * 生成に渡す材料・指示（退去予定のお部屋の伝え方）。
 * props は物件ごとの { name, vacDate }。退去日が読めるものだけを並べる。
 */
export function buildVacatingPromptNote(
  props: readonly { name?: string | null; vacDate?: string | null }[],
  opts: { nowMs?: number } = {},
): string {
  const nowMs = opts.nowMs ?? Date.now();
  const rows = props
    .map((p) => {
      const label = vacancyDateLabel(String(p.vacDate ?? ""));
      const from = label ? viewableFromVacancyDate(label, nowMs) : null;
      return from ? { name: (p.name ?? "").trim(), label, from } : null;
    })
    .filter((r): r is { name: string; label: string; from: string } => !!r);
  if (rows.length === 0) return "";
  const lines = rows.map((r) =>
    `・${r.name ? `${r.name}: ` : ""}${r.label}退去予定 → ${r.from}以降ご内覧可能（この日付で伝えること）`,
  );
  return [
    "【退去予定のお部屋（確定事実・必ずこの通りに伝える）】",
    ...lines,
    `・状態は「${VACATING_STATUS_PHRASE}」と書く。「募集中でご入居可能」「すぐにご入居頂けます」は書かない（まだ退去前のお部屋）`,
    "・退去予定に触れる文は「◯月◯日退去予定のため、◯月◯日以降にご内覧可能です！！」の形にする（実送信51件の言い回し）",
    "・費用のマイナスの説明は入れない（「割引出来る金額が少ない」「敷金もかかりますので初期費用はかなりかかってしまう」等。退去予定の実送信277件中0件）。御見積書は「初期費用の御見積書同封させて頂きました！！」まで",
  ].join("\n");
}
