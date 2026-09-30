// app/lib/aix-material-facts.ts
// AIX の文と「資料の事実」を突き合わせる材料と出口（純関数・DB 依存なし）。
//
// 2026-09-27 竹内さん「重い順から治す」（YUMA の徹底テストで見つかった物）:
//   ① 物件ピックアップの文に「大阪市北区・福島区から」と書いたのに、送った20件はどれも北区・福島区ではなく注意も出なかった
//      → 送る物件の所在地（資料の文字＝property_pickups.location.ward／pdf_text の「所在地」）から区を取り、文作りに渡す。
//        文の区が送る物件の区を1つも含まない時は注意（本文は書き換えない＝誤削除0の条件を満たせないため出口は注意だけ）
//   ② 物件オススメの文に「空室のため即入居可能」。資料は「現況/入居時期 空室 / 相談」「※入居可能日未定」。
//      次の AIX【物件確認した】にも同じ言葉が写った（前にこちらが送った文を、確かめた事実のように使った）
//      → 資料の入居時期を渡す・「即入居」等が資料と合わない時は注意（文は書き換えない）。
//        履歴のこちらの文にある「即入居」は確かめた事実ではない旨を入口で添える
//   ③ 物件確認した（募集中）の文が「募集に出ていない／他の52件も募集終了」と逆の内容
//      → 送られた物件数（画面のセレクター 1〜5）の外の値は使わない・状態（ピッカー）と逆の文は注意を出して止める
//
// 監査: scripts/audit-aix-material-facts.ts（実送信の過去分に当てて前後を目で読む）
import { wardOfAddress, wardsInText } from "./osaka-geo";
import { normalizePropertyName, similarity } from "./property-name-match";

// ═════════════════════════════════════════════════════════════════════════════
// ① 送る物件の区（ピックアップの地域）
// ═════════════════════════════════════════════════════════════════════════════

export type PickupMaterialRow = {
  location?: { ward?: string | null } | null;
  pdf_text?: string | null;
  terms?: { moveIn?: { kind?: string | null; current?: string | null } | null } | null;
  image_lines?: readonly string[] | null;
};

/** 資料の「所在地」の次の行（リアプロ・itandi の資料の全文）。無ければ null */
export function addressOfPdfText(pdfText: string | null | undefined): string | null {
  const t = String(pdfText ?? "");
  const m = t.match(/所在地[ \t]*\n?[ \t]*([^\n]+)/);
  const v = m?.[1]?.trim();
  return v && v.length >= 3 ? v : null;
}

/** 送る物件の区・市（「大阪市浪速区」「吹田市」）。保存した位置の読み取り → 資料の所在地の順。分からなければ null */
export function wardOfPickupRow(row: PickupMaterialRow): string | null {
  const saved = row.location?.ward?.trim();
  if (saved) return saved;
  return wardOfAddress(addressOfPdfText(row.pdf_text));
}

/** 区の短い言い方（「大阪市浪速区」→「浪速区」・「吹田市」はそのまま） */
export const shortWard = (w: string) => w.replace(/^(?:大阪市|堺市)(?=.+区$)/, "");

/** 物件を送る導入の行（区を書く行）。物件ピックアップの文の芯 */
const PICKUP_LINE_RE = /ピックアップ|募集に(?:で|出)ました/;

/** 文の導入の行に書かれた区・市（無ければ空） */
export function wardsInPickupLine(text: string): string[] {
  const out = new Set<string>();
  for (const line of String(text ?? "").split("\n")) {
    if (!PICKUP_LINE_RE.test(line)) continue;
    for (const w of wardsInText(line)) out.add(w.ward);
  }
  return [...out];
}

/**
 * 出口（注意だけ）: 文の導入の行に書いた区・市が、今回送る物件の区・市を1つも含まない。
 * 区の分かる物件が無い・文に区が無い（駅名・「周辺」だけ）時は何も言わない（判定できない）
 */
export function findPickupAreaConflict(text: string, sendWards: readonly (string | null | undefined)[]): string | null {
  const facts = [...new Set(sendWards.filter((w): w is string => !!w))];
  if (facts.length === 0) return null;
  const written = wardsInPickupLine(text);
  if (written.length === 0) return null;
  if (facts.some((w) => written.includes(w))) return null;
  return `文の地域（${written.map(shortWard).join("・")}）に、今回お送りする物件（${facts.map(shortWard).join("・")}）が1件も入っていません。地域を直すか消してから送信してください`;
}

/** 生成に渡す「今回の物件の区」の一文（区の分かる物件が無ければ空） */
export function buildPickupWardNote(sendWards: readonly (string | null | undefined)[], total: number): string {
  const known = sendWards.filter((w): w is string => !!w);
  if (known.length === 0) return "";
  const counts = new Map<string, number>();
  for (const w of known) counts.set(w, (counts.get(w) ?? 0) + 1);
  const list = [...counts.entries()].map(([w, n]) => `${shortWard(w)}${n > 1 ? `${n}件` : ""}`).join("・");
  return [
    `【今回お送りする物件の所在地（資料の所在地から・${known.length}/${total}件）】${list}`,
    "→ 地域（区・市）を書くなら、今回の物件の所在地と合う区だけ。希望条件・会話・前回の送付の地域に今回の物件の区が1つも入っていない時は、その地域を書かない（今回の物件と違う地域を書くのは誤り）。",
  ].join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// ② 入居時期（即入居）
// ═════════════════════════════════════════════════════════════════════════════

/** 文の「即入居」の言い方（即入居可能・即日入居・すぐにご入居頂けます） */
export const IMMEDIATE_MOVE_IN_RE = /即入居|即日入居|即入(?!力)|すぐ(?:に)?(?:ご)?入居(?:頂|いただ|でき|可能|出来)/;

export type MoveInFact = {
  /** 資料の文字のまま（「空室 / 相談」「入居可能日: 未定」） */
  lines: string[];
  /** 資料に即入居の記載がある（「即入」「即入居可」「即時」） */
  immediate: boolean;
};

/**
 * 資料の入居時期（書く所は資料の文字のまま）。pdf_text の「現況/入居時期」・備考の「入居可能日」、
 * 無ければ画像の読み取り（image_lines の「現況」「入居可能日」「退去予定」）、無ければ terms.moveIn の種類。
 * どれも無ければ null（分からない＝注意も出さない）
 */
export function moveInFactOfPickup(row: PickupMaterialRow): MoveInFact | null {
  const lines: string[] = [];
  const pdf = String(row.pdf_text ?? "");
  // 資料は弊社帯（奇数ページ）と元付（偶数ページ）で同じ表が2回出る → 最初の1回だけ
  const cur = pdf.match(/現況\s*\/\s*入居時期[ \t]*\n?[ \t]*([^\n]+)/)?.[1]?.trim();
  if (cur) lines.push(`現況/入居時期 ${cur}`);
  const it = pdf.match(/入居可能時期[ \t]*\n?[ \t]*([^\n]+)/)?.[1]?.replace(/\s*(?:契約期間|解約予告).*$/, "").trim();
  if (it) lines.push(`入居可能時期 ${it}`);
  const note = pdf.match(/[※＊*]?\s*入居(?:可能)?日[^\n]{0,4}?(未定|相談|調整中|[0-9０-９]{1,4}年?[0-9０-９]{1,2}月[^\n]{0,8})/);
  if (note) lines.push(note[0].trim());
  if (lines.length === 0) {
    for (const l of row.image_lines ?? []) {
      if (/^\s*(?:現況|入居可能日|入居時期|退去予定)\s*[:：]/.test(String(l))) lines.push(String(l).trim());
    }
  }
  const kind = row.terms?.moveIn?.kind ?? null;
  if (lines.length === 0 && !kind) return null;
  const all = lines.join(" ");
  // 即入居と読むのは資料に「即入・即時・即日」がある時だけ（「空室」だけ・「相談」は即入居ではない）。「未定」が並ぶ時は即入居にしない
  const immediate = lines.length === 0 ? kind === "immediate" : /即入|即時|即日/.test(all) && !/未定/.test(all);
  return { lines: lines.length ? lines : [`入居時期の種類: ${kind}`], immediate };
}

/** 生成に渡す入居時期の一文（事実が無ければ空） */
export function buildMoveInFactNote(fact: MoveInFact | null): string {
  if (!fact) return "";
  return [
    `【この物件の入居時期（資料の文字のまま）】${fact.lines.join("／")}`,
    fact.immediate
      ? "→ 資料に即入居の記載あり。入居時期を書くなら資料のとおり。"
      : "→ 資料に即入居の記載は無い（「空室」だけでは即入居ではない）。「即入居可能」「すぐにご入居頂けます」等は書かない。入居時期に触れるなら資料の文字のまま。",
  ].join("\n");
}

/**
 * 出口（注意だけ）: 文に「即入居」等があるのに、資料の入居時期に即入居の記載が無い。
 * fact が無い（資料の入居時期が分からない）時は何も言わない
 */
export function findMoveInClaimConflict(text: string, fact: MoveInFact | null): string | null {
  if (!fact || fact.immediate) return null;
  const line = String(text ?? "").split("\n").find((l) => IMMEDIATE_MOVE_IN_RE.test(l));
  if (!line) return null;
  const word = line.match(IMMEDIATE_MOVE_IN_RE)?.[0] ?? "即入居";
  return `文の「${word}」は資料の入居時期（${fact.lines.join("／")}）と合いません。消すか資料の文字に直してから送信してください`;
}

/**
 * 出口（注意だけ）: AIX【物件確認した】の文の「即入居」に、今回の入力（入居可能日・スタッフの補足・資料）の根拠が無い。
 * 実送信の物件確認した（募集中）179通で「即入居」を書いた通は0（2026-07-09〜09-27・YUMA を除く）
 */
export function findCheckResultMoveInClaim(text: string, basisTexts: readonly (string | null | undefined)[]): string | null {
  const line = String(text ?? "").split("\n").find((l) => IMMEDIATE_MOVE_IN_RE.test(l));
  if (!line) return null;
  if (basisTexts.some((b) => IMMEDIATE_MOVE_IN_RE.test(String(b ?? "")) || /即入|即時/.test(String(b ?? "")))) return null;
  const word = line.match(IMMEDIATE_MOVE_IN_RE)?.[0] ?? "即入居";
  return `文の「${word}」は今回の確認結果・入力に根拠がありません（前にこちらが書いた文の写しの可能性）。消すか確かめてから送信してください`;
}

/** 履歴のこちらの文に「即入居」があるか（その時は下の一文を履歴の後ろに添える） */
export function hasStaffMoveInClaim(rows: ReadonlyArray<{ sender: string; text: string }>): boolean {
  return rows.some((r) => r.sender === "staff" && IMMEDIATE_MOVE_IN_RE.test(r.text ?? ""));
}
export const PAST_MOVE_IN_CLAIM_NOTE = "【履歴のこちらの文の入居時期の扱い】履歴でこちらが前に書いた「即入居可能」等の入居時期は、今回の入力（資料・確認結果・入居可能日）で確かめた事実ではない。入居時期は今回の入力にある時だけ書く（履歴から写さない）";

// ═════════════════════════════════════════════════════════════════════════════
// ③ 物件確認した（募集中）の件数と状態
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 送られた物件数（画面のセレクターは 1〜5）。範囲外・整数でない値は使わない（null）。
 * 2026-09-27 YUMA: お客様役が会話の送付物件数（約53）を入れ、「他の52件も募集終了」が作られた。
 * 5 に丸めると「他4件は募集終了」をまた作るので、丸めずに捨てる
 */
export function sanitizeSentPropertyCount(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5 ? v : null;
}

/** 募集していない・申込ありを言う語 */
const NOT_OPEN_RE = /募集に(?:出て|でて)(?:い|お)(?:ない|りません)|募集(?:が|は|を)?終了|募集(?:して|されて)(?:い|お)(?:ない|りません)|募集停止|成約(?:済|し)|埋まって|空きが(?:ない|無い|ありません|ございません)|ご紹介(?:が|は)?(?:でき|出来)(?:ない|ません)/;
const APPLIED_RE = /[1１一]番手|[2２二]番手|申込(?:み)?(?:が|は)?(?:入って|入り|あり|済)|お申込みが入っ/;
const OPEN_RE = /募集中|空室(?:です|となり|のお部屋)|ご案内(?:出来|でき)/;
const OTHERS_COUNT_RE = /他(?:の)?\s*([0-9０-９]+)\s*件/;
const toNum = (s: string) => parseInt(s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)), 10);
const nameKey = (s: string) => s.normalize("NFKC").replace(/[\s　・･]/g, "").toLowerCase();

/**
 * 出口（注意を出して止める）: 物件確認した（募集中）で、状態（ピッカー）と逆の文。
 *   ・確認した物件（property_names）を名指しして「募集に出ていない・募集終了」と書いた（その物件の状態が募集中の時）
 *   ・全部「募集中」なのに、文のどこにも募集中が無く「募集していない」とだけ書いた（YUMA 9/27 04:40: 名前も別の物件）
 *   ・「他N件は募集終了」の N が、送られた物件数（画面 1〜5）−確認した件数と違う（入力が無ければ他N件は書けない）
 *   ・申込ありでない物件を名指しして「1番手・2番手・申込が入って」と書いた
 * 確認した物件でない物（「松屋町1LDK2階のお部屋は募集終了」「1階のお部屋は募集に出ておりませんでした」）の募集終了は正しい報告なので止めない
 * （実送信・状態の記録あり64通で監査: scripts/audit-aix-material-facts.ts）。
 * 申込ありの判定は 9/21 から物件ごと（prop_statuses の unavailable）。それより前の画面は全体の申込状況だけ＝anyAppliedFlag。
 *   監査で止まった実送信 2通（f5e92bc6 9/10・51d8c5f8 9/2）はどちらも 9/21 より前の全体の申込状況の通。
 * endedCount が null＝送られた物件数が分からない（監査で過去の送信に当てる時）→ 他N件の数は見ない
 */
export function findCheckStatusContradiction(
  text: string,
  o: { pattern: string | null | undefined; statuses: readonly (string | null | undefined)[] | null | undefined; propertyCount: number; endedCount: number | null; propertyNames?: readonly (string | null | undefined)[] | null;
    /** 画面の全体の「申込状況」（旧 available_application=yes）。物件ごとの申込ありが無い旧画面の申込ありはこれで来る */
    anyAppliedFlag?: boolean },
): string | null {
  if (o.pattern !== "available") return null;
  const statuses = (o.statuses ?? []).slice(0, Math.max(1, o.propertyCount)).map((s) => s ?? "available");
  if (statuses.length === 0) return null;
  const names = (o.propertyNames ?? []).map((n, i) => ({ key: nameKey(String(n ?? "").replace(/\s*[0-9０-９]{1,4}[A-Za-z]?\s*(?:号室?)?\s*$/, "")), status: statuses[i] ?? "available" }))
    .filter((n) => n.key.length >= 3);
  const body = String(text ?? "");
  const lines = body.split("\n").map((s) => s.trim());
  const namedIn = (line: string) => names.filter((n) => nameKey(line).includes(n.key));
  const allOpen = statuses.every((s) => s === "available" || s === "vacating");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const ctx = i > 0 && !/[。！!]$/.test(lines[i - 1]) ? `${lines[i - 1]}${line}` : line;
    if (NOT_OPEN_RE.test(line)) {
      const named = namedIn(ctx).filter((n) => n.status === "available" || n.status === "vacating");
      if (named.length) return `文の「${line.slice(0, 40)}」: 確認結果は「募集中」の物件を、募集していないと書いています`;
      const oc = ctx.match(OTHERS_COUNT_RE);
      if (oc && o.endedCount !== null && toNum(oc[1]) !== o.endedCount) {
        return o.endedCount === 0
          ? `文の「${line.slice(0, 40)}」: 送られた物件数の入力が無いのに、他${toNum(oc[1])}件の募集終了を書いています`
          : `文の「${line.slice(0, 40)}」: 他${toNum(oc[1])}件と書いていますが、入力では残り${o.endedCount}件です`;
      }
    }
    if (APPLIED_RE.test(line) && !o.anyAppliedFlag) {
      const named = namedIn(ctx).filter((n) => n.status !== "unavailable");
      if (named.length) return `文の「${line.slice(0, 40)}」: 申込ありにしていない物件を、お申込み・番手ありと書いています`;
    }
  }
  if (allOpen && !OPEN_RE.test(body) && NOT_OPEN_RE.test(body)) {
    return "確認結果は「募集中」なのに、文に募集中が無く、募集していない内容だけになっています";
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// ⑤ 照合の辞書（sent-image-record.knownPropertyNames）
// ═════════════════════════════════════════════════════════════════════════════

export const STAR_HEAD_ROOM_RE = /^\s*🌟\s*([^\n🌟【】]{2,40}?)\s+[0-9０-９]{3,4}[A-Za-zＡ-Ｚ]?\s*$/;
/** 本文の1行目「🌟建物 0205」の建物名（号室の字なし・空白で区切った3〜4桁）。無ければ null */
export function starHeadBuilding(text: string | null | undefined): string | null {
  const first = String(text ?? "").split("\n").find((l) => l.trim().startsWith("🌟"));
  const m = first?.match(STAR_HEAD_ROOM_RE);
  return m ? m[1].trim() : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// ⑥ 物件オススメの見出し「🌟建物 号室」を資料の物件名に合わせる（出口の決定論）
// ═════════════════════════════════════════════════════════════════════════════
//
// 2026-09-30 YUMA の送付テスト（竹内「リアプロと ITANDI、YUMA に物件送る形で大量にテスト」）:
//   売上サポから来た物件オススメ（pickup_ids＝セットした資料のまま・その行の資料だと確か）で、資料の「プレサンス天神橋筋六丁目ヴォワール」を
//   本文の見出しに「🌟プレサンス天神橋六丁目ヴォワール 603号室」（「筋」が落ちた）と書いた。資料の文字は変えない決まり
//   （feedback_pickup_material_verbatim）に反し、さらに送った後の物件名の照合（sent-image-record の辞書）が本文の見出しを
//   正しい名前として拾い、sent_properties に誤った名前で残った → 同じ部屋を別の回から選んでも「送付済み」の確かめ
//   （sent-room-match の完全一致）に当たらない。
//   本番の実送信 21日（scripts/tmp-audit-star-header-name.ts）: 売上サポの資料と字が違う見出し 12件（Ⅵ→VI・サウスブレイス・ラグジャー 等）。
//   ⚠ 行 ID が無い時は別の物件（スプランディッド本町グラン↔堀江）もあるので**直さない**。直すのは行 ID が1件で届いた時だけ。
//   直すのは見出しの行の建物名だけ（号室・本文は触らない）。行 ID＝その資料なので Ⅳ↔Ⅵ のような読み違いも資料の字に直す。似ていない（0.5 未満）時は直さない
//   ＝別の物件を書いた疑いは直さず注意だけ（誤って別の名前に書き換えない）。

export type StarHeadAlign = { text: string; changed: boolean; from?: string; to?: string; mismatch?: string };
const STAR_HEAD_SPLIT_RE = /^(\s*🌟\s*)(.+?)([\s　]+[A-Za-zＡ-Ｚ]?[0-9０-９]{1,5}[A-Za-zＡ-Ｚ]?\s*(?:号室)?\s*)$/;

export function alignStarHeadToMaterial(text: string, material: { propertyName: string | null | undefined }): StarHeadAlign {
  const name = String(material.propertyName ?? "").trim();
  const lines = String(text ?? "").split("\n");
  const idx = lines.findIndex((l) => l.trim().startsWith("🌟"));
  if (!name || idx < 0) return { text, changed: false };
  const m = lines[idx].match(STAR_HEAD_SPLIT_RE);
  if (!m) return { text, changed: false };
  const written = m[2].trim();
  if (normalizePropertyName(written) === normalizePropertyName(name)) {
    // 記号・空白の違いだけでも資料の字に揃える（Ⅵ↔VI のような字の違いは normalize で同じにならないので下へ）
    if (written === name) return { text, changed: false };
  }
  const sim = similarity(written, name);
  if (sim < 0.5) {
    return { text, changed: false, mismatch: `見出しの物件名「${written}」が資料の「${name}」と違います` };
  }
  lines[idx] = `${m[1]}${name}${m[3]}`;
  return { text: lines.join("\n"), changed: true, from: written, to: name };
}
