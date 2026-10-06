// app/lib/condition-restore.ts — LINE の言葉どおりに検索の条件を「足す・入れ替える・元に戻す・取り消す」決まり（純関数・DB も fetch も無し）
//
// 2026-10-06 ⑫ 竹内さん（R・スモラ 10/03「ちなみに旭区、都島区、城東区、阿倍野区、今里方面で同じような条件でお部屋はありますか？」）:
//   「このように連絡きた場合物件検索の条件に反映させる。それでやっぱり元々の条件で等きたばあいは、もともとの条件に戻すなど
//    LINEにしたがって物件検索の条件も変動するように、最新のお客さんが求めている条件で物件検索をできるように」
//   R で止まった所: 経路C（webhook）は希望エリアに5つを足した（正しい）→ 24秒後にブレインが condition_change_scope=temporary
//   （文に「今回だけ」の語は無い・「ちなみに〜ありますか」を参考と読んだ）→ condition-scope-server が希望エリアを元へ戻し、
//   上書き（search_override）は AIX の自動検索だけに載る（自動検索は一時停止中）＝手で押す検索は元の条件のまま。
//   9/30 以降のブレインの temporary（文の語なし）6件はスタッフの動きと照らして当たり0（scripts/audit-condition-reach.ts）。
//
// ここに置く物:
//   areaAskCue        「〇〇方面で（も）同じような条件でありますか／探して」＝エリアの追加の依頼（今後も探す側＝permanent）
//   areaMergeMode     希望エリアを足すか入れ替えるか（「〜に変えて」「〜じゃなくて」「エリアは変わり」だけ入れ替え・既定は足す）
//   areaAddedTokens   足した語（画面の帯に「+旭区・都島区…」と出す）
//   detectConditionRevert  「やっぱり元々の条件で」「最初の条件に戻して」「前の条件で」＝条件を戻す依頼
//   planConditionRestore   履歴（property_condition_history）から戻す値を決める（元々＝最初の値・前＝1つ前の変更の前）
//   planUndoLatestChange   画面の「元に戻す」＝一番新しい変更の束（同じ書き手・同じ発言）を取り消す
//   出口（登録の条件を書き換える）は誤削除0: 戻す値が空の列は戻さない（消さない）・今の値が同じ列は触らない

const nf = (s: unknown) => String(s ?? "").normalize("NFKC");

// ── エリアの追加の依頼 ───────────────────────────────────────────
// 場所の語（区・市・町・駅・方面・周辺・エリア・あたり・沿線）。時の「あたり」（9月中旬あたり・土曜の午後あたり）は外す
const PLACE_RE = /[一-鿿ァ-ヶA-Za-z]{1,10}(?:区|市|町|駅|方面|周辺|エリア|あたり|辺り|沿線)/g;
const TIME_PLACE_RE = /(?:旬|月末|月初|週末|午前|午後|夕方|朝|昼|夜|[0-9]日|[0-9]時|その|この|あの|どの)(?:あたり|辺り|頃|ごろ)$/;
const DAY_WORD_RE = /(?:日|曜|時)(?:あたり|辺り)$/;
// 「〜で（も・は・だと）…ありますか／ないですか／探して／紹介して／教えて」
const AREA_ASK_TAIL_RE = /(?:方面|周辺|エリア|あたり|辺り|沿線|区|市|町|駅)(?:の方|付近|近辺|近く)?(?:で|では|でも|にも|も|だと|なら|とか|とかで|とかでも)[^。！!？?\n]{0,40}?(?:あり(?:ます|ませ)|ある(?:か|でしょう)|ない(?:です|でしょう|か)|無い(?:です|でしょう|か)|あれば|探して|探し(?:て|た)?(?:もら|いただ|頂)|見つか|紹介|出ますか|教えて)/;
// 物件1件の問い合わせ（この物件・号室・URL）は条件の依頼ではない（condition-source-gate と同じ向き）
const PROPERTY_INQUIRY_RE = /https?:\/\/|号室|この物件|このお部屋|こちらの物件|こちらのお部屋|その物件|そのお部屋/;

/** 文の中の場所の語（時の「あたり」は除く） */
export function placeTokens(text: string | null | undefined): string[] {
  const t = nf(text);
  const out: string[] = [];
  for (const m of t.matchAll(PLACE_RE)) {
    const w = m[0];
    if (TIME_PLACE_RE.test(w) || DAY_WORD_RE.test(w)) continue;
    if (/^(?:そ|こ|あ|ど)の/.test(w)) continue;
    out.push(w);
  }
  return out;
}

/**
 * 「〇〇方面で（も）同じような条件でありますか」＝エリアの追加の依頼（今後も探す側）。無ければ null。
 *   2026-10-06 本番180日のお客様の発言 10,322件で当たる形を読んで作った（R・塚本駅加島駅・北区淀川区あたりで似たような条件・住吉区とかでも無いですか 等）
 */
export function areaAskCue(text: string | null | undefined): string | null {
  const t = nf(text);
  if (!t || PROPERTY_INQUIRY_RE.test(t)) return null;
  if (!placeTokens(t).length) return null;
  const m = t.match(AREA_ASK_TAIL_RE);
  if (!m) return null;
  // 時の言い方だけで当たった（「土曜の午後あたりで空いている日はありますか」）は外す
  const head = t.slice(0, (m.index ?? 0) + 6);
  if (!placeTokens(head).length) return null;
  return m[0];
}

// ── 足すか入れ替えるか ───────────────────────────────────────────
const AREA_REPLACE_RE = /(?:に|へ)(?:変えて|変更|変わ)|じゃなくて|じゃなく|ではなく|ではなくて|エリア(?:は|が|を)?変わ|から変え|(?:だけ|のみ)で(?:探|お願い|おねがい)|の代わりに|やめて[^。\n]{0,10}(?:で|に)/;
/** 希望エリアを入れ替えるか（既定は足す＝「〇〇でも」「同じような条件で〇〇方面は」は今のエリアを残す） */
export function areaMergeMode(text: string | null | undefined): "add" | "replace" {
  return AREA_REPLACE_RE.test(nf(text)) ? "replace" : "add";
}

/**
 * 入れ替えの時に、新しいエリアから外す語（「梅田じゃなくて難波で」の梅田）。否定の語より前の部分にある語。
 *   extracted は resolve-area が返した語（駅・区）。名前の芯（大阪市・駅を外した物）が否定の前の部分にあれば外す
 */
export function areasBeforeNegation(text: string | null | undefined, extracted: ReadonlyArray<string>): string[] {
  const t = nf(text);
  const m = t.match(/じゃなくて|じゃなく|ではなくて|ではなく|から変え|の代わりに|やめて/);
  if (!m || m.index == null) return [];
  const before = t.slice(0, m.index);
  const core = (x: string) => x.replace(/^(?:大阪府)?大阪市(?=.+区$)/, "").replace(/駅$/, "");
  return extracted.filter((x) => { const c = core(x); return c.length >= 2 && before.includes(c); });
}

/** 希望エリアの語の並び（「・」「、」「,」区切り） */
export function splitAreaList(s: string | null | undefined): string[] {
  return String(s ?? "").split(/[・、,，]+/).map((x) => x.trim()).filter(Boolean);
}
/** 足した語（画面の帯の「+旭区・都島区」用）。大阪市の前置きは外して見せる */
export function areaAddedTokens(oldArea: string | null | undefined, newArea: string | null | undefined): string[] {
  const key = (x: string) => x.replace(/^大阪(?:府)?(?:大阪)?市/, "").replace(/\s+/g, "");
  const before = new Set(splitAreaList(oldArea).map(key));
  return splitAreaList(newArea).filter((x) => !before.has(key(x))).map((x) => x.replace(/^大阪市(?=.+区$)/, ""));
}
/** 外した語（入れ替えの時に「−忍ヶ丘駅周辺」と出す） */
export function areaRemovedTokens(oldArea: string | null | undefined, newArea: string | null | undefined): string[] {
  return areaAddedTokens(newArea, oldArea);
}

// ── 元に戻す依頼 ───────────────────────────────────────────────
export type RevertCue = { kind: "original" | "previous"; fields: string[]; evidence: string };
/** 戻す時に見る列（検索に効く列だけ。condition-change-scope の SCOPE_REVERT_FIELDS と同じ並び） */
export const RESTORE_FIELDS = ["desired_area", "floor_plan", "rent_max", "rent_min", "floor_area_min", "walk_minutes", "building_age"] as const;
const COND_WORD = "(?:ご)?(?:条件|希望|エリア|場所|地域|家賃|予算|間取り|広さ)";
const ORIGINAL_WORD = "(?:元々|もともと|元|もと|最初|初め|はじめ|当初|一番最初)";
const PREVIOUS_WORD = "(?:前|以前|この前|先日|前回)";
const REVERT_RES: ReadonlyArray<{ re: RegExp; kind: RevertCue["kind"] }> = [
  // 「元々の条件で」「最初の条件でお願いします」「元の希望エリアに戻して」
  { re: new RegExp(`${ORIGINAL_WORD}の?${COND_WORD}[^。！!？?\\n]{0,8}?(?:で|に戻|のまま|でお願い|で探|が良|がい|に)`), kind: "original" },
  // 「条件を元に戻して」「エリアは最初に戻して」
  { re: new RegExp(`${COND_WORD}(?:を|は|も)?${ORIGINAL_WORD}(?:の(?:条件|やつ|ほう|方))?に戻`), kind: "original" },
  // 「前の条件に戻して」「エリアを前に戻して」— 「前の」は戻す動詞がある時だけ。
  //   本番180日の監査で「大国町エリアでも前送った条件でお探しして頂きたい」「以前お伝えさせて頂いたエリアでめぼしいのがあれば」は
  //   どちらも「前と同じ条件で（続けて・別のエリアでも）」＝戻す依頼ではなかった（2/2）
  { re: new RegExp(`${PREVIOUS_WORD}の?${COND_WORD}[^。！!？?\\n]{0,8}?に戻`), kind: "previous" },
  { re: new RegExp(`${COND_WORD}(?:を|は|も)?${PREVIOUS_WORD}(?:の(?:条件|やつ|ほう|方))?に戻`), kind: "previous" },
];
const RETURN_VERB_RE = /に戻/;
/** 物件・費用・書類の「前の〇〇」（前の物件・以前の初期費用）は条件を戻す依頼ではない */
const REVERT_NOT_RE = /(?:元々|もともと|元|最初|前|以前|当初)の?(?:物件|お部屋|部屋|初期費用|見積|御見積|書類|住所|家|職場|お家)/;

/** 「やっぱり元々の条件で」等の条件を戻す依頼（無ければ null）。戻す列は言った語で絞る（エリアだけ・家賃だけ） */
export function detectConditionRevert(text: string | null | undefined): RevertCue | null {
  const t = nf(text);
  if (!t || PROPERTY_INQUIRY_RE.test(t)) return null;
  for (const { re, kind } of REVERT_RES) {
    const m = t.match(re);
    if (!m) continue;
    if (REVERT_NOT_RE.test(m[0])) continue;
    // 「天王寺でも元々の条件で」＝別の場所で同じ条件（エリアの追加）。戻す動詞が無く場所の語がある文は戻す依頼にしない
    if (!RETURN_VERB_RE.test(m[0]) && placeTokens(t.replace(m[0], "")).length) continue;
    // 戻す列は依頼の語と、その直前（「エリアは最初の希望に戻して」「家賃を前の条件に戻して」）から読む
    const w = t.slice(Math.max(0, (m.index ?? 0) - 12), (m.index ?? 0) + m[0].length);
    const fields: string[] = [];
    if (/エリア|場所|地域/.test(w)) fields.push("desired_area");
    if (/家賃|予算/.test(w)) fields.push("rent_max", "rent_min");
    if (/間取り/.test(w)) fields.push("floor_plan");
    if (/広さ/.test(w)) fields.push("floor_area_min");
    return { kind, fields: fields.length ? fields : [...RESTORE_FIELDS], evidence: m[0] };
  }
  return null;
}

export type RestoreHistoryRow = { changed_field: string; old_value: string | null; new_value: string | null; created_at: string; source_message_id?: string | null };
const NUMERIC = new Set(["rent_max", "rent_min", "floor_area_min", "walk_minutes", "building_age"]);
const isEmpty = (v: unknown) => v == null || String(v).trim() === "";
const toValue = (f: string, v: string): unknown => (NUMERIC.has(f) ? Number(v) : v);

/** 履歴の1行の書き手（"p4:uuid"・"screen_edit"・"scope:temporary（brain）" → 頭の語） */
export function writerOf(src: string | null | undefined): string {
  const s = String(src ?? "").trim();
  if (!s) return "";
  return s.split(/[:：（(]/)[0];
}

/** 同じ変更の束か（同じ書き手の同じ発言・2分以内） */
function sameGroup(a: RestoreHistoryRow, b: RestoreHistoryRow): boolean {
  if (String(a.source_message_id ?? "") !== String(b.source_message_id ?? "")) return false;
  return Math.abs(Date.parse(a.created_at) - Date.parse(b.created_at)) <= 120_000;
}

export type RestorePlan = { updates: Record<string, unknown>; skipped: string[]; target: Record<string, string | null> };

/**
 * 戻す値を決める。
 *   original: 列ごとに履歴の一番古い old_value（無ければ一番古い new_value）＝最初に登録した値
 *     ※正式フォーマット（書き手 format）の行があれば、その一番新しい行の new_value を「元々」とする（フォーマットを送り直した人はそれが元）
 *   previous: 一番新しい変更の束（戻し・取り消し自身は飛ばさない＝「前の条件」は1つ前の状態）の old_value
 *   戻す値が空・今と同じ列は触らない（誤削除0）。戻さなかった理由は skipped に残す
 */
export function planConditionRestore(rows: ReadonlyArray<RestoreHistoryRow>, current: Record<string, unknown> | null | undefined, cue: Pick<RevertCue, "kind" | "fields">): RestorePlan {
  const updates: Record<string, unknown> = {};
  const skipped: string[] = [];
  const target: Record<string, string | null> = {};
  const fields = cue.fields.filter((f) => (RESTORE_FIELDS as readonly string[]).includes(f));
  const sorted = [...rows].filter((r) => fields.includes(r.changed_field) && Number.isFinite(Date.parse(r.created_at)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!sorted.length) return { updates, skipped: ["履歴が無い（戻す先が分からない）"], target };
  if (cue.kind === "original") {
    for (const f of fields) {
      const list = sorted.filter((r) => r.changed_field === f);
      if (!list.length) continue;
      const formats = list.filter((r) => writerOf(r.source_message_id) === "format");
      const lastFormat = formats[formats.length - 1];
      target[f] = lastFormat ? lastFormat.new_value : (!isEmpty(list[0].old_value) ? list[0].old_value : list[0].new_value);
    }
  } else {
    const last = sorted[sorted.length - 1];
    const group = sorted.filter((r) => sameGroup(r, last));
    for (const f of fields) {
      const g = group.filter((r) => r.changed_field === f);
      if (g.length) target[f] = g[0].old_value;
    }
  }
  for (const [f, v] of Object.entries(target)) {
    if (isEmpty(v)) { skipped.push(`${f}（戻す先が空＝消さない）`); continue; }
    if (String(current?.[f] ?? "") === String(v)) continue;
    const val = toValue(f, String(v));
    if (NUMERIC.has(f) && !Number.isFinite(val as number)) { skipped.push(`${f}（数字でない ${v}）`); continue; }
    updates[f] = val;
  }
  return { updates, skipped, target };
}

/**
 * 画面の「元に戻す」: 一番新しい変更の束（同じ書き手・同じ発言・2分以内）を取り消す。
 *   今の値がその束の new_value と違う列（後で人が直した等）は戻さない。戻す先が空の列も戻さない（消さない）
 */
export function planUndoLatestChange(rows: ReadonlyArray<RestoreHistoryRow>, current: Record<string, unknown> | null | undefined): RestorePlan & { group: RestoreHistoryRow[] } {
  const sorted = [...rows].filter((r) => (RESTORE_FIELDS as readonly string[]).includes(r.changed_field) && Number.isFinite(Date.parse(r.created_at)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const updates: Record<string, unknown> = {};
  const skipped: string[] = [];
  const target: Record<string, string | null> = {};
  if (!sorted.length) return { updates, skipped: ["履歴が無い"], target, group: [] };
  const last = sorted[sorted.length - 1];
  const group = sorted.filter((r) => sameGroup(r, last));
  const byField = new Map<string, RestoreHistoryRow[]>();
  for (const r of group) byField.set(r.changed_field, [...(byField.get(r.changed_field) ?? []), r]);
  for (const [f, list] of byField) {
    const first = list[0], end = list[list.length - 1];
    if (String(current?.[f] ?? "") !== String(end.new_value ?? "")) { skipped.push(`${f}（後で変わっている）`); continue; }
    target[f] = first.old_value;
    if (isEmpty(first.old_value)) { skipped.push(`${f}（戻す先が空＝消さない）`); continue; }
    const val = toValue(f, String(first.old_value));
    if (NUMERIC.has(f) && !Number.isFinite(val as number)) { skipped.push(`${f}（数字でない）`); continue; }
    updates[f] = val;
  }
  return { updates, skipped, target, group };
}

/** 画面の帯に出す変更の1行（「エリア: +旭区・都島区（元: 忍ヶ丘駅周辺）」）。additional_conditions の auto 行の中身 */
export function describeAreaChange(oldArea: string | null | undefined, newArea: string | null | undefined): string | null {
  const added = areaAddedTokens(oldArea, newArea);
  const removed = areaRemovedTokens(oldArea, newArea);
  if (!added.length && !removed.length) return null;
  const parts: string[] = [];
  if (added.length) parts.push(`+${added.join("・")}`);
  if (removed.length) parts.push(`−${removed.join("・")}`);
  return `エリア変更: ${parts.join(" ")}`;
}
