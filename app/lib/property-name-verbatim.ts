// app/lib/property-name-verbatim.ts
// 2026-10-02 ⑫（竹内さんの指示「物件名はデータからそのまま写す・作らせない。出口で決定論に・監査つき」）:
//   YUMA の再生（AIX【内覧調整】・DeepSeek）で「エグゼ難波西Ⅱ」が「エヴゼ峰渡西Ⅱ 202号室」と化けて文になった。
//   出所の切り分け: 個人情報の読み替え（pii-pseudonym）の仮名の一覧に「峰渡」は無く、物件名は読み替えの対象外（竹内さん 9/19「物件情報はマスキング不要」）
//   ＝変換の段ではなくモデルが写し間違えた。→ 出口で、**この AIX で使うと決まった物件名**（入力の property_name）に**ほぼ同じだが違う**並びがあれば、
//   その字にそのまま直す（enforceChosenPropertyName）。会話・資料から拾った名前で広く直す形（enforceVerbatimPropertyNames）は
//   監査で誤りが多く出たので書き換えには使わず、印（ログ）だけ（下の注記）。
// 線（scripts/audit-property-name-verbatim.ts・本番の AIX の文と人の手打ちに当てて目で読む）:
//   ・名前らしい並び（カタカナ・英数字・漢字・Ⅰ〜Ⅻ・中黒）で4字以上
//   ・知っている名前と長さの差が1以内・最初と最後の字が同じ・違う字が長さの45%以内・知っている名前そのものではない
//   ・知っている名前が2つ以上同じくらい近い時は直さない（どちらか決められない）
export type VerbatimFix = { from: string; to: string };

const RUN_RE = /[ァ-ヶーｦ-ﾟA-Za-zＡ-Ｚａ-ｚ0-9０-９一-龠々〆ヶⅠ-Ⅻ・･.\-]{4,}/g;

/** 会話・資料から物件名を集める（🌟の見出し・【名前 号室】・「名前 123号室」） */
export function knownPropertyNamesFrom(texts: ReadonlyArray<string | null | undefined>, extra: ReadonlyArray<string | null | undefined> = []): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    const n = raw.replace(/\s*[0-9０-９]{2,4}\s*(?:号室)?\s*$/, "").replace(/[（(].*$/, "").trim();
    if (n.length >= 4 && n.length <= 30 && !/[ぁ-ん]{2,}/.test(n)) out.add(n);
  };
  for (const e of extra) if (e) add(String(e));
  for (const t0 of texts) {
    const t = String(t0 ?? "");
    for (const m of t.matchAll(/🌟\s*([^\n]+)/g)) add(m[1]);
    for (const m of t.matchAll(/【([^】\n]{4,40}?)\s*[0-9０-９]{2,4}\s*号室】/g)) add(m[1]);
  }
  return [...out];
}

function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

/** 知っている名前に「ほぼ同じだが違う」並びを、知っている名前の字に直す */
export function enforceVerbatimPropertyNames(text: string, known: ReadonlyArray<string>): { text: string; fixes: VerbatimFix[] } {
  const names = [...new Set(known.filter((k) => k && k.length >= 6))];
  if (!names.length || !text) return { text, fixes: [] };
  const fixes: VerbatimFix[] = [];
  const out = text.replace(RUN_RE, (run) => {
    if (names.some((k) => run.includes(k))) return run;
    // 並びの頭から知っている名前と同じくらいの長さを比べる（後ろに号室・階などが続く形）
    let best: { k: string; seg: string; d: number } | null = null;
    let tie = false;
    for (const k of names) {
      for (const len of [k.length - 1, k.length, k.length + 1]) {
        if (len < 4 || len > run.length) continue;
        const seg = run.slice(0, len);
        if (seg === k || seg[0] !== k[0] || seg[seg.length - 1] !== k[k.length - 1]) continue;
        const d = lev(seg, k);
        if (d === 0 || d > Math.ceil(k.length * 0.45)) continue;
        if (!best || d < best.d) { best = { k, seg, d }; tie = false; }
        else if (d === best.d && best.k !== k) tie = true;
      }
    }
    if (!best || tie) return run;
    fixes.push({ from: best.seg, to: best.k });
    return best.k + run.slice(best.seg.length);
  });
  return { text: out, fixes };
}

/**
 * 2026-10-02 ⑫ 監査の結果（scripts/audit-property-name-verbatim.ts・本番のスタッフの送信 12,628通）:
 *   会話・資料から拾った名前で広く直すと 43通（うち AIX 16）を書き換え、その多くが誤り
 *   （資料の読み取りの誤字「ドリームネオボリス極ノ宮」「グランルージュ谷町大丁目」の方へ直す・別の物件「スプランディッド本町」→「…安土町」・
 *    人の正しい表記「ザコア」「森ノ宮」）＝誤削除0の線にならない → 広い書き換えはしない。
 *   直すのは「この AIX で使うと決まった物件名」（AIX の入力の property_name＝スタッフ・プレフィルが選んだ1件）に対してだけ。
 *   それ以外の「知っている名前にほぼ同じだが違う」並びは書き換えず、印（ログ）だけ出す（propertyNameNearMisses）
 */
export function enforceChosenPropertyName(text: string, chosen: string | null | undefined): { text: string; fixes: VerbatimFix[] } {
  const c = String(chosen ?? "").replace(/\s*[0-9０-９]{2,4}\s*(?:号室)?\s*$/, "").trim();
  if (c.length < 4) return { text, fixes: [] };
  // 1件だけを相手にするので長さの下限は 4（名前の長さ 6 未満の短い名前も対象）
  const names = [c];
  const RUN = /[ァ-ヶーｦ-ﾟA-Za-zＡ-Ｚａ-ｚ0-9０-９一-龠々〆ヶⅠ-Ⅻ・･.\-]{4,}/g;
  const fixes: VerbatimFix[] = [];
  const out = text.replace(RUN, (run) => {
    if (run.includes(c)) return run;
    for (const k of names) for (const len of [k.length - 1, k.length, k.length + 1]) {
      if (len < 4 || len > run.length) continue;
      const seg = run.slice(0, len);
      if (seg[0] !== k[0] || seg[seg.length - 1] !== k[k.length - 1]) continue;
      const d = lev(seg, k);
      if (d > 0 && d <= Math.ceil(k.length * 0.45)) { fixes.push({ from: seg, to: k }); return k + run.slice(len); }
    }
    return run;
  });
  return { text: out, fixes };
}

/** 書き換えずに印だけ: 知っている名前にほぼ同じだが違う並び */
export function propertyNameNearMisses(text: string, known: ReadonlyArray<string>): VerbatimFix[] {
  return enforceVerbatimPropertyNames(text, known).fixes;
}

/**
 * 2026-10-02 ⑫ 11巡目: AIX【物件確認した（募集中）】の定型「[物件名と号室]現在募集中となります」を LLM が埋めた物件名が、
 *   会話の直近（recentTexts）に出ているか。出ていなければ別の（前の）物件を選んだ疑い（YUMA 再生 flow8 t08）。
 *   名前は定型の「募集中となります」より前の文字。号室の数字と空白を除いた名前（3字以上）で探す
 */
export function availableNameGrounded(text: string, recentTexts: ReadonlyArray<string>): { name: string | null; grounded: boolean } {
  const m = String(text ?? "").match(/^([^\n]*?)(?:現在)?募集中となります/m);
  const name = m?.[1]?.trim() ?? "";
  if (!name || name.includes("[物件名と号室]")) return { name: null, grounded: true };
  const base = name.replace(/\s*[0-9０-９]{2,4}\s*号室?\s*$/, "").replace(/[\s　・]/g, "");
  if (base.length < 3) return { name, grounded: true };
  const hay = recentTexts.join("\n").replace(/[\s　・]/g, "");
  return { name, grounded: hay.includes(base) };
}
