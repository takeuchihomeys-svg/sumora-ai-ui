// app/lib/guarantor-material.ts
// 物件の資料（売上サポの行の PDF 文字層 pdf_text・資料の読み取り行 image_lines／送った画像の読み取り image_details.lines）から
// 保証会社名を取り出す（純関数・DB/LLM なし）。種類は guarantor-companies.ts のマスタ1本（resolveGuarantor）で引く。
//
// 2026-10-06 竹内（松浦 麻夜 事例）「資料に保証会社記載されているので、それも読みとることはできないのか」:
//   10/4 15:51 🌟H-maison大正VII 106 を新着1件で送付 → 17:46 お客様「ここは保証会社どこでしょうか？」→ AIX【保証会社について】を開くと物件・会社とも空。
//   資料（リアプロ）には「保証会社：保証会社利用必須 興和アシスト 初回 総賃料の50%」と書いてあった（文字層・読み取り行の両方）のに、
//   AIX はこの欄を一度も読んでいなかった（会話に出た会社名だけを候補にしていた）。
//
// 決まり（監査 scripts/audit-guarantor-prefill.ts・60日の売上サポの行 2,532 件を目で読んで決めた）:
//   ・読むのは「保証会社」の見出しの直後だけ（同じ資料の「株式会社サイラス」等の元付・管理会社の名前を拾わない）。
//     リアプロの文字層は1行の幅で折り返す（「ルームバン⏎クインシュア」）ので、長い行は次の行とつなぐ
//   ・文字層（PDF）を先に読み、会社名が無い時だけ読み取り行（LLM が読んだ行）を使う。
//     読み取り行には読み違い（S全保証・イエントラスト・エイブル賃貸保証）があり、文字層と食い違った 16件はほぼ全部が読み取り行の誤り
//   ・「外国籍の方は【GTN】」「否決時:ニッポンインシュア」「2番手保証会社」「大手法人」の後ろの会社は、その物件の保証会社として数えない
//   ・マスタ（＋スタッフが登録した会社）の名前は見出しの中から拾う。マスタに無い会社は見出しの先頭の1語で、会社名の形
//     （株式会社が付く・〜保証／〜サポート／〜インシュア 等で終わる・英大文字4字以上の略称）の時だけ
//   ・1社だけ → その会社。2社以上（「エポスカード、全保連 2社審査」「審査順 (1)全保連 (2)CASA」）→ 決めない（候補だけ出す）
//   ・「保証会社利用必須」だけ（会社名なし）→ 決めない（推測しない・スタッフが管理会社に確かめる）
import { GUARANTOR_COMPANY_MASTER, resolveGuarantor, guarantorAliasesOf, type GuarantorType } from "./guarantor-companies";

export type MaterialGuarantor = { name: string; type: GuarantorType; known: boolean };
export type MaterialGuarantorResult = {
  /** 資料に書かれた会社（重複なし・出た順） */
  companies: MaterialGuarantor[];
  /** named=1社だけ書いてある・multiple=2社以上・unnamed=見出しはあるが会社名なし（利用必須だけ）・none=保証会社の記載なし */
  status: "named" | "multiple" | "unnamed" | "none";
  /** どちらから読んだか（pdf=文字層・lines=読み取り行） */
  from: "pdf" | "lines" | null;
  /** 読んだ見出しの中身（画面の「資料から」の根拠・監査用） */
  evidence: string[];
};

/** NFKC＋カタカナの後ろの長音のゆれ（「ジェイリ－ス」→「ジェイリース」） */
const nk = (s: string) => s.normalize("NFKC").replace(/(?<=[ァ-ヶ])[-‐−―]/g, "ー");

/** 見出しの中身の終わり（次の項目「・保険：」「・契約事務手数料：」・節の見出し） */
const NEXT_KEY_RE = /・[^・\s:：]{1,14}[:：]|(?:^|\s)(?:取引態様|特記事項|その他費用|設備|備考|保険加入|更新料)(?:[:：\s]|$)/;
/** 中身の先頭の決まり文句（会社名ではない） */
const FILLER_HEAD_RE = /^(?:[\s,、・‧:：()（）【】\[\]]|保証会社|保証人代行|貸主指定|利用|必須|必要|可能|加入|要|指定|あり|有り|の)+/;
/** 会社名の後ろに来る区切り */
const TOKEN_END_RE = /[\s,、・/／()（）【】\[\]※:：。]|初回|総賃料|保証料|月額|月次|年間|更新|指定|必須|加入|[0-9]/;
/** 会社名の形（マスタに無い会社を拾ってよい形） */
const COMPANY_SUFFIX_RE = /(?:保証|サポート|インシュア|ギャランティー?|アシスト|ファースト|ファイナンス|機構|リーブ|倶楽部|プラス|クレジット|カード|トラスト|パートナーズ|サービス|レント|セゾン)$/;
const ASCII_ABBR_RE = /^[A-Z][A-Z0-9\-]{3,7}$/;
/** 先頭の1語が会社名ではない時（料率・条件の言葉） */
const NOT_COMPANY_RE = /^(?:初回|保証料|総賃料|月額|月次|年|保証人|連帯|法人|個人|大手|なし|無し|不要|不可|可|ー|-|審査|原則|別途|家賃|賃料|敷金|礼金|契約|要相談|相談|非加入|未加入)/;
/** 一般語（会社名ではない） */
const GENERIC_RE = /^(?:保証|賃貸保証|連帯保証|信用保証|家賃保証|機関保証|債務保証|指定賃貸保証|指定保証|保証会社)$/;
/** その物件の保証会社ではない言い方（この後ろの会社は数えない） */
const QUALIFIER_SPLIT_RE = /(外国籍|外国人|海外|否決時|否決の場合|否認|否承認|審査不可|2番手|二番手|大手法人|法人契約|法人の場合|法人:|その他保証会社|他保証会社)/;

/** マスタの走査語（長い順）。短い語（アーク・エイト等）も見出しの中だけなので拾う */
const MASTER_WORDS: ReadonlyArray<{ word: string; canonical: string }> = GUARANTOR_COMPANY_MASTER
  .flatMap((c) => [c.name, ...c.aliases].map((w) => ({ word: nk(w).toLowerCase(), canonical: c.name })))
  .filter((x) => x.word.length >= 2)
  .sort((a, b) => b.word.length - a.word.length);

const SHORT_ALIASES: ReadonlySet<string> = new Set(["プレサンス", "ライフ", "アーク", "エイト", "オセロ", "シノケン", "セゾン", "エルズ", "アセス"].map((w) => nk(w).toLowerCase()));
const isAsciiWord = (w: string) => /^[\x20-\x7e]+$/.test(w);
const isAlnum = (ch: string | undefined) => !!ch && /^[a-z0-9]$/i.test(ch);
/** 折り返しとみなす行の長さ（リアプロの資料の特記事項は 70〜80 字で折り返す） */
const WRAP_MIN = 55;

/** 資料の文字（PDF の文字層・読み取り行）から「保証会社」の見出しの中身を取り出す */
export function guarantorSegmentsOf(text: string | null | undefined): string[] {
  const t = nk(String(text ?? ""));
  const out: string[] = [];
  const re = /保証会社/g;
  let coveredTo = -1;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    if (m.index < coveredTo) continue;   // 前の中身の中の「保証会社利用必須」は数えない
    const start = m.index + m[0].length;
    let rest = t.slice(start);
    // 「保証会社：」「保証会社: 」「保証会社⏎利用必須 , オリコ」（itandi の表）・「保証会社加入要 ジェイリース(」
    const head = rest.match(/^[ \t]*[:：]?[ \t]*\n?/);
    const headLen = head ? head[0].length : 0;
    rest = rest.slice(headLen);
    const lines = rest.split("\n");
    let seg = lines[0] ?? "";
    let used = seg.length;
    // 折り返し: 長い行（行の頭から数える）で次の項目に届いていなければ次の行とつなぐ（字の途中で折り返すので空白を入れない）
    const lineStart = t.lastIndexOf("\n", m.index) + 1;
    const lineLen = headLen > 0 && head![0].includes("\n") ? seg.length : (start + headLen - lineStart) + seg.length;
    if (lineLen >= WRAP_MIN && seg.search(NEXT_KEY_RE) < 0 && lines[1] !== undefined
      && !/^\s*(?:[^\s:：・]{1,10}[:：]|【|■|取引態様|特記事項|設\s*備|備\s*考|条\s*件|[0-9]{6,})/.test(lines[1])) { seg += lines[1]; used += 1 + lines[1].length; }
    const k = seg.search(NEXT_KEY_RE);
    if (k >= 0) seg = seg.slice(0, k);
    coveredTo = start + headLen + Math.min(used, seg.length + 1);
    seg = seg.trim().slice(0, 200);
    if (seg && !out.includes(seg)) out.push(seg);
  }
  return out;
}

/** 中身のうち、その物件の保証会社として読む所（「※外国籍の方は【GTN】」「否決時:〇〇」の後ろを外す） */
export function mainClauseOf(seg: string): string {
  // 「2GTN(外国籍)」＝括弧の但し書きはその1社だけに掛かる → その1社だけ外し、後ろに続く会社（日本セーフティー）は残す
  const parts = nk(seg).replace(/[A-Za-z0-9ァ-ヶー]+\((?:外国籍|外国人|海外)[^)]*\)/g, "、").split(QUALIFIER_SPLIT_RE);
  return parts[0] ?? "";
}

/** 見出しの中身から会社名（マスタ＋登録の会社＋会社名の形の先頭の1語） */
export function companiesInSegment(seg: string, customs: ReadonlyArray<{ name: string; type: GuarantorType }> = []): MaterialGuarantor[] {
  const main = companiesInClause(mainClauseOf(seg), customs);
  // 番号付きの並び（「1いえらぶ2GTN(外国籍)3日本セーフティー」「【1番手】〜【2番手】〜」）は選べる会社の一覧 → 外国籍等で切らずに全部を数える（2社以上＝決めない）
  if (/[①②③]|1番手|2番手|二番手|(?<![0-9.,])1\s*(?=[ぁ-ゖァ-ヶA-Za-z])[\s\S]*?(?<![0-9.,])2\s*(?=[ぁ-ゖァ-ヶA-Za-z])/.test(nk(seg))) {
    const full = companiesInClause(nk(seg), customs);
    if (full.length > main.length) return full;
  }
  return main;
}

function companiesInClause(s: string, customs: ReadonlyArray<{ name: string; type: GuarantorType }>): MaterialGuarantor[] {
  const out: MaterialGuarantor[] = [];
  const push = (raw: string) => {
    const r = resolveGuarantor(raw, customs);
    if (!out.some((o) => o.name === r.name)) out.push({ name: r.name, type: r.type, known: r.known });
  };
  // ① マスタ・登録の会社（長い語から・拾った所は伏せて短い別名で二重に拾わない）
  let masked = s.toLowerCase();
  const words = [...MASTER_WORDS, ...customs.map((c) => ({ word: nk(c.name).toLowerCase(), canonical: c.name }))]
    .filter((x) => x.word.length >= 2)
    .sort((a, b) => b.word.length - a.word.length);
  const hits: Array<{ at: number; canonical: string; word: string }> = [];
  for (const { word, canonical } of words) {
    let from = 0;
    for (let at = masked.indexOf(word, from); at >= 0; at = masked.indexOf(word, from)) {
      from = at + word.length;
      if (isAsciiWord(word) && (isAlnum(masked[at - 1]) || isAlnum(masked[at + word.length]))) continue;
      // 「西日本賃貸保証サービス」の中の「日本賃貸保証」＝別の会社（漢字の名前の前に方角・新が付く）
      if (/^[一-龠]/.test(word) && /[西東南北新]/.test(masked[at - 1] ?? "")) continue;
      // 一般語に近い短い別名（プレサンス・ライフ・アーク・エイト・オセロ・シノケン）は、後ろに別の語が続けば別の会社（「株式会社プレサンスコミュニティ」＝管理会社）
      if (SHORT_ALIASES.has(word) && /[ァ-ヶーA-Za-z一-龠]/.test(masked[at + word.length] ?? "") && !/^(?:賃貸|保証|信用|他|等|又|及)/.test(masked.slice(at + word.length))) continue;
      hits.push({ at, canonical, word });
      masked = masked.slice(0, at) + "\u0000".repeat(word.length) + masked.slice(at + word.length);
    }
  }
  hits.sort((a, b) => a.at - b.at);
  for (const h of hits) push(h.canonical);
  // ② マスタに無い会社: 先頭の決まり文句を外した最初の1語が会社名の形の時だけ
  const headText = s.replace(FILLER_HEAD_RE, "");
  const hadKabu = /^(?:株式会社|\(株\))/.test(headText);
  const body = headText.replace(/^(?:株式会社|\(株\))\s*/, "");
  const endAt = body.search(TOKEN_END_RE);
  let tok = (endAt >= 0 ? body.slice(0, endAt) : body).trim();
  const after = body.slice(tok.length).trim();
  const kabuAfter = /^株式会社|^\(株\)/.test(after);
  // 「近畿保証(K-net)」「賃貸保証(セーフティー)」＝括弧の中がマスタの会社の言い換え → 先頭の語は足さない（同じ会社を2社に数えない）
  const parenAliasOfHit = hits.length > 0 && /^\(/.test(after.replace(/^(?:株式会社|\(株\))\s*/, ""));
  tok = tok.replace(/(?:株式会社|\(株\))$/, "").trim();
  const tokLow = tok.toLowerCase();
  // 「アセス信用保証」「いえらぶ安心保証」「ライフあんしんプラス」＝拾ったマスタの会社の名前を含む → 同じ会社
  const containsHit = hits.some((h) => tokLow.includes(h.word) || h.word.includes(tokLow));
  // 「株式会社クレディ・セゾン」の「クレディ」＝すぐ後ろが拾った会社の名前 → 同じ会社の名前の一部
  //   （「JRAG・CASA」は別の2社＝つないだ名前がその会社の名前になる時だけ同じ会社とみなす）
  const flat = (x: string) => nk(x).toLowerCase().replace(/[・‧･\s]/g, "");
  const nextIsHit = hits.some((h) => after.replace(/^[・‧･\s]+/, "").toLowerCase().startsWith(h.word)
    && guarantorAliasesOf(h.canonical).some((a) => flat(a) === flat(tok + h.word)));
  // 「保証人代行サービス保証料」の「サービス」＝会社名の形の語尾だけ（名前の本体が無い）
  const suffixOnly = tok.replace(COMPANY_SUFFIX_RE, "").length === 0;
  if (!parenAliasOfHit && !containsHit && !nextIsHit && !suffixOnly && tok.length >= 3 && tok.length <= 20 && !NOT_COMPANY_RE.test(tok) && !GENERIC_RE.test(tok) && !/[0-9%％]/.test(tok)) {
    const looksCompany = hadKabu || kabuAfter || COMPANY_SUFFIX_RE.test(tok) || ASCII_ABBR_RE.test(tok);
    if (looksCompany) push(tok);
  }
  // ④ マスタの会社のすぐ後ろに並べたマスタに無い会社（「エポスカード、フォーディーネット」）→ 足す（2社以上＝決めない側）
  for (const h of hits) {
    const rest = s.slice(h.at + h.word.length);
    const mm = rest.match(/^s*[、,・/／]s*([ァ-ヶーA-Za-z][ァ-ヶーA-Za-z0-9]{3,19})/);
    if (!mm) continue;
    const x = mm[1];
    const xl = x.toLowerCase();
    if (NOT_COMPANY_RE.test(x) || GENERIC_RE.test(x) || hits.some((o) => xl.startsWith(o.word) || o.word.startsWith(xl))) continue;
    if (!out.some((o) => nk(o.name).toLowerCase() === xl)) push(x);
  }
  // ③ マスタに無い会社が見出しの途中に並ぶ形（「【個人契約の場合】… 【信和CM保証】信和CM保証(信和保証プラン)… 【全保連】…」＝監査 ラ・フェスタ真田山）:
  //   【〇〇】か「〇〇(」の〇〇が会社名の形（〜保証・〜サポート 等で終わる）なら足す（＝2社以上になり、決めない側に倒れる）
  for (const m of s.matchAll(/【([^【】]{2,20})】|([^\s【】()（）・,、/:：]{2,20})[(（]/g)) {
    const x = (m[1] ?? m[2] ?? "").replace(/^(?:株式会社|\(株\))|(?:株式会社|\(株\))$/g, "").trim();
    const xl = x.toLowerCase();
    if (x.length < 3 || /[0-9%％]/.test(x) || NOT_COMPANY_RE.test(x) || GENERIC_RE.test(x) || !COMPANY_SUFFIX_RE.test(x)) continue;
    if (hits.some((h) => xl.includes(h.word) || h.word.includes(xl))) continue;
    // 「近畿保証(K-net)」＝括弧の中がマスタの会社 → 同じ会社の言い換え
    if (m[2] && hits.some((h) => s.slice((m.index ?? 0) + m[0].length).toLowerCase().startsWith(h.word))) continue;
    if (out.some((o) => { const n = nk(o.name).toLowerCase(); return n.includes(xl) || xl.includes(n); })) continue;
    push(x);
  }
  return out;
}

function readSegments(segs: string[], customs: ReadonlyArray<{ name: string; type: GuarantorType }>): { companies: MaterialGuarantor[]; evidence: string[] } {
  const companies: MaterialGuarantor[] = [];
  const evidence: string[] = [];
  for (const s of segs) {
    const cs = companiesInSegment(s, customs);
    if (cs.length) evidence.push(s);
    for (const c of cs) if (!companies.some((x) => x.name === c.name)) companies.push(c);
  }
  // 別の見出しで拾ったマスタの会社の名前の一部・言い換え（「ルームバン」「JACC」）は同じ会社
  const knownWords = companies.filter((c) => c.known).flatMap((c) => guarantorAliasesOf(c.name).map((w) => nk(w).toLowerCase()));
  const kept = companies.filter((c) => c.known || !knownWords.some((w) => { const n = nk(c.name).toLowerCase(); return w.includes(n) || n.includes(w); }));
  return { companies: kept, evidence };
}

/**
 * 資料（文字層・読み取り行）に書かれた保証会社。文字層を先に読み、会社名が無い時だけ読み取り行。
 * @param material pdfText（PDF の文字層）・lines（読み取り行「保証会社: 〜」）。どちらか片方でもよい
 * @param customs  スタッフが登録した会社（guarantor_companies）
 */
export function guarantorFromMaterial(
  material: { pdfText?: string | null; lines?: ReadonlyArray<string> | null },
  customs: ReadonlyArray<{ name: string; type: GuarantorType }> = [],
): MaterialGuarantorResult {
  const pdfSegs = guarantorSegmentsOf(material.pdfText);
  const lineSegs: string[] = [];
  for (const l of material.lines ?? []) {
    const m = nk(String(l ?? "")).match(/^\s*保証会社\s*[:：]\s*(.+)$/);
    if (m && !lineSegs.includes(m[1].trim())) lineSegs.push(m[1].trim());
  }
  const pdf = readSegments(pdfSegs, customs);
  const lines = readSegments(lineSegs, customs);
  // 文字層が折り返しで切れて1社だけに見え、読み取り行がその会社を含む2社以上を読んでいる（「①K-net…⏎②ジェイリース」）→ 2社以上（決めない側）
  const pdfCut = pdf.companies.length === 1 && lines.companies.length > 1 && lines.companies.some((c) => c.name === pdf.companies[0].name);
  const use = pdf.companies.length && !pdfCut ? { ...pdf, from: "pdf" as const } : lines.companies.length ? { ...lines, from: "lines" as const } : { ...pdf, from: "pdf" as const };
  if (!pdfSegs.length && !lineSegs.length) return { companies: [], status: "none", from: null, evidence: [] };
  if (!use.companies.length) return { companies: [], status: "unnamed", from: null, evidence: [...pdfSegs, ...lineSegs].slice(0, 2) };
  return { companies: use.companies, status: use.companies.length === 1 ? "named" : "multiple", from: use.from, evidence: use.evidence.slice(0, 3) };
}
