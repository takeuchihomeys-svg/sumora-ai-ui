// app/lib/contract-terms-question.ts（純関数・DB/ネットに触れない）
// お客様が送った物件の「契約条件」（礼金・敷金・フリーレント・保証会社・保証人・入居時期／退去予定・駐車場・管理会社）を聞いた時に、
// 資料（property_pickups.terms / image_lines / pdf_text・image_details.lines）の該当の所だけ読んで、本文で答えてよいか／AIX【確認した】かを決める。
//
// 2026-10-08 竹内（8巡目）「資料に書いてある事は返信の本文で答えて良い（大丈夫 答えて良い）」
//   礼金・敷金・フリーレント・保証会社・退去予定日・駐車場・保証人不要（緊急連絡先で審査）・管理会社（元付）など。
//   設備（equipment-question.ts）・手続き（procedure-question.ts）と同じ形: 質問の種類を純関数で判定 → 対象の物件 → 資料の該当の所だけ。
//   資料に無い事は今まで通り AIX【物件確認した／確認した】。
//   証拠（scripts/audit-r8-contract-terms.ts）: スタッフの手打ち 60日で礼金212通・退去120・保証会社46・フリーレント30・駐車場21・緊急連絡先15。
import { readMoveInMaterial } from "./procedure-question";
import { guarantorFromMaterial } from "./guarantor-material";
import { GUARANTOR_TYPE_SHORT } from "./guarantor-companies";
import type { StaffFreeRentFact } from "./staff-free-rent";

export type ContractTermTopic =
  | "key_money" | "deposit" | "free_rent" | "guarantor_company" | "guarantor_person" | "move_in" | "parking" | "management_company";

export const CONTRACT_TERM_LABEL: Record<ContractTermTopic, string> = {
  key_money: "礼金", deposit: "敷金", free_rent: "フリーレント", guarantor_company: "保証会社", guarantor_person: "保証人",
  move_in: "入居時期・退去予定", parking: "駐車場", management_company: "管理会社",
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. 質問の検出（1文ずつ・質問の形がある文だけ）
// ═════════════════════════════════════════════════════════════════════════════

// 2026-10-08 実物（scripts/audit-r8-contract-terms.ts・90日）で読んだ事: 語だけで拾うと多くは「この物件の値」の質問ではない
//   ＝交渉（礼金どうにもならない／下げる／フリーレントつけれる）・条件の言い直し（敷金礼金なしの物件は少ない？）・一般の意味（保証会社というのは）・
//   近くの駐車場（会社の事実）・SUUMO の URL の「FR301」。→ 項目ごとに「値を聞く形」が語の近くにある文だけ。交渉・探す・意味は外す。
const TOPIC_RES: Array<[ContractTermTopic, RegExp]> = [
  ["key_money", /礼金[^。\n]{0,10}(?:いくら|何ヶ月|何か月|かかり|かかる|必要|要り|いります|あります|ある\?|ですか|でしょうか|は\?)/],
  ["deposit", /(?:敷金|保証金)[^。\n]{0,10}(?:いくら|何ヶ月|何か月|かかり|かかる|必要|要り|いります|あります|ある\?|ですか|でしょうか|は\?)/],
  ["free_rent", /フリーレント[^。\n]{0,10}(?:あり|有り|ある|付い|つい|付き|つき|ですか|でしょうか|何ヶ月|何か月|適用)/],
  ["guarantor_company", /保証会社[^。\n]{0,8}(?:どこ|どちら|何|なに|どの|名前)|(?:どこ|どちら)[^。\n]{0,6}保証会社|保証料[^。\n]{0,8}(?:いくら|何%|何パーセント|どれ|何円)/],
  ["guarantor_person", /保証人[^。\n]{0,6}(?:不要|なし|無し|いら|必要|要り|要る|いります|なくて|無くて)|緊急連絡先(?:のみ|だけ)/],
  ["move_in", /退去予定日?[^。\n]{0,8}(?:いつ|何日|何月)|(?:いつ|何日|何月)[^。\n]{0,8}(?:から)?[^。\n]{0,6}(?:入居|住め|入れ|空く|空き|退去|引っ?越せ)|入居(?:可能)?(?:日|時期)[^。\n]{0,6}(?:いつ|何日|何月|ですか|でしょうか|分かり|わかり|決まって)|内覧(?:可能|でき)[^。\n]{0,4}(?:日|時期)[^。\n]{0,6}(?:いつ|ですか|でしょうか)/],
  ["parking", /(?:駐車場|駐輪場|バイク置き?場)[^。\n]{0,10}(?:あり|有り|ある|付い|つい|空き|空いて|いくら|料金|何台|ござい|でしょうか|ですか)|(?:車|バイク)[^。\n]{0,6}(?:停め|止め|置け)[^。\n]{0,6}(?:ますか|れますか|る\?|ますでしょうか)/],
  ["management_company", /管理会社[^。\n]{0,8}(?:どこ|どちら|何|なに|どの|名前)|(?:どこ|どちら)[^。\n]{0,6}管理会社|元付[^。\n]{0,6}(?:どこ|どちら)/],
];
/** 交渉（下げる・付けられるか）・探す条件・一般の意味の文は「資料の値の質問」ではない（交渉の結果はスタッフだけが知る＝AIX） */
const NOT_MATERIAL_RE = /物件(?:で|を|は|が)?(?:何か)?(?:あり|探|ない|無い)|(?:マンション|アパート)(?:は|って|で)?(?:あり|ござい)|お部屋(?:で|を)?(?:あり|探)|希望|条件|であれば|なら|がいい|が良い|下げ|下が|安く|交渉|減額|値引|値下|調整|どうにも|どうにか|つけれ|つけられ|付けれ|付けられ|なくせ|無くせ|免除|物件(?:は|って|が)?(?:少な|多)|件数|探して|探し|お部屋(?:は|って)?少な|というのは|とは\?|って何|ってなん|危な|近く|近隣|周辺|変更|早め|遅ら/;
/** お客様が送った画像の書き起こし（「物件名：…」「敷金：…」の項目の行・# 見出し）・条件／申込のフォーム（①【…】⇒…）は質問の文ではない */
/** 聞く形（条件のリスト「駐車場あり」「保証人なし」は質問ではない） */
const QUESTION_FORM_RE = /[？?]|ですか|ますか|でしょうか|ですかね|ますかね|いくら|教えて|知りたい|でしたっけ|分かります|わかります/;
const FORM_OR_OCR_LINE_RE =/[:：⇒]|【|^\s*(?:[①-⑳・\-*#]|\[画像\])/;

/** お客様の文が聞いている契約条件の項目（無ければ空） */
export function detectContractTermTopics(text: string | null | undefined): ContractTermTopic[] {
  const t = String(text ?? "").normalize("NFKC");
  if (!t.trim()) return [];
  const sentences = t.split(/(?<=[。！!？?\n])/)
    .filter((s) => QUESTION_FORM_RE.test(s) && !/https?:\/\//.test(s) && !FORM_OR_OCR_LINE_RE.test(s) && !NOT_MATERIAL_RE.test(s));
  const out: ContractTermTopic[] = [];
  for (const [topic, re] of TOPIC_RES) {
    if (sentences.some((s) => re.test(s))) out.push(topic);
  }
  return out;
}

/**
 * 9巡目（10/08・8巡目の残り）: 送った物件を指して契約条件を聞いた番（「ここ駐車場ありますか？？」）か。
 *   YUMA（七道駅前マンション・資料に駐車場なし）でブレイン（DeepSeek）が「駐車場付きの物件を探す」＝物件送付／オススメを選び、
 *   2段（pickup）で「ご条件に合ったお部屋ピックアップ」の約束になった（資料の答えが本文に入らない）。
 *   実送信（scripts/audit-r8-contract-terms.ts --topic=parking・180日 22番）: 物件を指した駐車場の質問に、ピックアップの約束だけで返した番は 0。
 *   ピックアップの約束が入ったのは同じ連投で別の条件（「福島区、淀川区でお願いします。」）を言った 1番だけ → 条件の言い直しが同じ連投にある時は外す。
 *   true の時だけ、ブレインの物件の AIX（物件送付・オススメ・探す）を資料の答えの返信に倒す（brain-core・CONTRACT_TERMS_PICKUP_GUARD=off で戻す）。
 */
const POINTS_AT_PROPERTY_RE = /ここ|こちら|こっち|この|そこ|そちら|その/;
const CONDITION_CHANGE_RE = /[区市町]で|駅(?:で|周辺|近く|まで)|エリア|でお願いします|でお願い致します|探して|他に|ほかに|ほかの|他の|別の|広げ|以内|以下|万(?:円)?まで|条件/;
export function isTermsInquiryOnSentProperty(text: string | null | undefined): boolean {
  const t = String(text ?? "").normalize("NFKC");
  if (!detectContractTermTopics(t).length) return false;
  if (CONDITION_CHANGE_RE.test(t)) return false;
  return POINTS_AT_PROPERTY_RE.test(t);
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. 資料を読む（文字のまま・足さない）
// ═════════════════════════════════════════════════════════════════════════════

/** 資料（売上サポの読み取り terms・資料の行・文字層） */
export type ContractMaterial = {
  /** property_pickups.terms（pickup-terms の結果。無ければ null） */
  terms?: {
    deposit?: number | null; keyMoney?: number | null; freeRent?: { months?: number | null; label?: string | null } | string | number | null;
    evidence?: Record<string, string | null | undefined> | null;
  } | null;
  /** property_pickups.image_lines／image_details.lines（「項目: 値」） */
  lines?: ReadonlyArray<string | null | undefined> | null;
  /** property_pickups.pdf_text（リアプロの文字層） */
  pdfText?: string | null;
  /** この物件についてスタッフが送った文のフリーレント（staff-free-rent.staffFreeRentFor）。フリーレントはこれだけを根拠にする */
  staffFreeRent?: StaffFreeRentFact | null;
};

export type ContractRoute = {
  topic: ContractTermTopic;
  /** material＝資料の文字で本文で答えてよい／confirm＝資料に無い・言い切れない → AIX【確認した】 */
  route: "material" | "confirm";
  /** 資料の文字（そのまま） */
  facts: string[];
  /** なぜその道か（ログ・監査・プロンプト用の短い語） */
  why: string;
};

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const EMPTY_RE = /^(?:[ーｰ\-－—]|不明|記載なし)?$/;
function linesOf(lines: ReadonlyArray<string | null | undefined> | null | undefined, head: RegExp): string[] {
  return (lines ?? []).map((l) => clean(String(l ?? ""))).filter((l) => head.test(l) && !EMPTY_RE.test(l.replace(/^[^:：]+[:：]\s*/, "")));
}
/** 文字層の「敷金 なし」「礼金 1ヶ月」の行（リアプロの表）。見出しの直後の値だけ */
function pdfRow(pdf: string | null | undefined, head: RegExp): string | null {
  const t = String(pdf ?? "");
  if (!t) return null;
  for (const raw of t.split(/\n/)) {
    const l = clean(raw);
    const m = l.match(head);
    if (!m || m.index !== 0) continue;
    const v = clean(l.slice(m[0].length));
    if (v && !EMPTY_RE.test(v)) return l;
  }
  return null;
}
/** 文字層の中の「フリーレント」を含む文（備考・特記事項） */
function pdfMentions(pdf: string | null | undefined, re: RegExp, max = 2): string[] {
  const t = String(pdf ?? "").replace(/\n(?=[^\n【■●◇□※・])/g, "");
  const out: string[] = [];
  for (const raw of t.split(/\n|(?<=。)/)) {
    const l = clean(raw);
    if (re.test(l) && l.length <= 120) out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

const monthsLabel = (n: number) => (n === 0 ? "なし（0円）" : `${n}ヶ月`);

/**
 * 項目ごとの道。言い切れるのは資料に「書いてある値」だけ。
 *   ・礼金・敷金: terms の数値（0＝なし）か、文字層の「礼金 …」の行
 *   ・フリーレント: terms.freeRent か文字層の「フリーレント」の文（無い時は「記載なし」＝確認。資料に無い＝無いとは言わない）
 *   ・保証会社: 資料の「保証会社: …」の行（会社名・初回保証料）
 *   ・保証人: 資料の「連帯保証人: 保証人不要／原則不要」等（不要の時は緊急連絡先で審査）。「必須／相談」は確認
 *   ・入居時期・退去予定: procedure-question.readMoveInMaterial（即入居・日付は資料のまま／退去予定で日付なし・相談・未定は確認）
 *   ・駐車場: 資料の「駐車場: …」（「なし」は言い切る／空き・料金ありも資料のとおりに答える＝空きの最終確認は申込時）
 *   ・管理会社: 資料に書いてある会社名（リアプロの元付＝文字層の上の会社名）
 */
export function routeContractTerm(topic: ContractTermTopic, m: ContractMaterial): ContractRoute {
  const terms = m.terms ?? null;
  const ev = terms?.evidence ?? {};
  const lines = m.lines ?? [];
  if (topic === "key_money" || topic === "deposit") {
    const key = topic === "key_money" ? "keyMoney" : "deposit";
    const label = topic === "key_money" ? "礼金" : "敷金";
    const num = terms ? (terms as Record<string, unknown>)[key] : null;
    const row = pdfRow(m.pdfText, topic === "key_money" ? /^礼金\s*/ : /^敷金\s*/);
    const evText = typeof ev[key] === "string" ? String(ev[key]) : null;
    const lineHit = linesOf(lines, topic === "key_money" ? /^礼金\s*[:：]/ : /^敷金\s*[:：]/);
    const facts = [row ?? evText ?? lineHit[0] ?? null].filter((x): x is string => !!x);
    if (typeof num === "number" && Number.isFinite(num)) {
      return { topic, route: "material", facts: facts.length ? facts : [`${label} ${monthsLabel(num)}`], why: `資料に${label}の記載` };
    }
    if (facts.length) return { topic, route: "material", facts, why: `資料に${label}の記載` };
    return { topic, route: "confirm", facts: [], why: `資料に${label}の記載なし` };
  }
  if (topic === "free_rent") {
    // 2026-10-08 竹内（最優先）「フリーレントは全部の物件につくわけではない。資料の項目を間違えて読み取る可能性…スタッフが AIX で入れていたらフリーレント」:
    //   資料（terms.freeRent・pdf_text・image_lines）からは読まない。この会話でスタッフが送った文に書いた物件だけ（staff-free-rent.ts）
    const f = m.staffFreeRent ?? null;
    if (f?.kind === "yes") return { topic, route: "material", facts: [`スタッフの送付: ${f.phrase}`], why: "スタッフがフリーレントを送った物件" };
    if (f?.kind === "negotiable") return { topic, route: "material", facts: [`スタッフの送付: ${f.phrase}`], why: "スタッフがフリーレント相談可と送った物件（付くとは言い切らない）" };
    if (f?.kind === "none") return { topic, route: "material", facts: [`スタッフの送付: ${f.phrase}`], why: "スタッフがフリーレントなしと送った物件" };
    return { topic, route: "confirm", facts: [], why: "スタッフがフリーレントを送っていない物件（資料からは読まない・付くとも無いとも言わない）" };
  }
  if (topic === "guarantor_company") {
    // 会社名の読み方は AIX【保証会社について】の先入れと同じ1本（guarantor-material.ts・見出しの直後だけ・読み取り行より文字層）
    const g = guarantorFromMaterial({ pdfText: m.pdfText ?? null, lines: (lines ?? []).map((l) => String(l ?? "")) });
    if (g.status === "named") {
      const c = g.companies[0];
      return { topic, route: "material", facts: [`${c.name}${c.type && c.type !== "unknown" ? `（${GUARANTOR_TYPE_SHORT[c.type]}）` : ""}`, ...g.evidence.slice(0, 1)], why: "資料に保証会社の記載" };
    }
    if (g.status === "multiple") return { topic, route: "material", facts: [g.companies.map((c) => c.name).join("・"), ...g.evidence.slice(0, 1)], why: "資料に保証会社が複数（審査の順・条件は資料のまま）" };
    return { topic, route: "confirm", facts: g.evidence.slice(0, 1), why: g.status === "unnamed" ? "資料は保証会社の利用だけ（会社名なし）" : "資料に保証会社の記載なし" };
  }
  if (topic === "guarantor_person") {
    const hit = [...linesOf(lines, /^連帯保証人\s*[:：]/), ...linesOf(lines, /^入居条件\s*[:：].*保証人不要/)].slice(0, 2);
    const v = hit.join(" ");
    if (/保証人不要|原則不要|不要/.test(v) && !/必須|必要/.test(v.replace(/保証会社利用必須/g, ""))) {
      return { topic, route: "material", facts: hit, why: "資料に保証人不要の記載（緊急連絡先で審査）" };
    }
    return { topic, route: "confirm", facts: hit, why: hit.length ? "資料は保証人が必須・相談" : "資料に保証人の記載なし" };
  }
  if (topic === "move_in") {
    const mv = readMoveInMaterial(lines.length ? lines : (ev.moveIn ? [`現況/入居時期: ${ev.moveIn}`] : []));
    if (mv.kind === "immediate" || mv.kind === "date") return { topic, route: "material", facts: mv.lines, why: mv.kind === "immediate" ? "資料に即入居の記載" : "資料に入居可能日の記載" };
    // 退去予定の日付（「退去予定: 10/31」「現況: 退去予定(9/30)」）は資料のまま
    const outDate = mv.lines.find((l) => /退去予定[^0-9０-９]{0,4}[(（]?\s*(?:\d{4}年)?\d{1,2}\s*[月/]\s*(?:\d{1,2}|[上中下]旬)/.test(l.normalize("NFKC")));
    if (outDate) return { topic, route: "material", facts: mv.lines, why: "資料に退去予定日の記載" };
    return { topic, route: "confirm", facts: mv.lines, why: mv.kind === "leaving" ? "退去予定・居住中で日付が資料に無い" : mv.lines.length ? "資料の入居時期が相談・未定" : "資料に入居時期の記載なし" };
  }
  if (topic === "parking") {
    const hit = linesOf(lines, /^(?:駐車場|バイク置場|駐輪場)\s*[:：]/);
    const row = pdfRow(m.pdfText, /^駐車場\s*/);
    // リアプロの表は「なし 駐車場」（値が見出しの前）の形もある
    const pre = /(?:^|\n)\s*(なし|無し|有り?|空き?有?|[0-9,]+円[^\n]{0,20})\s+駐車場\s*(?:\n|$)/.exec(String(m.pdfText ?? ""));
    // 値が駐車場の形（なし・空き・円・台・あり）の行だけ（読み取りの取り違え「駐車場: エスリード建物管理株式会社」を答えにしない）
    const facts = [...hit, ...(row ? [row] : []), ...(pre ? [`駐車場 ${pre[1]}`] : [])]
      .filter((f) => /なし|無し|無|空|円|台|あり|有|可|不可|区画/.test(f.replace(/^[^:：\s]+[:：\s]\s*/, ""))).slice(0, 2);
    if (facts.length) return { topic, route: "material", facts, why: "資料に駐車場の記載" };
    return { topic, route: "confirm", facts: [], why: "資料に駐車場の記載なし" };
  }
  // management_company
  const hit = linesOf(lines, /^(?:管理会社|元付|取扱会社|貸主)\s*[:：]/);
  if (hit.length) return { topic, route: "material", facts: hit, why: "資料に管理会社の記載" };
  const moto = motodukeOfPdf(m.pdfText);
  if (moto) return { topic, route: "material", facts: [`元付: ${moto}`], why: "資料に元付（管理会社）の記載" };
  return { topic, route: "confirm", facts: [], why: "資料に管理会社の記載なし" };
}

/** 弊社（資料の奇数ページの帯＝蓮産業）。元付として数えない */
const OWN_COMPANY_RE = /蓮産業/;
const COMPANY_SHAPE_RE = /株式会社|有限会社|\(株\)|（株）|合同会社|コーポレーション|Corporation|CO\.,?\s*LTD/i;
/**
 * リアプロの資料の文字層: 各ページの頭は「〜免許(n)第…号 …協会」の次の行が会社名。奇数ページは弊社の帯・偶数ページが元付（feedback_pickup_material_verbatim）。
 *   弊社以外で会社の形の行の最初の1つ（「エスリード賃貸株式会社」「株式会社TAPP」）。支店名（大阪支社 等）はそのまま
 *   （2026-10-08 売上サポの直近40行: 弊社の帯だけ 7行（元付の帯が無い）・元付あり 32行・免許の次が住所の様式 1行＝拾わない）
 */
export function motodukeOfPdf(pdf: string | null | undefined): string | null {
  const ls = String(pdf ?? "").split(/\n/).map((l) => l.trim());
  for (let i = 0; i < ls.length - 1; i++) {
    if (!/免許/.test(ls[i]) || !/協会|免許\s*\(|知事|大臣/.test(ls[i])) continue;
    const next = ls[i + 1];
    if (!next || OWN_COMPANY_RE.test(next) || !COMPANY_SHAPE_RE.test(next) || next.length > 40 || /[:：]|必須|証明書|契約/.test(next)) continue;
    return next.replace(/\s+/g, " ");
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. ブレイン・返信生成に渡す1ブロック
// ═════════════════════════════════════════════════════════════════════════════

export type ContractTarget = { name: string; roomNo: string | null };
const targetLabel = (t: ContractTarget) => `${t.name}${t.roomNo ? ` ${t.roomNo}` : ""}`;

/** 聞かれた項目がすべて資料で答えられるか（1つでも確認が要れば false） */
export function contractTermsAllInMaterial(routes: readonly ContractRoute[]): boolean {
  return routes.length > 0 && routes.every((r) => r.route === "material");
}

/** 項目ごとの答え方の注（スタッフの実送信の多数派の形・scripts/audit-r8-contract-terms.ts） */
// 180日の質問の番（scripts/audit-r8-contract-terms.ts --days=180）でスタッフが資料・確認の結果を答えた文の形:
//   駐車場「駐車場、月額9,900円（税込）で空き9台ございます！！」／無い時「こちらの物件は駐車場がございませんので、近隣の月極駐車場をお探し頂く形となります！！」
//   管理会社「お部屋管理会社は株式会社TAPPという会社となります！！」／保証会社「アベニュー西長居201号室の保証会社が全保連となります！！」
//   保証人「最初の審査時は緊急連絡先様での審査が可能です😊！！」／退去予定「レジュールアッシュ難波MINAMIは6月末退去予定のお部屋となります！！」
//   フリーレント「はい！！こちらもフリーレントとなります！！ご入居後1ヶ月分の賃料免除となります！」
const HOW: Record<ContractTermTopic, string> = {
  key_money: "「敷金礼金なしのお部屋となります😊！！」「礼金〇ヶ月のお部屋となります！！」の形（資料の値のまま。手打ち90日で礼金の文 293 のうち値を言う文は「敷金礼金なし／N円」の形が主）",
  deposit: "「敷金礼金なしのお部屋となります😊！！」「敷金〇ヶ月のお部屋となります！！」の形（資料の値のまま）",
  free_rent: "スタッフの送付のとおり（月数・期限・条件を足さない）。内容が無い時の基本の形は「ご入居後1ヶ月分の家賃が無料となります」。相談可と送った物件は「フリーレントご相談可能なお部屋となります」（付くと言い切らない）",
  guarantor_company: "「〇〇号室の保証会社が〇〇となります！！」の形（資料の会社名のまま。審査の通りやすさは言い切らない）",
  guarantor_person: "「最初の審査時は緊急連絡先様での審査が可能です😊！！」の形（緊急連絡先＝電話のみ・支払い義務なし）",
  move_in: "「〇〇は〇月〇日退去予定のお部屋となります！！」「即入居可能なお部屋となります！！」の形（資料の文字のまま。早めない・足さない）",
  parking: "有る時「駐車場、月額〇円で空きございます！！」（資料に空き・料金がある時だけその値）／無い時「こちらの物件は駐車場がございませんので、近隣の月極駐車場をお探し頂く形となります！！」。資料に料金だけで空きの記載が無ければ、空きは確認すると添える",
  management_company: "「お部屋管理会社は〇〇という会社となります！！」の形（資料の会社名のまま）",
};

export function buildContractTermsNote(target: ContractTarget | null, routes: readonly ContractRoute[]): string {
  if (!target || routes.length === 0) return "";
  const out: string[] = [`【📄 お客様が聞いた契約条件（対象: ${targetLabel(target)}）— 資料に書いてある事は本文で答えてよい／無い事は AIX【確認した】】`];
  for (const r of routes) {
    out.push(r.route === "material"
      ? `- ${CONTRACT_TERM_LABEL[r.topic]}: 資料に記載あり（文字のまま）「${r.facts.join("／")}」→ **本文で資料のとおりに答える**。${HOW[r.topic]}`
      : `- ${CONTRACT_TERM_LABEL[r.topic]}: 資料では答えられない（${r.why}${r.facts.length ? `: ${r.facts.join("／")}` : ""}）→ 本文で断言しない。管理会社に確認して AIX【確認した（条件・交渉）】で答える`);
  }
  out.push("→ 資料の値は書いてある文字のまま使う（月数・金額・日付を足さない・丸めない）。資料に無い項目を「無い」と言わない。");
  // 9巡目（10/08・8巡目の残り）: 礼金の番で最後の Claude が頼まれていない「最大限割引させて頂いた初期費用の御見積書を作成しお送り…」を足した。
  //   実送信（scripts/audit-r8-contract-terms.ts・365日 契約条件の質問 45番の手打ち）で見積書の約束を書いたのは 2通＝どちらもお客様が「含めて見積もり」を頼んだ番。
  //   出所の候補は学習ルール DIFF-POLICY-FULL-2c07f321（金額の質問→見積書の予告）。項目の質問は見積の依頼ではない → 聞かれた項目だけ答える。戻す CONTRACT_TERMS_NO_EXTRA_PROMISE=off
  if ((typeof process === "undefined" || (process.env?.CONTRACT_TERMS_NO_EXTRA_PROMISE ?? "").toLowerCase() !== "off") && routes.some((r) => r.route === "material")) {
    out.push("→ 聞かれた項目だけ答える。お客様が初期費用・見積を頼んでいない時は「御見積書を作成しお送り」「募集状況確認させて頂きます」等の約束を足さない（礼金・敷金・保証会社・駐車場の質問は見積の依頼ではない）。");
  }
  return out.join("\n");
}
