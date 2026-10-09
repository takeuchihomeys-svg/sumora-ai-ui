// app/lib/design-knowledge-curation.ts — 設計知見（system_design_thinking）の整理（純関数・DB も LLM も触らない）
//
// 2026-10-06 竹内「設計知見が学んだことは更新されていっているのか。設計知見の更新や成長はツールを完成させるにあたってかなり重要なので」
//   → 「この形で⑯に進めさせる」。実測: 1,404行のうち現行 1,368・非現行 36。竹内さんの決定で古くなった行がほとんど退役されていなかった。
//   property_search_knowledge の整理（planCuration）と同じ形: 決定論が先・似ているかの判断だけ DeepSeek・消さない（is_current=false＋理由＋上書きした行）。
//
//   ① 重複: 題が同じで本文がほぼ同じ（文字3つ組の重なり 0.9 以上）→ 中身の多い方を残し、他は退役（superseded_by＝残した行）
//   ② 竹内さんの決定で古くなった行: DECISIONS の「古い決まりの言い方」に当たる行で、決定の行より前に書かれた物 → 退役（superseded_by＝決定の行）。
//      自動で退役するのは auto の決定だけ（文がはっきり古い決まりを言っている物）。他は要確認の一覧へ
//   ③ 似ている組（文字の重なりが中くらい）→ DeepSeek に「同じ決まり／上書き／食い違い／関係あり／別」を聞いて要確認の一覧へ（自動では退役しない）
//   ④ 分野ごとの「今の決まり」のまとめ（digest）: 現行の行だけ・1行ずつ・元の行の id 付き
import { effectivePriority } from "@/app/lib/design-knowledge-priority";

export type KbRow = {
  id: string;
  title: string;
  category?: string | null;
  insight: string;
  rationale?: string | null;
  context?: string | null;
  applied_to?: string | null;
  tags?: string[] | null;
  is_current: boolean;
  created_at: string;
  /** 段（0〜3・design-knowledge-priority.ts）。列が無い・null は推定 */
  priority?: number | null;
};

export type RetirePlan = { id: string; supersededBy: string; reason: string; kind: "duplicate" | "decision" };
export type ReviewItem = { kind: "decision" | "similar" | "conflict" | "priority" | "tags" | "mojibake"; ids: string[]; note: string; relation?: string };

// ── 文字の重なり（決定論）──
export function normKb(s: string | null | undefined): string {
  return String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s　、。・,.!！?？「」『』()（）【】\[\]—\-–:：;；"'`]/g, "");
}
export function grams(s: string, k: number): Set<string> {
  const n = normKb(s);
  const g = new Set<string>();
  for (let i = 0; i + k <= n.length; i++) g.add(n.slice(i, i + k));
  return g;
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}

/** 中身の多い方（本文＋根拠＋状況の長さ・同じなら新しい方）を残す */
export function pickKeeper(a: KbRow, b: KbRow): KbRow {
  const len = (r: KbRow) => (r.insight?.length ?? 0) + (r.rationale?.length ?? 0) + (r.context?.length ?? 0);
  if (len(a) !== len(b)) return len(a) > len(b) ? a : b;
  return a.created_at >= b.created_at ? a : b;
}

export const DUP_RULE = { titleSame: true, bodyMin: 0.9 } as const;
/** ① 重複（題が同じ・本文 0.9 以上）。自動で退役する */
export function findDuplicates(rows: KbRow[]): RetirePlan[] {
  const cur = rows.filter((r) => r.is_current);
  const byTitle = new Map<string, KbRow[]>();
  for (const r of cur) { const k = normKb(r.title); (byTitle.get(k) ?? byTitle.set(k, []).get(k)!).push(r); }
  const out: RetirePlan[] = [];
  for (const list of byTitle.values()) {
    if (list.length < 2) continue;
    let keep = list[0];
    for (const r of list.slice(1)) keep = pickKeeper(keep, r);
    const kg = grams(keep.title + keep.insight, 3);
    for (const r of list) {
      if (r.id === keep.id) continue;
      const j = jaccard(kg, grams(r.title + r.insight, 3));
      if (j >= DUP_RULE.bodyMin) out.push({ id: r.id, supersededBy: keep.id, kind: "duplicate", reason: `重複（題が同じ・本文の重なり ${j.toFixed(2)}）→ 中身の多い方 ${keep.id} を残す` });
    }
  }
  return out;
}

// ── ② 竹内さんの決定 ──
export type Decision = {
  key: string;
  area: string;
  label: string;
  /** 決定の行（新しい決まり）を見つける。決定の日以降の現行の行で、一番新しい物 */
  newRe: RegExp;
  since: string;
  /** 古い決まりの言い方（題か本文に当たる行は、決定の行より前なら古い） */
  oldRe: RegExp;
  /** true＝当たった古い行を自動で退役（文がはっきり古い決まり）。false＝要確認の一覧だけ */
  auto: boolean;
};
// 竹内さんの決定（memory の feedback_*／fact_* と 10/02〜10/06 の設計知見）。古い言い方は実際の行を読んで、言い切っている物だけを auto に
export const DECISIONS: Decision[] = [
  { key: "meeting_first_property", area: "内覧", label: "待ち合わせ場所＝内覧日が決まった時点で1件目の内覧物件（「追ってご連絡」は書かない）",
    newRe: /待ち合わせ場所は内覧日が決まった時点で1件目/, since: "2026-10-02", oldRe: /^待ち合わせ場所の約束（追ってご連絡）が残っている時は/, auto: true },
  { key: "emoji_allowlist", area: "返信", label: "絵文字は 😊😌🌟✨ だけ・✅ はどの文でも残す・物件オススメの星は残す・🙇🙏 は外す",
    newRe: /絵文字の今の決まり/, since: "2026-10-02", oldRe: /見積書の✅だけ残す/, auto: true },
  { key: "no_kakunin_candidate", area: "AIX", label: "AIX【確認します】はブレインの候補から外す（確認の約束は物件確認した・約束の返信）",
    newRe: /AIX【確認します】をブレインの候補から外す/, since: "2026-10-02", oldRe: /(→|は|を)\s*AIX【確認します】(を出す|にする|が正しい)/, auto: false },
  { key: "two_stage_scene", area: "ブレイン", label: "2段の場面（送れる物がまだ無い時は今の一手を約束の返信に）",
    newRe: /^2段の場面/, since: "2026-10-02", oldRe: /送れる物が無い(のに|時も)[^。]{0,20}AIX(を|で)(出す|押す)/, auto: false },
  { key: "apply_documents", area: "返信", label: "申込に要るのはフォーマットと本人確認書類（裏表）の2つ・※マイナンバーは番号のマスキング",
    newRe: /申込に要るのはフォーマットと本人確認書類/, since: "2026-10-02", oldRe: /申込[^。]{0,20}必要書類[^。]{0,20}(住民票|収入証明|印鑑証明)(も|が)必要/, auto: false },
  { key: "screening_first", area: "返信", label: "審査だけ先に＝今話しているそのお部屋へのお申込み（可能・確認の約束にしない）",
    newRe: /審査だけ先に試す/, since: "2026-10-06", oldRe: /審査(だけ|を)先に[^。]{0,30}(管理会社に確認|確認させて|出来ない|できない)/, auto: false },
  { key: "greeting_first_line_of_day", area: "返信", label: "挨拶は1日の最初のLINEだけ（同じ日の続きは翌日に下書きを作っても挨拶なし）",
    newRe: /挨拶は1日の最初のLINEだけ/, since: "2026-10-06", oldRe: /(毎回|返信のたびに)[^。]{0,10}挨拶(を|は)(入れる|付ける)/, auto: false },
  { key: "fit_first_star", area: "物件検索", label: "採点はお客様に合う事が先（安さは加点しない）・🌟は同じ回の中で合う物・AD は線（効かせ方の上限）",
    newRe: /(スタッフの🌟は『同じ回の中で|相場より安いのを加点にしない|お客様に合う事が先)/, since: "2026-09-25", oldRe: /AD 2ヶ月以上は必ず最上位(?![』」]?をやめ)|安い(ほど|物を)[^。]{0,10}(加点|上位)/, auto: false },
  { key: "area_relative", area: "物件検索", label: "「出やすい」＝電車15分・乗換なし／タクシー5km・淀川区を含む・相場は期間で切らず10件以上・0.5万刻み",
    newRe: /「A・Bに出やすい」は住む駅でも/, since: "2026-10-02", oldRe: /出やすい[^。]{0,20}(20|30)分|タクシー[^。]{0,10}(3|10)km/, auto: false },
  { key: "phone_until_19", area: "返信", label: "スタッフの電話対応は19時まで（始まりの時刻は書かない）",
    newRe: /スタッフの電話対応は19時まで/, since: "2026-10-02", oldRe: /電話(できる|の)時間[^。]{0,10}(は|を)[^。]{0,10}(スタッフしか知らない|作らない)/, auto: false },
  { key: "card_fee_324", area: "費用", label: "初期費用の分割はカード払いのみ可・カード手数料3.24%を必ず添える（「分割は難しい」「一括振込のみ」と書かない）",
    newRe: /分割の手数料|手数料3\.24/, since: "2026-09-30", oldRe: /分割(払い)?は(難しい|出来ない|できない)(と答える|と書く|が正しい)|一括(でのお振込|振込)のみ(と答える|が正しい)/, auto: false },
  { key: "hold_room", area: "返信", label: "仮押さえは会社の事実（お申込みで抑える・保証会社の審査通過まではキャンセル料なし）",
    newRe: /^仮押さえは会社の事実/, since: "2026-10-01", oldRe: /仮押さえ[^。]{0,20}(管理会社に確認(する|させて)が正しい|出来ない)/, auto: false },
  { key: "no_okyaku_word", area: "返信", label: "相手を「お客様」と呼ばない（〇〇さん・無ければ呼ばない）",
    newRe: /相手を「お客様」と呼ばない/, since: "2026-10-02", oldRe: /名前が無い時は「お客様」(と呼ぶ|にする)/, auto: false },
];

/** 決定の行（決定の日以降・題が newRe に当たる一番新しい現行の行）。題だけで見る（本文で決定に触れているだけの行を決定の行にしない） */
export function decisionRow(rows: KbRow[], d: Decision): KbRow | null {
  const hit = rows.filter((r) => r.is_current && r.created_at.slice(0, 10) >= d.since && d.newRe.test(r.title));
  hit.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return hit[0] ?? null;
}

/** ② 決定で古くなった行。auto の決定で当たった行は退役の計画・それ以外と決定の行が無い物は要確認 */
export function findDecisionConflicts(rows: KbRow[], decisions: Decision[] = DECISIONS): { retire: RetirePlan[]; review: ReviewItem[]; missing: string[] } {
  const retire: RetirePlan[] = [], review: ReviewItem[] = [], missing: string[] = [];
  for (const d of decisions) {
    const nr = decisionRow(rows, d);
    if (!nr) { missing.push(d.key); continue; }
    for (const r of rows) {
      if (!r.is_current || r.id === nr.id) continue;
      if (r.created_at >= nr.created_at) continue;
      if (!d.oldRe.test(r.title + "\n" + r.insight)) continue;
      if (d.newRe.test(r.title)) continue; // 題が新しい決まりの行は古くない
      if (d.auto) retire.push({ id: r.id, supersededBy: nr.id, kind: "decision", reason: `竹内さんの決定（${d.label}）で古くなった決まり → ${nr.id}` });
      else review.push({ kind: "decision", ids: [r.id, nr.id], note: `決定「${d.label}」と食い違うかもしれない（古い言い方に当たる）` });
    }
  }
  return { retire, review, missing };
}

// ── ③ 似ている組（DeepSeek に聞く候補）──
export const SIMILAR_RULE = { bodyMin: 0.15, titleMin: 0.3, max: 120 } as const;
export function similarPairs(rows: KbRow[], opts: { sinceIso?: string } = {}): Array<{ a: KbRow; b: KbRow; body: number; title: number }> {
  const cur = rows.filter((r) => r.is_current);
  const G = cur.map((r) => ({ r, t: grams(r.title, 2), b: grams(r.title + r.insight, 3) }));
  const out: Array<{ a: KbRow; b: KbRow; body: number; title: number }> = [];
  for (let i = 0; i < G.length; i++) for (let j = i + 1; j < G.length; j++) {
    // 週の見直しは新しい行を含む組だけ
    if (opts.sinceIso && G[i].r.created_at < opts.sinceIso && G[j].r.created_at < opts.sinceIso) continue;
    const body = jaccard(G[i].b, G[j].b), title = jaccard(G[i].t, G[j].t);
    if (body >= SIMILAR_RULE.bodyMin || title >= SIMILAR_RULE.titleMin) out.push({ a: G[i].r, b: G[j].r, body, title });
  }
  out.sort((x, y) => (y.body + y.title) - (x.body + x.title));
  return out.slice(0, SIMILAR_RULE.max);
}

/**
 * DeepSeek に設計知見を渡す前の伏せ（kb-curate・週の整理・kb-scene-tag・kb-priority 共通）。
 *   2026-10-08 竹内さん「DeepSeek に渡す時にお客様の LINE 名や呼んでいる名前は渡して良い・フォーマットの本名は渡さない」:
 *   - LINE の表示名・呼び名（conversations.customer_name・call_name）は伏せない
 *   - 申込フォーマット等の記入欄（氏名・フリガナ・生年月日・現住所・勤務先・緊急連絡先・連帯保証人 等。年収は基準として残す）の値は伏せる＝本名を渡さない
 *   - 電話・メール・生年月日・郵便番号の形は今まで通り伏せる
 *   戻す: KB_LLM_MASK_FORM=off（記入欄の値を伏せない＝旧の電話・メールだけ）
 */
const KB_FORM_FIELD_RE = /((?:ご?契約者|入居者|申込者|緊急連絡先|連帯保証人|保証人)?(?:の)?(?:氏名|お名前|フリガナ|ふりがな|生年月日|現住所|勤務先|勤め先|続柄|本籍))(\s*[（(][^）)\n]{0,10}[）)])?(\s*[:：]\s*)([^\n、,。]{1,40})/g;
export function maskForLlm(s: string): string {
  let t = String(s ?? "");
  if ((process.env.KB_LLM_MASK_FORM ?? "").trim().toLowerCase() !== "off") {
    t = t.replace(KB_FORM_FIELD_RE, (_m, label: string, paren: string | undefined, sep: string) => `${label}${paren ?? ""}${sep}［伏せ］`)
      .replace(/(?:19\d{2}|200\d|201[0-5])\s*[年.．/／]\s*\d{1,2}\s*[月.．/／]\s*\d{1,2}\s*日?生?/g, "［生年月日］")
      .replace(/〒\s*\d{3}\s*[-‐－ー]?\s*\d{4}/g, "［郵便番号］");
  }
  return t
    .replace(/0\d{1,4}-?\d{1,4}-?\d{3,4}/g, "［電話］")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "［メール］")
    .slice(0, 1200);
}
/**
 * 文字化け（2026-10-08 竹内さん「文字化けでないようにする」）: 9/01〜9/02 に PowerShell 5.1 の Invoke-RestMethod／Invoke-WebRequest へ
 *   文字列の -Body を渡して REST で INSERT した 11行は、本文が Latin-1 で送られて日本語が全部「?」になった（札だけは後の正規化で直っていた）。
 *   → 書く入口（kb-insert）で文字化けの形を断り、週の整理で現行の文字化けの行を要確認に出す。
 *   形: 置換文字（U+FFFD）・「?」が4つ以上続く・「?」が文字の2割以上（8文字以上の時）
 */
export function looksMojibake(s: string | null | undefined): boolean {
  const t = String(s ?? "");
  if (!t) return false;
  if (t.includes("�")) return true;
  if (/\?{4,}/.test(t)) return true;
  const q = (t.match(/\?/g) ?? []).length;
  return t.length >= 8 && q / t.length >= 0.2;
}
/** 行のどの欄が文字化けしているか（無ければ空） */
export function mojibakeFields(r: { title?: string | null; insight?: string | null; rationale?: string | null; context?: string | null; applied_to?: string | null; tags?: string[] | null }): string[] {
  const out: string[] = [];
  for (const k of ["title", "insight", "rationale", "context", "applied_to"] as const) if (looksMojibake(r[k] ?? "")) out.push(k);
  if ((r.tags ?? []).some((t) => looksMojibake(t))) out.push("tags");
  return out;
}

export const SIMILAR_SYSTEM = "あなたは社内の設計メモの整理係です。2つのメモ（A・B）の関係を1語で判定し、JSONだけで答えてください。"
  + "関係: same（同じ決まりの言い直し・どちらか1つで足りる）／supersedes_a（Bが新しくAの決まりを変えた・Aは古い）／supersedes_b（Aが新しくBの決まりを変えた）"
  + "／conflict（食い違うがどちらが正しいか書いていない）／related（関係はあるが別の決まり）／different（別の話）。"
  + '形: {"relation":"…","reason":"40字以内"}';
export function similarPrompt(a: KbRow, b: KbRow): string {
  return `A（${a.created_at.slice(0, 10)}）: ${maskForLlm(a.title)}\n${maskForLlm(a.insight)}\n\nB（${b.created_at.slice(0, 10)}）: ${maskForLlm(b.title)}\n${maskForLlm(b.insight)}`;
}
/**
 * 2026-10-07（段・竹内「設計知見もちゃんと整理して優先順位あげれる環境」）DeepSeek の関係の判定から、退役の計画か要確認を作る。
 *   勝手に退役するのは確かな物だけ: 「same」かつ埋め込みの近さ 0.95 以上（ほぼ同じ文）→ 中身の多い方を残す。
 *   上書き（supersedes）・食い違い（conflict）は新しい決定（段が上・新しい方）を残す案を付けて要確認へ（竹内さんが決める）
 */
export const CONFLICT_RULE = { autoSameMin: 0.95, sceneNearMin: 0.72 } as const;
export function planFromRelation(a: KbRow, b: KbRow, relation: string, reason: string, sim: number, src: "embedding" | "lexical" | "scene"): { retire: RetirePlan | null; review: ReviewItem | null } {
  if (relation === "different" || relation === "related") return { retire: null, review: null };
  const cmd = (oldR: KbRow, newR: KbRow) => `退役の案: scripts/kb-retire.ts --id=${oldR.id} --by=${newR.id}`;
  const pr = (r: KbRow) => (typeof r.priority === "number" ? r.priority : 2);
  const meta = `（近さ ${sim.toFixed(2)}・${src === "embedding" ? "埋め込み" : src === "scene" ? "同じ場面の決まり" : "文字の重なり"}）`;
  if (relation === "same") {
    if (src !== "lexical" && sim >= CONFLICT_RULE.autoSameMin) {
      const keep = pickKeeper(a, b), drop = keep.id === a.id ? b : a;
      return { retire: { id: drop.id, supersededBy: keep.id, kind: "duplicate", reason: `同じ決まりの言い直し（DeepSeek same・近さ ${sim.toFixed(2)}）→ 中身の多い方 ${keep.id} を残す` }, review: null };
    }
    const keep = pickKeeper(a, b), drop = keep.id === a.id ? b : a;
    return { retire: null, review: { kind: "similar", ids: [a.id, b.id], relation, note: `same: ${reason}${meta}・${cmd(drop, keep)}` } };
  }
  if (relation === "supersedes_a" || relation === "supersedes_b") {
    const [oldR, newR] = relation === "supersedes_a" ? [a, b] : [b, a];
    const odd = newR.created_at < oldR.created_at ? "・⚠ 日付は逆（上書きした方が古い）" : "";
    return { retire: null, review: { kind: "conflict", ids: [oldR.id, newR.id], relation, note: `上書き: ${reason}${meta}${odd}・${cmd(oldR, newR)}` } };
  }
  // conflict: 段が上（数が小さい）→ 新しい の順で残す方を案にする
  const [keep, drop] = pr(a) !== pr(b) ? (pr(a) < pr(b) ? [a, b] : [b, a]) : (a.created_at >= b.created_at ? [a, b] : [b, a]);
  return { retire: null, review: { kind: "conflict", ids: [drop.id, keep.id], relation, note: `食い違い: ${reason}${meta}・残す案は P${pr(keep)}・${keep.created_at.slice(0, 10)} の方・${cmd(drop, keep)}` } };
}

export function parseSimilar(text: string): { relation: string; reason: string } | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as { relation?: string; reason?: string };
    const rel = String(j.relation ?? "");
    if (!["same", "supersedes_a", "supersedes_b", "conflict", "related", "different"].includes(rel)) return null;
    return { relation: rel, reason: String(j.reason ?? "").slice(0, 80) };
  } catch { return null; }
}

// ── ④ 分野ごとの「今の決まり」のまとめ ──
export const AREAS: Array<{ area: string; tags: string[]; textRe: RegExp }> = [
  { area: "返信", tags: ["line-reply", "generate-reply", "final-check", "TPO", "自動返信", "validate-reply", "挨拶", "絵文字", "emoji", "初回返信", "reply"], textRe: /返信の下書き|下書き|最終チェック|final-check/ },
  { area: "AIX", tags: ["AIX", "AIX-META", "AIXツール", "AIXテンプレート", "AIX要対応", "aix-template-generate"], textRe: /AIX【/ },
  { area: "ブレイン", tags: ["ブレイン", "brain-core", "ブレイン診断", "分析強化の原則", "2層ブレイン", "brain-aix-feedback"], textRe: /ブレイン/ },
  { area: "物件検索", tags: ["物件検索", "物件オススメ", "物件ピックアップ", "property-brain", "採点", "AD", "相場", "エリア", "エリア表現", "自動検索", "一括検索"], textRe: /物件検索|ピックアップ|採点|🌟/ },
  { area: "拡張", tags: ["Chrome拡張", "拡張の版", "案内モード", "MutationObserver"], textRe: /拡張|リアプロ|ITANDI|itandi/ },
  { area: "見積書", tags: ["見積書"], textRe: /見積書/ },
  { area: "内覧", tags: ["内覧", "待ち合わせ場所", "内覧日調整"], textRe: /内覧|待ち合わせ/ },
  { area: "費用", tags: ["初期費用", "分割", "費用", "初期費用を説明"], textRe: /初期費用|分割|カード手数料|3\.24/ },
];
export function areasOf(r: KbRow): string[] {
  const tags = new Set(r.tags ?? []);
  const text = r.title;
  return AREAS.filter((a) => a.tags.some((t) => tags.has(t)) || a.textRe.test(text)).map((a) => a.area);
}

export const DIGEST_RULE = { decisions: 30, recent: 25, titleMax: 140 } as const;
/** 竹内さんの決定の行か（本文に竹内さんの言葉・決定・指示がある） */
export function isOwnerDecision(r: KbRow): boolean {
  return /竹内(さん)?[「『（]|竹内さんの(決定|指示|訂正)|竹内(さん)?「/.test(r.insight + "\n" + (r.context ?? ""));
}
// 2026-10-07 段（優先順位）の順に並べる: ① P0 絶対・最優先（分野に関係なく全部の分野の先頭）② 整理が見張る決定 ③ P1 今の決まり
//   ④ 竹内さんの言葉がある P2 ⑤ 最近の型・直し（P2）。P3（事例・経緯）はまとめに入れない（kb.ts で引く）
export function buildDigest(rows: KbRow[], area: string, nowIso: string): { markdown: string; ids: string[] } {
  const cur = rows.filter((r) => r.is_current && areasOf(r).includes(area));
  cur.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const short = (t: string) => (t.length > DIGEST_RULE.titleMax ? t.slice(0, DIGEST_RULE.titleMax) + "…" : t);
  const line = (r: KbRow) => `- ${short(r.title.replace(/\s+/g, " "))} ［${r.created_at.slice(0, 10)}・${r.id.slice(0, 8)}］`;
  const p0 = rows.filter((r) => r.is_current && effectivePriority(r) === 0).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const p0Ids = new Set(p0.map((r) => r.id));
  const rest = cur.filter((r) => !p0Ids.has(r.id) && effectivePriority(r) !== 3);
  const p1 = rest.filter((r) => effectivePriority(r) === 1).slice(0, DIGEST_RULE.decisions);
  const p1Ids = new Set(p1.map((r) => r.id));
  const dec = rest.filter((r) => !p1Ids.has(r.id) && isOwnerDecision(r)).slice(0, DIGEST_RULE.decisions);
  const decIds = new Set(dec.map((r) => r.id));
  const recent = rest.filter((r) => !p1Ids.has(r.id) && !decIds.has(r.id)).slice(0, DIGEST_RULE.recent);
  const decRules = DECISIONS.filter((d) => d.area === area);
  const md = [
    `# 今の決まり — ${area}（設計知見から自動で作成・${nowIso.slice(0, 10)}）`,
    "",
    `> 現行の行だけ（is_current=true）。［日付・id の先頭8字］が元の行。全文は \`npx tsx --env-file=.env.local scripts/kb.ts --q=<語>\` か SQL で id を引く。`,
    `> この分野の現行 ${cur.length}行。手で直さない（毎週 /api/cron/design-knowledge と scripts/kb-curate.ts が作り直す）。`,
    "",
    ...(p0.length ? ["## ★ 絶対・最優先（P0・全部の分野で先に守る）", ...p0.map(line), ""] : []),
    ...(decRules.length ? ["## 竹内さんの決定（整理の仕組みが見張っている物）", ...decRules.map((d) => `- ${d.label}`), ""] : []),
    ...(p1.length ? ["## 今の決まり（P1・新しい順）", ...p1.map(line), ""] : []),
    "## 竹内さんの言葉がある行（P2・新しい順）",
    ...(dec.length ? dec.map(line) : ["- （なし）"]),
    "",
    "## 最近の型・直し（新しい順）",
    ...(recent.length ? recent.map(line) : ["- （なし）"]),
    "",
  ].join("\n");
  return { markdown: md, ids: [...p0, ...p1, ...dec, ...recent].map((r) => r.id) };
}
