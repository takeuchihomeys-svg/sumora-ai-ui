// app/lib/condition-change-scope.ts — お客様の条件の言い直しが「そもそもの条件の切り替え」か「今回だけ」かを決める（純関数・DB も fetch も無し）
//
// 2026-09-27 竹内「一時調整か、そもそもの条件の切り替えか、の判断をブレインが行えれば理想」
//   （未桜さん「大国町エリアで1Kでできたら7畳以上の部屋で探してます」＝切り替え・登録の条件を直す／
//    スタッフのメモ「大正駅で検索する」＝その回だけ・search_override）
//
// 決め方（上から順に・最初に決まった物）:
//   1. お客様の文に「今回だけ」の語（今回だけ・ついでに・参考に・比較で・〜にした場合の物件も 等）→ temporary（決定論・ブレインより強い）
//   2. お客様の文に「切り替え」の語（条件変更・やっぱり・〜ではなく・〜で探してます 等）→ permanent（決定論）
//   3. ブレインの condition_change_scope（permanent | temporary | none）。none＝条件の話でない（送った物件・物件の質問・見積依頼）→ 登録の条件も上書きも作らない
//   4. どれも無い → permanent（2026-09-27 竹内「お客様の言い直しは登録の条件そのものを直す」が既定）
//   1 を先にする理由: 「今回だけ」と書いた人の登録の条件を直すと、以後の自動便もその条件で走り続ける（戻す人がいない）。
//   逆（切り替えなのに今回だけ扱い）は次の言い直しで直る＝害が小さい方に倒す。
//
// 経路（どれもこの関数の答えに従う）:
//   - P4（webhook の条件抽出）・フォームの読み取り（カジュアル更新）: ブレインより先に走るので 1 だけ見る。temporary なら登録の条件を書かない
//   - ブレインの後（brain-core runBrainAndNotify）: temporary と決まったら、P4 がこの発言で書いた登録の条件を戻し（condition-scope-server.ts）、
//     この発言の条件をその回だけの上書き（search_override）にして AIX の検索（source=aix）に載せる（condition-scope-override.ts）
//   - ブレインの条件の橋（generate-draft-bg-async）・条件ブレイン（property-brain-core）: temporary なら登録の条件を書かない
//   決定論の関所（rent-raise.ts の家賃を上げて・帖→㎡）は、permanent なら登録の条件へ・temporary なら上書きへ、同じ計算で入る（置き場所だけが変わる）

/** none＝検索条件の話ではない（お客様が送った物件・特定の物件の質問・見積依頼）。ブレインの cond の札の付け過ぎ（2026-09-27 監査: cond ありの番の約3/4）を止める */
export type ConditionChangeScope = "permanent" | "temporary" | "none";
export type ScopeDecidedBy = "text_temporary" | "text_permanent" | "brain" | "default";
export type ScopeDecision = { scope: ConditionChangeScope; by: ScopeDecidedBy; evidence: string | null };

const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/\s+/g, " ");

// 「今回だけ」の語。検索の条件の話の文でだけ使う（呼び出し元はブレインの condition_change_type・P4 の抽出がある時だけ呼ぶ）
const TEMPORARY_RES: ReadonlyArray<RegExp> = [
  /今回(?:だけ|のみ|限り|に限って|に限り)/,
  /一時的に?/,
  /(?:試しに|ためしに|お試しで)/,
  // 「参考に致します」（送った物件のお礼）は外す＝参考に「見たい・知りたい・教えて・送って」の形だけ（2026-09-27 監査 Gen 事例）
  /参考(?:まで|程度|として|に)(?:に)?(?!\s?(?:致|いた|させ|なり|します|なる))[^。!?！？]{0,12}?(?:見|知り|教え|送|聞)/,
  /比較(?:したい|のため|用に?|して(?:み|見)|で)/,
  /ついでに/,
  /念の(?:ため|為)/,
  // 「家賃を15万円までにした場合の物件も」「1LDKだった場合のお部屋も」＝仮に広げた時の物も見たい（登録の条件はそのまま）
  /(?:にした|だった|とした|になった|上げた|広げた)場合(?:の|で|は)?(?:物件|お部屋|部屋|もの|とこ)?(?:も|って|は)?\s?(?:見|知り|教え|送|あり|あれ|どう|気にな)/,
  /(?:にした|だった)ら(?:どんな|どう|いくら|ありま|あるか)/,
];
// 「切り替え」の語（今後ずっとこの条件で）
const PERMANENT_RES: ReadonlyArray<RegExp> = [
  /条件(?:を|の)?(?:変更|変え|切り替え|切替|見直)/,
  /(?:に|へ)(?:変更|切り替え|切替)/,
  /(?:やっぱり|やっぱ|やはり)/,
  /(?:ではなく|じゃなくて|じゃなく|ではなくて)/,
  /(?:で|を)探して(?:ます|います|る|いきたい|行きたい|おります)/,
  /(?:希望|条件)が変わ/,
  /今後は/,
];

function firstHit(t: string, res: ReadonlyArray<RegExp>): string | null {
  for (const re of res) {
    const m = t.match(re);
    if (m) return m[0];
  }
  return null;
}

/** お客様の文の「今回だけ」の語（無ければ null）。P4・フォームの読み取り（ブレインより先）はこれだけで決める */
export function temporaryScopeCue(text: string | null | undefined): string | null {
  const t = norm(text);
  if (!t) return null;
  // 断り・否定（「今回は見送ります」「今回は大丈夫です」）は条件の話でない＝一時扱いにしない
  if (/今回は(?:見送|大丈夫|結構|遠慮|やめ|なし|いい)/.test(t) && !/今回(?:だけ|のみ|限り)/.test(t)) return null;
  return firstHit(t, TEMPORARY_RES);
}

/** お客様の文の「切り替え」の語（無ければ null） */
export function permanentScopeCue(text: string | null | undefined): string | null {
  return firstHit(norm(text), PERMANENT_RES);
}

/** ブレインの出力の欄を読む（形が違えば null） */
export function normalizeBrainScope(v: unknown): ConditionChangeScope | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s === "permanent" || s === "temporary" || s === "none" ? s : null;
}

/** 条件の言い直しの置き場所を決める（上の 1〜4 の順） */
export function resolveConditionChangeScope(input: { text: string | null | undefined; brainScope?: unknown }): ScopeDecision {
  const tmp = temporaryScopeCue(input.text);
  if (tmp) return { scope: "temporary", by: "text_temporary", evidence: tmp };
  const perm = permanentScopeCue(input.text);
  if (perm) return { scope: "permanent", by: "text_permanent", evidence: perm };
  const b = normalizeBrainScope(input.brainScope);
  if (b) return { scope: b, by: "brain", evidence: null };
  return { scope: "permanent", by: "default", evidence: null };
}

/** ブレインより先に走る経路（P4・フォームの読み取り）が登録の条件を書いてよいか（「今回だけ」の語が無い時だけ書く） */
export function preBrainMayWriteRegistered(text: string | null | undefined): { ok: boolean; evidence: string | null } {
  const tmp = temporaryScopeCue(text);
  return tmp ? { ok: false, evidence: tmp } : { ok: true, evidence: null };
}

/** 登録の条件を戻す時に見る列（検索に効く列だけ。こだわり・NG の文字の列は戻さない＝メモとして残る） */
export const SCOPE_REVERT_FIELDS = ["desired_area", "floor_plan", "rent_max", "rent_min", "floor_area_min", "walk_minutes", "building_age"] as const;
const NUMERIC_REVERT = new Set(["rent_max", "rent_min", "floor_area_min", "walk_minutes", "building_age"]);

export type HistoryRowLite = { changed_field: string; old_value: string | null; new_value: string | null; created_at: string };

/**
 * ブレインが「今回だけ」と決めた時に、P4 がこの発言で書いた登録の条件を戻す値を決める（純関数）。
 *   その発言の時刻（少し前から）より後の履歴だけ・列ごとに一番古い old_value へ戻す。
 *   今の値が履歴の最後の new_value と違う列（間にスタッフが手で直した等）は戻さない。
 */
export function planScopeRevert(
  rows: ReadonlyArray<HistoryRowLite>,
  current: Record<string, unknown> | null | undefined,
  sinceIso: string,
  opts: { slackMs?: number } = {},
): { updates: Record<string, unknown>; skipped: string[] } {
  const since = Date.parse(sinceIso) - (opts.slackMs ?? 10_000);
  const updates: Record<string, unknown> = {};
  const skipped: string[] = [];
  if (!Number.isFinite(since)) return { updates, skipped };
  const byField = new Map<string, HistoryRowLite[]>();
  for (const r of rows) {
    if (!(SCOPE_REVERT_FIELDS as readonly string[]).includes(r.changed_field)) continue;
    const at = Date.parse(r.created_at);
    if (!Number.isFinite(at) || at < since) continue;
    byField.set(r.changed_field, [...(byField.get(r.changed_field) ?? []), r]);
  }
  for (const [f, list] of byField) {
    const sorted = [...list].sort((a, b) => a.created_at.localeCompare(b.created_at));
    const first = sorted[0], last = sorted[sorted.length - 1];
    if (String(current?.[f] ?? "") !== String(last.new_value ?? "")) { skipped.push(`${f}（履歴の後に変わっている）`); continue; }
    const ov = first.old_value;
    if (ov == null || ov === "") updates[f] = null;
    else if (NUMERIC_REVERT.has(f)) { const n = Number(ov); if (Number.isFinite(n)) updates[f] = n; else skipped.push(`${f}（数字でない ${ov}）`); }
    else updates[f] = ov;
  }
  return { updates, skipped };
}
