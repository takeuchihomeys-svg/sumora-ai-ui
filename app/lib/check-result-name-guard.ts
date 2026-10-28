// app/lib/check-result-name-guard.ts — AIX【物件確認した】（会話を合わせる）の文に、前のやり取りの別の物件名を書かせない（純関数）
//
// 2026-10-28 竹内さんの指摘（☆・スモラ・10/26 16:04 の下書き aix_generate_log be842674）:
//   お客様が 10/26 に送ってきたのは「堺筋本町 2LDK 7階＋SUUMO の URL」（物件名なし）。スタッフは見積書を同封（読み取り＝アーバネックス堺筋本町 701号室）。
//   下書きは「お送り頂きましたS-RESIDENCE堺筋本町Deuxの募集状況確認いたしました！！909号室は現在募集中…」＝9/22 のやり取りの物件名を写した。
//   その会話は 9/22〜10/26 の間に通が0で、会話の履歴の直前が 9/22 の S-RESIDENCE の見積書の通だった。物件名の入力は空で、
//   書く役への指示が「物件名は未入力。引用返信・会話から分かる階・お部屋として伝える」＝前のやり取りから名前を探させていた。
//   同封した見積書の読み取り（見積書の見出し【物件名 号室】）は費用の文にだけ使い、確認の結果の物件名には渡していなかった。
// 直し: ①物件名の入力が空の時は、同封した見積書の見出しの物件名を対象の物件名に使う ②会話の履歴にある別の物件名は「今回の物件ではない」と材料に書く。
//   決めるのは書く役（本文を決定論で書き換えない）。入れる CHECK_RESULT_NAME_GUARD=on（既定 off）
export function checkResultNameGuardOn(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CHECK_RESULT_NAME_GUARD ?? "").trim().toLowerCase() === "on";
}

const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/号室$/, "");
/** 建物の名前の芯（号室・階を外す）。比べる時に使う */
export function buildingCore(s: string): string {
  return norm(s).replace(/[0-9]+(?:号室|階)?$/, "").replace(/[-‐ー・]$/, "");
}

/** 費用の文（AIX の見積書の文）の見出し【物件名 号室】から物件名を読む。読めなければ null */
export function estimateHeadName(text: string | null | undefined): string | null {
  const m = String(text ?? "").match(/【([^】\n]{2,40})】/);
  if (!m) return null;
  const s = m[1].trim();
  if (/^(?:物件|お部屋)\s*[①-⑳0-9]*$/.test(s) || /御見積|初期費用|確認結果|スタッフ/.test(s)) return null;
  return s;
}

/** 会話の文に出てくる物件名（AIX の見出し【…】・🌟の見出し・「お送り頂きました〇〇の」）。重ねない・出てきた順 */
export function propertyNamesInTexts(texts: ReadonlyArray<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const s = raw.trim().replace(/[！!。、]+$/, "");
    if (s.length < 3 || s.length > 40) return;
    // 監査（60日 350番）で拾っていた物件名でない物: 「下部ボタン」「緊急連絡先欄」「セキュリティ」「種類不明」「〇〇のみご案内可能です😊」
    if (/です|ます|ました|[😊😌🌟✨！!？?]|欄|ボタン|種類|セキュリティ|放送|通信|地域|手続/.test(s)) return;
    if (/^(?:物件|お部屋)\s*[①-⑳0-9]*$/.test(s) || /御見積|初期費用|確認結果|ご希望|お部屋お探し|オススメ|ポイント|画面|間取り|SUUMO|アプリ|通知|タイトル|物件名|写真|画像|内容|情報|円|割引|ご入居|ご条件|ページ/.test(s)) return;
    const k = buildingCore(s);
    if (!k || k.length < 3 || seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  for (const t of texts) {
    const x = String(t ?? "");
    // 【…】は AIX の見積書・物件の見出し（部屋番号で終わる物）だけ。画像の読みの節の見出し（【物件タイトル】【下部ボタン】等）は拾わない
    for (const m of x.matchAll(/【([^】\n]{2,40})】/g)) if (/[0-9０-９]{2,5}(?:号室)?$/.test(m[1].trim())) add(m[1]);
    for (const m of x.matchAll(/^🌟\s*([^\n]{2,40})$/gm)) add(m[1]);
    for (const m of x.matchAll(/お送り頂きました([^\s、。！!\n]{3,30}?)(?:の|につきまして)(?:募集|最大限|初期費用|御見積)/g)) add(m[1]);
  }
  return out;
}

/**
 * 書く役に渡す行。
 *   inputNames: スタッフが画面で入れた物件名（空・「物件①」は無いのと同じ）
 *   estimateNames: 同封した見積書の見出しの物件名（物件の並びと同じ順・無ければ null）
 *   historyTexts: 会話の履歴の文
 * 返す: targets＝対象の物件名（入力が正・空なら見積書）／lines＝材料の行
 */
export function checkResultNameMaterial(o: {
  inputNames: ReadonlyArray<string | null | undefined>;
  estimateNames: ReadonlyArray<string | null | undefined>;
  historyTexts: ReadonlyArray<string | null | undefined>;
  /** お客様の今の番の文（最後のこちらの通より後）。ここに出てくる物件名は今回の物件の候補＝「書かない」に入れない */
  currentTexts?: ReadonlyArray<string | null | undefined>;
}): { targets: string[]; fromEstimate: boolean[]; lines: string[] } {
  const isBlank = (s: string | null | undefined) => !s || !String(s).trim() || /^(?:物件|お部屋)\s*[①-⑳0-9]*$/.test(String(s).trim());
  const n = Math.max(o.inputNames.length, o.estimateNames.length);
  const targets: string[] = [];
  const fromEstimate: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const inp = o.inputNames[i];
    const est = o.estimateNames[i];
    if (!isBlank(inp)) { targets.push(String(inp).trim()); fromEstimate.push(false); }
    else if (!isBlank(est)) { targets.push(String(est).trim()); fromEstimate.push(true); }
    else { targets.push(""); fromEstimate.push(false); }
  }
  const tcores = new Set(targets.filter(Boolean).map(buildingCore));
  const curRaw = (o.currentTexts ?? []).map((t) => String(t ?? "").normalize("NFKC").replace(/\s+/g, "")).join("\n");
  const others = propertyNamesInTexts(o.historyTexts).filter((s) => {
    const k = buildingCore(s);
    if (tcores.has(k) || [...tcores].some((t) => t && (t.includes(k) || k.includes(t)))) return false;
    // お客様が今の番で書いた物件は今回の物件の候補（外さない）
    if (k.length >= 4 && curRaw.includes(k)) return false;
    return true;
  });
  const lines: string[] = [];
  const named = targets.filter(Boolean);
  // 今回の物件名が分からない時は「書かない」の行を出さない（今の番の物件を誤って外さない）。名前を作らない行だけ
  if (!named.length) others.length = 0;
  if (named.length) lines.push(`・今回確認した物件名: ${named.join("／")}${fromEstimate.some(Boolean) ? "（同封する御見積書の見出しの物件名）" : ""} → 物件名はこれだけを使う`);
  if (others.length) lines.push(`・会話の前のやり取りに出てくる別の物件（${others.slice(0, 5).join("／")}）は今回の確認の物件ではない → 本文に書かない`);
  if (!named.length) lines.push("・今回の物件名は分からない → 物件名を書かず、お客様が直近に送ってきたお部屋（階・間取り）として伝える。前のやり取りの物件名を当てはめない");
  return { targets, fromEstimate, lines };
}
