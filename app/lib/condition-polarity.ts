// app/lib/condition-polarity.ts — 探す条件の「向き」（足す／ゆるめる／外す／避けたい）と「込み」の印（純関数・DB/LLM なし）
//
// 2026-10-15 軸の直し（axis-brain-1015）: 原因調べ（7件）の個別の2つ
//   ① まりあさん（b50fd451 9/16）「ペット可じゃなくてもいいので紹介していただきたいです！」を、条件の取り出し（P4・Haiku）が「ペット可NG[必須]」と逆に読んだ。
//      竹内さんの実送信「ペット可条件は外し、…改めてピックアップ」＝ゆるめる（relax）は条件を外すだけで、NG にはしない。
//   ② りさん（8f705d16）: 家賃の上限は「共益費込み10万」だったのに、条件の欄で「込み」を落とし、管理費込みで10.8万の物件が上限の中に入った。
//   ここは網と安全の線（取り出した後の書き込みの前に当てる）。種類の判断はブレイン（turn_contract.asks[].polarity）が持つ。
//   戻す: CONDITION_POLARITY=off（前の形＝取り出しのまま書く）
//
// テスト: app/lib/__tests__/condition-polarity.test.ts

export function conditionPolarityEnabled(env: Record<string, string | undefined> = typeof process !== "undefined" ? process.env : {}): boolean {
  return (env.CONDITION_POLARITY ?? "").trim().toLowerCase() !== "off";
}

/** 「Xじゃなくてもいい」「Xでなくても大丈夫」「Xは無くてもいい」「Xにこだわらない」「X不要」の X（条件の語）。無ければ [] */
const RELAX_RE = /([^\s、。,!！?？]{1,12}?)(?:じゃ|では|で)?(?:なく|無く)ても(?:いい|良い|よい|大丈夫|OK|ok|構いません|かまいません|いけ)|([^\s、。,!！?？]{1,12}?)(?:に|は)?(?:こだわらない|こだわりません|こだわりは(?:ない|ありません))|([^\s、。,!！?？]{1,12}?)(?:は)?(?:不要|いらない|要らない)(?:です)?(?:[。！!]|$)/g;

export function relaxedTermsOf(text: string): string[] {
  const t = String(text ?? "").normalize("NFKC").replace(/\s*\n\s*/g, "");
  const out: string[] = [];
  for (const m of t.matchAll(RELAX_RE)) {
    let w = (m[1] ?? m[2] ?? m[3] ?? "").replace(/^(?:別に|特に|もう|なので|けど|が|は|も)/, "").replace(/(?:の物件|のお部屋|の部屋|物件|お部屋)$/, "").trim();
    // 「一階とかだと鉄筋コンクリートじゃなくても」→ 鉄筋コンクリート（とかだと 等の前置きを外す）
    w = w.replace(/^.*(?:とかだと|だと|なら|でも)/, "").trim();
    if (w.length >= 2 && !/^(?:それ|これ|そこ|ここ|今|すぐ|急ぎ|無理)$/.test(w)) out.push(w);
  }
  return [...new Set(out)];
}

/** 条件の語の芯（「ペット可」→「ペット」・「鉄筋コンクリート造」→「鉄筋コンクリート」）。比べる時に使う */
const core = (w: string) => w.normalize("NFKC").replace(/(?:可|あり|有り|付き|付|造|希望|必須|\[[^\]]*\])+$/g, "").replace(/\s/g, "");

/** 節（・、,／で区切った物）のうち、ゆるめた語を含む物を外す。全部外れたら null */
export function dropRelaxedClauses(v: string | null | undefined, relaxed: ReadonlyArray<string>): string | null {
  if (!v) return v ?? null;
  const keys = relaxed.map(core).filter((k) => k.length >= 2);
  if (!keys.length) return v;
  const parts = String(v).split(/[・、,，／\/]/).map((s) => s.trim()).filter(Boolean);
  const kept = parts.filter((p) => !keys.some((k) => core(p).includes(k)));
  return kept.length ? kept.join("・") : null;
}

/** 家賃の上限が共益費・管理費込みの言い方か（「共益費込み10万」「管理費込みで8万以内」「管理費込で」） */
export function feeIncludedOf(text: string): "共益費" | "管理費" | null {
  const t = String(text ?? "").normalize("NFKC");
  const m = /(共益費|管理費)(?:等)?(?:も)?(?:込み|込)/.exec(t);
  return m ? (m[1] as "共益費" | "管理費") : null;
}
export const FEE_INCLUDED_NOTE = (w: "共益費" | "管理費") => `家賃上限は${w}込み`;

/**
 * 取り出した条件（P4 の extracted）にゆるめる・込みの線を当てる。
 *   ・ゆるめた語は ng_points・preferences（新しく足す分）から外し、今の登録の preferences からも外す（removePreferences に返す＝呼ぶ側が書く）
 *   ・家賃上限の込みの印は other_requests に「家賃上限は共益費込み」を足す（家賃の数がある時・今の登録の上限を言い直した時）
 */
export function applyConditionPolarity(
  customerText: string,
  extracted: Record<string, unknown>,
  existing: { preferences?: string | null; ng_points?: string | null } | null,
  env?: Record<string, string | undefined>,
): { extracted: Record<string, unknown>; relaxed: string[]; preferencesAfterRelax: string | null | undefined; ngAfterRelax: string | null | undefined; feeIncluded: string | null } {
  if (!conditionPolarityEnabled(env)) return { extracted, relaxed: [], preferencesAfterRelax: undefined, ngAfterRelax: undefined, feeIncluded: null };
  const relaxed = relaxedTermsOf(customerText);
  const out: Record<string, unknown> = { ...extracted };
  let preferencesAfterRelax: string | null | undefined;
  let ngAfterRelax: string | null | undefined;
  if (relaxed.length) {
    for (const f of ["ng_points", "preferences"] as const) {
      if (typeof out[f] === "string") { const d = dropRelaxedClauses(out[f] as string, relaxed); if (d) out[f] = d; else delete out[f]; }
    }
    if (existing?.preferences) { const d = dropRelaxedClauses(existing.preferences, relaxed); if (d !== existing.preferences) preferencesAfterRelax = d; }
    if (existing?.ng_points) { const d = dropRelaxedClauses(existing.ng_points, relaxed); if (d !== existing.ng_points) ngAfterRelax = d; }
  }
  const fee = feeIncludedOf(customerText);
  if (fee && (typeof out.rent_max === "number" || /[0-9]+(?:\.[0-9]+)?\s*万/.test(customerText.normalize("NFKC")))) {
    const note = FEE_INCLUDED_NOTE(fee);
    const cur = typeof out.other_requests === "string" ? out.other_requests : "";
    if (!cur.includes(note)) out.other_requests = cur ? `${cur}・${note}` : note;
  }
  return { extracted: out, relaxed, preferencesAfterRelax, ngAfterRelax, feeIncluded: fee };
}
