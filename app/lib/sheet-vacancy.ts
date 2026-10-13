// app/lib/sheet-vacancy.ts
// 物件資料の「現況（空室・退去予定・居住中）」「退去予定日」「入居可能日（入居時期）」「内覧可能日」を、**資料のどの欄に書いてあるか**で読む（純関数・決定論・LLM なし）。
//
// 2026-10-13 竹内「物件資料を読み直したら、ちゃんと物件資料の部分を読み取れるようになるのか。退去予定日がどこに書いていて、空室がどこに書いているか。
//   退去予定と入居予定の部分を、資料の読み取る箇所を間違えていた部分等も、正確に読み取る場所が分かるようになる形になっているのか」
//
// 【取り違えていた型（実物で数えた・scripts/audit-sheet-vacancy-fields.ts）】
//   ① リアプロの「現況/入居時期 退去予定 / 2026年10月20日」の **2つ目は入居時期**（退去後に入居できる日）なのに、退去予定日として読んだ
//      ・LLM の読み取り: 売上サポの行（property_pickups.image_lines・90日）でこの形 250行のうち 127行が「退去予定: 2026年10月20日」（9/26〜29 の画像読み）
//      ・読み口（viewing-check-first.vacancyDateFromMaterial）: 資料の文字「現況/入居時期 退去予定 / 2026年10月20日」から 10月20日 を退去予定日にした
//        （同じ形の資料 126行・括弧の退去日つきでも「(10/31) / 2026年11月20日」の 11月20日 を先に拾う）＝「10月20日退去予定のため10月21日以降ご内覧可能」を作る
//      ・資料の答え（procedure-question.readMoveInMaterial）: 「退去予定(10/31) / 相談」の (10/31) を入居可能日の日付と見て「資料に入居可能日の記載」にした
//      正解はスタッフの実送信（ハーモニーテラス姫里II「10月末退去予定のお部屋となり11月28日が最短での入居可能時期」＝資料は「退去予定 / 2026年11月28日」）
//   ② 備考・特記事項・案内方法の文にだけある退去予定日を落とした（サザンパークス【現況】「空き予定(9/30退去予定)」・ジェントリー3 案内方法「8月末空き予定」）
//   ③ 「解約予定日 2026年6月30日」「入居予定日 2026/9/中旬退去予定」（欄の名前が退去予定でない所の退去日）
//   ④ 特記の「内覧可能日：2026年8月1日〜」が項目に無かった
//
// 【読み方（欄で決める）】
//   ・現況: 「現況/入居時期」の / の前（リアプロ）か「現況」の欄。括弧の日付「退去予定(10/31)」「(9/下)」は退去予定日
//   ・入居可能日: 「現況/入居時期」の / の後ろ・「入居可能時期」「入居可能日」「入居時期」「入居予定日」「入居日」「引渡し」の欄（字のまま）
//   ・退去予定日: 退去・解約・空き予定の字が付いた日付だけ（括弧・「退去予定日／解約予定日の欄」・「9/30退去予定」「8月末空き予定」の文）。
//     入居時期の欄の日付は退去予定日にしない（入居時期の欄の値に退去の字があればそれは退去予定日＝③）。入居時期と同じ日付の退去予定（写した物）は捨てる
//   ・2部屋以上の一覧（号室ごとの状況）は決めない（読み取り＝LLM の1行のまま）
//   ・欄が食い違う（同じ所から違う日付）時は「分からない」＝その値を出さない（作らない）
// 戻す: SHEET_VACANCY_FIELDS=off（読み取りの後の整え・読み口・資料の答えが旧に戻る）

export type SheetVacancy = {
  /** 現況（資料の字のまま。「退去予定」「空室」「居住中」「空き予定」…）。無ければ null */
  current: string | null;
  currentFrom: string | null;
  /** 退去予定日（資料の字のまま。「9/30」「2026年6月30日」「8月末」「2026/9/中旬」「9/下」） */
  vacate: string | null;
  vacateFrom: string | null;
  /** 入居可能日（入居時期の欄の字のまま。「2026年10月20日」「相談」「即入」「期日指定(2026年09月上旬)」） */
  moveIn: string | null;
  moveInFrom: string | null;
  /** 内覧可能日（「2026年8月1日〜」） */
  viewing: string | null;
  /** リアプロの3つ目以降（商談中・内装中・審査中） */
  extras: string[];
  /** 2部屋以上の一覧（決めない） */
  multiRoom: boolean;
  /** 食い違って出さなかった値（ログ用） */
  conflicts: string[];
};

export function sheetVacancyFieldsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SHEET_VACANCY_FIELDS ?? "").trim().toLowerCase() !== "off";
}

const nf = (s: string) => String(s ?? "").normalize("NFKC");
/** 日付（年は任意）: 10/31・10月31日・10月末・10/下・2026/9/中旬・10月 */
export const SHEET_DATE_SRC = String.raw`(?:\d{4}\s*[年/.\-]\s*)?\d{1,2}\s*(?:月\s*(?:\d{1,2}\s*日|上旬|中旬|下旬|末|上|中|下)?|[/.\-]\s*(?:\d{1,2}(?:\s*日)?|上旬|中旬|下旬|末|上|中|下)(?![\d]))`;
const DATE_RE = new RegExp(SHEET_DATE_SRC);
const DASH_RE = /^[\s\-ー－—―−~〜]*$/;
const STATUS_RE = /空室予定|空き予定|空予定|退去予定|解約予定|空室|空き家|空家|空き|居住中|入居中|賃貸中|建築中|建設中|新築|改装中|リフォーム中|内装中|未完成|完成済|未入居/;
const DEAL_RE = /^(?:商談中|内装中|審査中|清掃中|申込あり|申込有|申込中|リフォーム中|改装中)$/;
const MOVEIN_VALUE_RE = /即|相談|未定|期日指定|指定|調整|応相談|\d/;
/** 現況に添える状態の語（LLM の現況にだけあって欄の値に無い時に落とさない） */
const STATUS_EXTRA_RE = /新築|未入居|内装中|清掃中|リフォーム中|改装中|商談中|審査中|申込あり|申込中/;

/** 日付の比べる鍵（「10/31」「10/末」「9/中旬」・年は外す） */
export function sheetDateKey(raw: string | null | undefined): string | null {
  const s = nf(raw ?? "").replace(/\s+/g, "").replace(/^\d{4}[年/.\-]/, "");
  const m = s.match(/^(\d{1,2})[月/.\-]?(?:(\d{1,2})日?|(上旬|中旬|下旬|末|上|中|下))?/);
  if (!m) return null;
  const mo = Number(m[1]);
  if (mo < 1 || mo > 12) return null;
  if (m[2]) { const d = Number(m[2]); return d >= 1 && d <= 31 ? `${mo}/${d}` : null; }
  if (m[3]) return `${mo}/${/^[上中下]$/.test(m[3]) ? m[3] + "旬" : m[3]}`;
  return `${mo}/月`;
}

/** 「(」「)」の中と「10/31」「2026/9/中旬」の「/」を守ってから「/」で割る */
function splitSlash(v: string): string[] {
  const guard = v
    .replace(/[(（][^)）]*[)）]/g, (x) => x.replace(/[\/／]/g, "∕"))
    .replace(/(\d)\s*[\/／]\s*(?=\d|上|中|下|末)/g, "$1∕")
    .replace(/(\d)∕(\d{1,2})\s*[\/／]\s*(?=\d|上|中|下|末)/g, "$1∕$2∕");
  return guard.split(/\s*[\/／]\s*/).map((x) => x.replace(/∕/g, "/").trim()).filter((x) => x.length > 0);
}

function squashDate(s: string): string {
  return s.replace(/\s*([年月日/])\s*/g, "$1").replace(/\s+/g, " ").trim();
}

/**
 * 和暦を西暦に（「令和8年10月31日」→「2026年10月31日」・「R8.10.31」「R8/10/31」→「2026/10/31」）。
 * 2026-10-13 レビュー: 和暦の退去日が読めず、alignVacancyLines が LLM の正しい「退去予定:」の行まで落としていた
 */
export function seirekiText(s: string): string {
  return String(s ?? "")
    .replace(/令和\s*(\d{1,2}|元)\s*年/g, (_x, n: string) => `${2018 + (n === "元" ? 1 : Number(n))}年`)
    .replace(/(?<![A-Za-z])R\s*(\d{1,2})\s*[.\/年]\s*(\d{1,2})\s*[.\/月]\s*(\d{1,2})\s*日?/g, (_x, y: string, mo: string, d: string) => `${2018 + Number(y)}/${mo}/${d}`);
}

/** 退去予定日の欄の見出し（2026-10-13 レビュー: 空き予定日・空室予定日・退去予定時期・退去時期・明渡し予定を足した） */
const VAC_LABEL_SRC = "退去予定日|解約予定日|退去日|解約日|空き予定日|空予定日|空室予定日|退去予定時期|退去時期|明け?渡し?予定日?|明渡予定日?";

/**
 * 文の中の「退去・解約・空き予定」の字が付いた日付（字のまま）を全部。
 * 2026-10-13 レビュー: 契約期間の終わり（「2026年11月1日～2028年10月31日 解約予告1ヶ月前」「定期借家 …～2028/10/31 解約不可」）と
 *   「※2026/9/30退去済み」を退去予定日にしていた → 「〜」の後の日付・後ろに「予告・不可・時・違約・済」が続く物・来年より先の年は外す
 */
function vacatePhrases(s0: string, nowYear: number = new Date().getFullYear()): string[] {
  const s = seirekiText(s0);
  const out: string[] = [];
  const D = SHEET_DATE_SRC;
  const NOT_AFTER = String.raw`(?!\s*(?:済|時|予告|不可|違約))`;
  const pats: Array<{ re: RegExp; checkPrefix: boolean }> = [
    { re: new RegExp(`(?:退去予定|解約予定|空き?予定|空室予定|退去)\\s*[（(]\\s*(${D})\\s*[)）]`, "g"), checkPrefix: false },
    { re: new RegExp(`(?:${VAC_LABEL_SRC})\\s*(?:は|[:：])?\\s*(${D})`, "g"), checkPrefix: false },
    { re: new RegExp(`(?:退去予定|解約予定)\\s*(?:は|[:：])\\s*(${D})`, "g"), checkPrefix: false },
    // 「解約予定 6月30日」（空白だけ）は解約の日付。「退去予定 2026年12月上旬」は空白だけでは決めない（リアプロの / 抜けの入居時期の恐れ）
    { re: new RegExp(`解約予定\\s+(${D})`, "g"), checkPrefix: false },
    { re: new RegExp(`(${D})\\s*(?:日)?\\s*(?:に|頃|ごろ|迄|まで)?\\s*(?:退去予定|退去|解約予定|解約|空き?予定|空室予定)${NOT_AFTER}`, "g"), checkPrefix: true },
  ];
  for (const { re, checkPrefix } of pats) for (const m of s.matchAll(re)) {
    if (checkPrefix && /[〜~～\-－]\s*$/.test(s.slice(Math.max(0, (m.index ?? 0) - 3), m.index ?? 0))) continue; // 期間の終わり
    const v = squashDate(m[1]);
    const y = v.match(/^(\d{4})/);
    if (y && Number(y[1]) > nowYear + 1) continue; // 来年より先＝契約の満了などで退去予定ではない
    if (sheetDateKey(v)) out.push(v);
  }
  return out;
}

/** 文の中の日付の鍵を全部（退去の字の有無に関係なく） */
function allDateKeys(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of seirekiText(s).matchAll(new RegExp(SHEET_DATE_SRC, "g"))) { const k = sheetDateKey(squashDate(m[0])); if (k && !/月$/.test(k)) out.add(k); }
  return out;
}

const RP_LABEL = /^(?:現況\s*[\/／]\s*入居時期|現況\s*[\/／]\s*入居可能時期)\s*[:：]?\s*(.*)$/;
// 見出しの後は「:」か空白か行末（「現況優先」「現況と異なる場合は」を現況の欄にしない）
const CUR_LABEL = /^(?:現\s*況|空室状況|入居状況)(?:\s*[:：]\s*|\s+|$)(.*)$/;
const MOVEIN_LABEL = /^(?:入居可能時期|入居可能日|入居時期|入居予定日|入居日|引渡し?(?:可能)?(?:日|時期))(?:\s*[:：]\s*|\s+|$)(.*)$/;
/** 入居時期の値の始まり（「入居日より1ヶ月」のような文は値にしない） */
const MOVEIN_START_RE = /^(?:即|相談|未定|期日|応相談|要相談|調整|\d|令和|R\s*\d|[上中下]旬|退去|解約|空き?予定)/;
const VIEW_LABEL = /(?:内覧|内見)(?:可能日|開始日|開始|可能)\s*[:：]?\s*((?:\d{4}\s*[年/.\-]\s*)?\d{1,2}\s*[月/.\-]\s*\d{1,2}\s*日?\s*(?:[〜~～]|以降|より|から)?)/;
const EMBEDDED_LABELS = /(入居可能時期|入居可能日|入居予定日|入居時期|解約予定日|退去予定日|空き予定日|空室予定日|退去予定時期)/g;

/** 1行に並んだ見出し（itandi「現況 居住中 入居可能時期 2026年11月上旬」）を行に分ける。行頭の印（※・■・【】）を外す */
function toLines(text: string): string[] {
  const raw = seirekiText(nf(text)).replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l0 of raw) {
    const l = l0.replace(/^[\s※＊*■□●・\-]+/, "").replace(/^【([^】]{1,8})】\s*/, "$1: ").trim();
    if (!l) continue;
    // 「現況/入居時期」の中の入居時期は分けない（前が / の時は分けない）
    const split = l.replace(EMBEDDED_LABELS, (m, _g, off: number) => (off > 0 && !/[\/／]\s*$/.test(l.slice(0, off)) ? `\n${m}` : m));
    out.push(...split.split("\n").map((x) => x.trim()).filter(Boolean));
  }
  return out;
}

/**
 * 資料の文字（PDF の文字層・画像の書き写し・読み取った行）から、現況・退去予定日・入居可能日・内覧可能日を欄で読む。
 */
export function readSheetVacancy(text: string | null | undefined): SheetVacancy {
  const out: SheetVacancy = { current: null, currentFrom: null, vacate: null, vacateFrom: null, moveIn: null, moveInFrom: null, viewing: null, extras: [], multiRoom: false, conflicts: [] };
  const lines = toLines(String(text ?? ""));
  if (lines.length === 0) return out;
  out.multiRoom = lines.filter((l) => /号室\s*[:：]\s*\S+/.test(l)).length >= 2;
  if (out.multiRoom) return out;
  type Cand = { raw: string; from: string; rank: number };
  const vac: Cand[] = [];
  const moveIns: Cand[] = [];
  const curs: Cand[] = [];
  const valueAt = (i: number, v: string) => (v.trim() ? v.trim() : (lines[i + 1] && !/[:：]/.test(lines[i + 1]) ? lines[i + 1].trim() : ""));
  const takeCurrent = (v: string, from: string, rank: number) => {
    const val = v.replace(/[(（][^)）]*[)）]/g, "").trim();
    for (const p of vacatePhrases(v)) vac.push({ raw: p, from: `${from}の括弧・文`, rank: 0 });
    // 「現況」だけの欄（入居時期の欄と分かれている）の「退去予定 2026/09/29」は退去予定日（Park Lane Minami 902・スタッフ「9月29日退去予定」）。
    //   「現況/入居時期」の欄は / 抜けの入居時期の恐れがあるので決めない
    const sp = from === "現況" ? v.match(new RegExp(`^(?:退去予定|解約予定|空き?予定)\\s+(${SHEET_DATE_SRC})\\s*$`)) : null;
    if (sp && sheetDateKey(squashDate(sp[1]))) vac.push({ raw: squashDate(sp[1]), from: "現況の欄", rank: 1 });
    if (!val || DASH_RE.test(val)) return;
    const w = val.match(STATUS_RE);
    // 短い値は字のまま（「新築 空室」の新築を落とさない）。日付や文が混ざる長い値だけ状態の語にする
    const short = val.replace(/\s+/g, " ");
    curs.push({ raw: w && (short.length > 12 || /\d/.test(short)) ? w[0] : short.slice(0, 20), from, rank });
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m = l.match(RP_LABEL);
    if (m) {
      const v = valueAt(i, m[1]);
      const parts = splitSlash(v);
      if (parts.length) takeCurrent(parts[0], "現況/入居時期の前", 0);
      const rest = parts.slice(1);
      const tIdx = rest.findIndex((p) => !DEAL_RE.test(p) && MOVEIN_VALUE_RE.test(p));
      if (tIdx >= 0) moveIns.push({ raw: squashDate(rest[tIdx]), from: "現況/入居時期の後ろ", rank: 0 });
      out.extras.push(...rest.filter((p, k) => k !== tIdx && DEAL_RE.test(p)));
      continue;
    }
    m = l.match(CUR_LABEL);
    if (m) {
      const v = valueAt(i, m[1]);
      const parts = splitSlash(v);
      // 「現況: 空室 / 即入」（読み取った行の形）＝前が現況・後ろが入居時期（日付・即入・相談の時だけ）
      if (parts.length >= 2 && STATUS_RE.test(parts[0])) {
        takeCurrent(parts[0], "現況", 1);
        const rest = parts.slice(1);
        const tIdx = rest.findIndex((p) => !DEAL_RE.test(p) && MOVEIN_VALUE_RE.test(p) && !/退去|解約|空き?予定/.test(p));
        if (tIdx >= 0) moveIns.push({ raw: squashDate(rest[tIdx]), from: "現況の / の後ろ", rank: 2 });
        out.extras.push(...rest.filter((p, k) => k !== tIdx && DEAL_RE.test(p)));
      } else takeCurrent(v, "現況", 1);
      continue;
    }
    m = l.match(MOVEIN_LABEL);
    if (m) {
      const v = valueAt(i, m[1]).replace(/\s*(?:契約期間|解約予告|更新料|駐車場|引渡し?|現況).*$/, "").trim();
      const label = l.slice(0, l.length - m[1].length).replace(/[:：\s]+$/, "");
      if (!v || DASH_RE.test(v) || !MOVEIN_START_RE.test(v)) continue;
      if (/退去|解約|空き?予定/.test(v)) {
        // 入居時期の欄に退去の字＝退去予定日（ハーモニーテラス森ノ宮「入居予定日 2026/9/中旬退去予定」）
        for (const p of vacatePhrases(v)) vac.push({ raw: p, from: `${label}の欄の文`, rank: 2 });
        if (!vacatePhrases(v).length) curs.push({ raw: "退去予定", from: `${label}の欄`, rank: 3 });
        continue;
      }
      moveIns.push({ raw: squashDate(v), from: `${label}の欄`, rank: label === "入居予定日" ? 2 : 1 });
      continue;
    }
    // 退去予定日・解約予定日の欄／備考・特記・案内方法の文
    const isVacLabel = new RegExp(`^(?:${VAC_LABEL_SRC}|退去予定|解約予定)\\s*[:：]?`).test(l);
    for (const p of vacatePhrases(l)) vac.push({ raw: p, from: isVacLabel ? `${l.match(/^[^:：\s\d]+/)?.[0] ?? "退去予定"}の欄` : "備考・特記の文", rank: isVacLabel ? 1 : 3 });
    if (isVacLabel && !curs.length && !vacatePhrases(l).length && /^退去予定\s*[:：]?\s*$/.test(l)) curs.push({ raw: "退去予定", from: "退去予定の欄", rank: 3 });
    const vw = l.match(VIEW_LABEL);
    if (vw && !out.viewing) out.viewing = squashDate(vw[1]);
  }
  // 入居可能日: 一番確かな所から。同じ順位で違う値なら出さない
  const pick = (cs: Cand[], name: string): Cand | null => {
    if (!cs.length) return null;
    const top = Math.min(...cs.map((c) => c.rank));
    const best = cs.filter((c) => c.rank === top);
    const keys = new Set(best.map((c) => (name === "moveIn" ? c.raw.replace(/\s+/g, "") : sheetDateKey(c.raw) ?? c.raw)));
    if (keys.size > 1) { out.conflicts.push(`${name}: ${best.map((c) => `${c.raw}(${c.from})`).join(" / ")}`); return null; }
    return best[0];
  };
  const mv = pick(moveIns, "moveIn");
  if (mv) { out.moveIn = mv.raw; out.moveInFrom = mv.from; }
  // 入居時期と同じ日付の退去予定（入居時期を写した物）は捨てる
  const mvKey = mv ? sheetDateKey(mv.raw.replace(/^[^\d]*/, "")) : null;
  const vacOk = vac.filter((c) => !(mvKey && sheetDateKey(c.raw) === mvKey));
  if (vacOk.length < vac.length) out.conflicts.push(`vacate=moveIn: ${vac.filter((c) => !vacOk.includes(c)).map((c) => c.raw).join(" / ")}`);
  const vc = pick(vacOk, "vacate");
  if (vc) { out.vacate = vc.raw; out.vacateFrom = vc.from; }
  const cu0 = curs.length ? curs.sort((a, b) => a.rank - b.rank)[0] : null;
  // 現況の欄が「空室」なのに備考に退去日（リバーサイド大今里「空室」＋特記「8月末空予定」・ソル グランデ「空室」＋「8/31退去予定」）＝退去の後に空室になった古い文。
  //   現況の欄を正とし、退去予定日は出さない（分からない側）
  if (cu0 && /(?:空室|空き家|空家|^空き)$/.test(cu0.raw) && !/予定/.test(cu0.raw) && out.vacate) { out.conflicts.push(`vacate(空室): ${out.vacate}(${out.vacateFrom})`); out.vacate = null; out.vacateFrom = null; }
  const cu = cu0;
  if (cu) { out.current = cu.raw; out.currentFrom = cu.from; }
  else if (out.vacate) { out.current = "退去予定"; out.currentFrom = out.vacateFrom; }
  // 現況が「空き予定」等で退去日があれば現況は退去予定の側（字のまま残す）
  out.extras = [...new Set(out.extras)];
  return out;
}

/** 欄で読んだ値を、読み取りの行（「見出し: 値」）にする。値の無い見出しは作らない */
export function sheetVacancyLines(v: SheetVacancy): string[] {
  const out: string[] = [];
  if (v.current) out.push(`現況: ${v.current}${v.extras.length ? `・${v.extras.join("・")}` : ""}`);
  if (v.vacate) out.push(`退去予定: ${v.vacate}`);
  if (v.moveIn) out.push(`入居可能日: ${v.moveIn}`);
  if (v.viewing) out.push(`内覧可能日: ${v.viewing}`);
  return out;
}

const VAC_LINE_RE = /^(?:現況|退去予定|入居可能日|内覧可能日)\s*[:：]/;
const labelOf = (l: string) => (nf(l).match(/^(現況|退去予定|入居可能日|内覧可能日)/)?.[1] ?? null);

/**
 * 読み取った行（LLM）の現況・退去予定・入居可能日・内覧可能日を、元の文字（書き写し・文字層）の欄で読んだ値に合わせる（純関数・出口の決定論）。
 *   ・欄で読めた見出しは欄の値に置き換える（LLM が入居時期を退去予定にした・備考の退去日を落とした を直す）
 *   ・欄で読めなかった見出しは LLM の行を残す。ただし「退去予定: 日付」は元の文字で退去の字が付いていなければ落とす（作り事・取り違え）
 *   ・元の文字が無い（画像を直接読んだ）・2部屋以上の一覧は触らない（呼び出し側で normalizeVacancyLines だけ）
 */
export function alignVacancyLines(lines: string[], sourceText: string | null | undefined, env: Record<string, string | undefined> = process.env): { lines: string[]; changed: boolean; read: SheetVacancy | null } {
  const src = String(sourceText ?? "");
  if (!sheetVacancyFieldsEnabled(env) || src.trim().length < 20) return { lines, changed: false, read: null };
  const v = readSheetVacancy(src);
  if (v.multiRoom) return { lines, changed: false, read: v };
  const fromSheet = sheetVacancyLines(v);
  const got = new Set(fromSheet.map((l) => labelOf(l)));
  const srcText = toLines(src).join("\n");
  const srcVac = new Set(vacatePhrases(srcText).map((x) => sheetDateKey(x)));
  const srcDates = allDateKeys(srcText);
  const valOf = (l: string) => seirekiText(nf(l)).replace(/^[^:：]+[:：]\s*/, "").trim();
  const sq = (s: string) => s.replace(/[\s・]+/g, "");
  const out: string[] = [];
  const notes: string[] = [];
  let at = -1;
  for (const l of lines) {
    const lab = VAC_LINE_RE.test(nf(l)) ? labelOf(l) : null;
    if (!lab) { out.push(l); continue; }
    if (at < 0) at = out.length;
    if (got.has(lab)) {
      // 欄の値に置き換える。2026-10-13 レビュー: 置き換えで情報を落とさない
      const lv = valOf(l);
      if (lab === "現況" && v.current) {
        // 「新築 空室」→ 欄「空室」: LLM の値の末尾が欄の値なら前の語（新築）を残す
        const fv = v.current;
        const lhead = splitSlash(lv)[0] ?? lv; // 「新築 空室 / 即入 / 商談中」の前
        const i = fromSheet.findIndex((x) => labelOf(x) === "現況");
        if (i >= 0 && sq(lhead).length > sq(fv).length && sq(lhead).endsWith(sq(fv)) && !/\d/.test(lhead)) {
          fromSheet[i] = `現況: ${lhead.replace(/\s+/g, " ")}${v.extras.length ? `・${v.extras.join("・")}` : ""}`;
        } else if (i >= 0) {
          // LLM の現況にだけある状態の語（新築・未入居・内装中・清掃中…）は添える（欄の値は変えない）
          const words = (lv.match(new RegExp(STATUS_EXTRA_RE.source, "g")) ?? []).filter((w) => !fromSheet[i].includes(w));
          if (words.length) fromSheet[i] = `${fromSheet[i]}・${[...new Set(words)].join("・")}`;
        }
      }
      if (lab === "入居可能日" && v.moveIn) {
        // 欄で決めた入居可能日と違う LLM の値（「即入居可」「27日後入居可」「退去及び内装完了後」）は捨てずに別の行に添える。
        //   「入居可能日:」の見出しにしない＝読み口（readMoveInMaterial）が即入居と取り違えない
        const a = sq(lv), b = sq(v.moveIn);
        const same = a === b || a.includes(b) || b.includes(a)
          || (!!sheetDateKey(a.replace(/^[^\d]*/, "")) && sheetDateKey(a.replace(/^[^\d]*/, "")) === sheetDateKey(b.replace(/^[^\d]*/, "")))
          || (/即/.test(a) && /即/.test(b)) || (/相談/.test(a) && /相談/.test(b))
          || (!!v.vacate && !!sheetDateKey(a.replace(/^[^\d]*/, "")) && sheetDateKey(a.replace(/^[^\d]*/, "")) === sheetDateKey(v.vacate));
        // 日付が同じでも、日付の外の言葉（「10/10 契約開始 必須」の契約開始・必須）は条件なので添える
        const rest = seirekiText(lv).replace(new RegExp(SHEET_DATE_SRC, "g"), "").replace(/^\d{4}\s*[年/.\-]?/, "").replace(/[\s・/／()（）、,~〜～]+/g, " ").trim();
        const extraWords = same && /\d/.test(lv) && rest.length >= 2 && !/^(?:即入?居?可?|相談|日|頃|以降|より|から|可)$/.test(rest) && !b.includes(sq(rest)) ? rest : "";
        if (!same && lv) notes.push(`入居の別の記載: ${lv}（資料の別の所）`);
        else if (extraWords) notes.push(`入居の別の記載: ${lv}（資料の別の所）`);
      }
      continue;
    }
    if (lab === "退去予定") {
      const k = sheetDateKey(valOf(l).match(DATE_RE)?.[0] ?? "");
      if (!k) continue; // 日付の無い退去予定の行は現況が持つ
      // 元の文字にその日付があるのに退去の字が付いていない＝入居時期などの日付の取り違え → 落とす。
      //   元の文字に日付が見つからない（和暦・書式が読めない）時は落とさず残す（2026-10-13 レビュー）
      if (!srcVac.has(k) && srcDates.has(k)) continue;
    }
    if (lab === "入居可能日" && v.vacate) {
      // 欄で読んだ退去予定日と同じ日付の入居可能日＝退去予定日を入居可能日にした（ハーモニーテラス森ノ宮「入居予定日 2026/9/中旬退去予定」）
      const k = sheetDateKey(nf(l).replace(/^[^:：]+[:：]\s*/, "").match(DATE_RE)?.[0] ?? "");
      if (k && k === sheetDateKey(v.vacate)) continue;
    }
    out.push(l);
  }
  if (at < 0) at = out.length;
  out.splice(at, 0, ...fromSheet, ...notes);
  return { lines: out, changed: JSON.stringify(out) !== JSON.stringify(lines), read: v };
}

/** 退去予定日を「M月D日」「M月末」に（旬・月だけは null＝内覧開始日を作らない） */
export function vacateMonthDay(raw: string | null | undefined): string | null {
  const k = sheetDateKey(raw);
  if (!k) return null;
  const [mo, d] = k.split("/");
  if (/^\d+$/.test(d)) return `${Number(mo)}月${Number(d)}日`;
  if (d === "末") return `${Number(mo)}月末`;
  return null;
}
