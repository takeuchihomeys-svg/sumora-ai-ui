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
//
// 2026-09-30 強化（竹内「一時調整でその一回限定して行うか、そもそもの条件自体を変えるのかの判断の部分も強化する」・YUMA「今回だけ1階も」）:
//   決め方を5段に（上から順に・最初に決まった物）:
//   1. 強い「今回だけ」の語（今回だけ・今回は〜も・今だけ・1回だけ・一時的・試しに・ついでに・参考に見たい・比較・〜した場合の物件も）→ temporary
//      ただし「今回だけじゃなく」「今回だけでなく」は今回だけの語にしない
//   2. 期間の「これから」の語（これからは・今後は・次から・以降は・この先・ずっと）→ permanent（期間を言い切っている＝切り替え）
//   3. 弱い「今回だけ」の語（一旦・いったん・とりあえず・ひとまず・取り急ぎ）→ temporary（text_temporary_weak）
//      ただし登録の条件がまだ無い人（初めての条件の文「とりあえず梅田で1Kで探してます」）には使わない＝戻す先の条件が無い。
//      registered を渡さない呼び出し（ブレインの後）は condition-scope-server.ts が「戻す先が空なら切り替えのまま」で守る
//   4. 切り替えの語（条件変更・〜に変えて・〜に変更・やっぱり・〜じゃなくて・〜で探してます 等）→ permanent
//   5. ブレインの condition_change_scope → 6. 既定 permanent
//   弱い語（3）を切り替えの語（4）より先にする理由: 竹内 9/30「誤って条件そのものを変える（出口）は慎重に・一時調整（入口）は広めでよい」。
//     「一旦1Kに変えて」は今回だけで検索（登録は変えない）→ 本当に切り替えなら次の言い直し・スタッフの手直しで直る（害が小さい）。
//   実データ（2026-09-30 監査 scripts/audit-condition-scope.ts・180日のお客様の発言 9,884件）: 「今回だけ」の語を言うお客様はほぼいない
//     （条件の語＋期間／変更の語の文 103件のうち、スタッフの返事が「ひとまず」「一旦」で今回だけだった物は2件）。
//     「〜でもいい」「〜でも大丈夫」（13＋8件）はスタッフが「〜も含めて」「条件に加え」と返し、登録の条件に足す物（切り替え側）→ 今回だけの語にしない

/** none＝検索条件の話ではない（お客様が送った物件・特定の物件の質問・見積依頼）。ブレインの cond の札の付け過ぎ（2026-09-27 監査: cond ありの番の約3/4）を止める */
export type ConditionChangeScope = "permanent" | "temporary" | "none";
export type ScopeDecidedBy = "text_temporary" | "text_temporary_weak" | "text_permanent_future" | "text_permanent" | "text_permanent_area_ask" | "brain" | "default";
export type ScopeDecision = { scope: ConditionChangeScope; by: ScopeDecidedBy; evidence: string | null };

import { areaAskCue } from "@/app/lib/condition-restore";

const norm = (s: string | null | undefined) => String(s ?? "").normalize("NFKC").replace(/\s+/g, " ");

// 「今回だけ」の語。検索の条件の話の文でだけ使う（呼び出し元はブレインの condition_change_type・P4 の抽出がある時だけ呼ぶ）
const TEMPORARY_RES: ReadonlyArray<RegExp> = [
  // 「今回だけじゃなく（これからも）」「今回だけでなく」は今回だけの語ではない（2026-09-30）
  /今回(?:だけ|のみ|限り|に限って|に限り)(?!\s?(?:じゃ|では|で)?な[くい])/,
  // 2026-09-30 YUMA「今回は1階も見てみたい」: 「今回は〜も（見たい・探して・OK）」も今回だけ（断りの「今回は見送ります」は temporaryScopeCue の頭で外す）
  /今回は[^。!?！？\n]{0,20}?(?:も|でも)[^。!?！？\n]{0,12}?(?:見|探|含|OK|ok|大丈夫|いい|良い|可|構わ|送)/,
  /今だけ/,
  /(?:1|一)(?:回|度)(?:だけ|限り)/,
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
// 弱い「今回だけ」の語（2026-09-30）。「一旦家賃12万で」「とりあえず福島区も」＝ひとまずその条件で見る（登録の条件は変えない）。
//   初めての条件の文（「とりあえず梅田で1Kで探してます」）にも出るので、登録の条件がある人だけに使う（resolveConditionChangeScope の registered）
const WEAK_TEMPORARY_RES: ReadonlyArray<RegExp> = [
  /(?:一旦|いったん|とりあえず|取り敢えず|取りあえず|ひとまず|取り急ぎ)/,
  // 本番「一度、一階のお部屋もお願いしたいです！」＝一度（試しに）〜も見たい。「一度内覧したい」は「も」が無いので当たらない
  /一度[、,\s]?[^。!?！？\n]{0,20}?も(?:見|探|お願い|おねがい|送)/,
];
// 期間の「これから」の語（2026-09-30）。言い切っている＝切り替え。弱い「今回だけ」の語より強い（「とりあえず今後は1Kで」は切り替え）
//   「今後ともよろしく」「今後もよろしく」（挨拶）・「10月以降の入居」（入居時期）は入れない
const FUTURE_PERMANENT_RES: ReadonlyArray<RegExp> = [
  /これから(?:は|先)/,
  /これからも(?!\s?(?:よろしく|宜しく|お願い))/,
  /今後(?:は|の(?:条件|希望|検索))/,
  /今後も(?!\s?(?:よろしく|宜しく|お願い))/,
  /次(?:回)?から(?:は)?/,
  /(?:これ|次回|今回)以降/,
  /この先(?:は)?/,
  /ずっと(?:この|その)?条件/,
];
// 「切り替え」の語（今後ずっとこの条件で）
const PERMANENT_RES: ReadonlyArray<RegExp> = [
  /条件(?:を|の)?(?:変更|変え|切り替え|切替|見直)/,
  /(?:に|へ)(?:変更|切り替え|切替)/,
  // 2026-09-30 「やっぱり1Kに変えて」「2LDKに変えたい」
  /(?:に|へ)変え(?:て|たい|ます|る)/,
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

/** お客様の文の「切り替え」の語（無ければ null）。期間の「これから」の語も含む（aix-jev-materials の材料と同じ読み） */
export function permanentScopeCue(text: string | null | undefined): string | null {
  const t = norm(text);
  return firstHit(t, FUTURE_PERMANENT_RES) ?? firstHit(t, PERMANENT_RES);
}

/** 期間の「これから」の語（これからは・今後は・次から・以降）。無ければ null */
export function futurePermanentScopeCue(text: string | null | undefined): string | null {
  return firstHit(norm(text), FUTURE_PERMANENT_RES);
}

/** 弱い「今回だけ」の語（一旦・とりあえず・ひとまず）。無ければ null。断りの文（「今回は見送ります」）は temporaryScopeCue と同じく外す */
export function weakTemporaryScopeCue(text: string | null | undefined): string | null {
  const t = norm(text);
  if (!t) return null;
  return firstHit(t, WEAK_TEMPORARY_RES);
}

/** 登録の条件がある人か（希望エリア・家賃の上限・間取りのどれか）。弱い「今回だけ」の語は、戻す先の条件がある人だけに使う */
export function hasRegisteredConditions(r: Record<string, unknown> | null | undefined): boolean {
  if (!r) return false;
  const s = (v: unknown) => (v == null ? "" : String(v).trim());
  return !!(s(r.desired_area) || s(r.floor_plan) || (Number(r.rent_max) > 0));
}

/** ブレインの出力の欄を読む（形が違えば null） */
export function normalizeBrainScope(v: unknown): ConditionChangeScope | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return s === "permanent" || s === "temporary" || s === "none" ? s : null;
}

/**
 * 条件の言い直しの置き場所を決める（上の 1〜6 の順）。
 *   registered: その発言の前の登録の条件（分かる時だけ）。渡して空なら弱い「今回だけ」の語は使わない（初めての条件の文）。
 *   渡さない時（ブレインの後）は使う＝condition-scope-server.ts が「戻す先の条件が空なら切り替えのまま」で守る
 */
export function resolveConditionChangeScope(input: { text: string | null | undefined; brainScope?: unknown; registered?: Record<string, unknown> | null }): ScopeDecision {
  const tmp = temporaryScopeCue(input.text);
  if (tmp) return { scope: "temporary", by: "text_temporary", evidence: tmp };
  const future = futurePermanentScopeCue(input.text);
  if (future) return { scope: "permanent", by: "text_permanent_future", evidence: future };
  const weak = weakTemporaryScopeCue(input.text);
  if (weak && (input.registered === undefined || hasRegisteredConditions(input.registered))) return { scope: "temporary", by: "text_temporary_weak", evidence: weak };
  const perm = firstHit(norm(input.text), PERMANENT_RES);
  if (perm) return { scope: "permanent", by: "text_permanent", evidence: perm };
  // 2026-10-06 ⑫ 竹内（R「ちなみに旭区、都島区…今里方面で同じような条件でお部屋はありますか？」）「このように連絡きた場合物件検索の条件に反映させる」:
  //   エリアの追加の依頼（〇〇方面でも・〇〇ではありますか）はブレインより先に切り替え側。ブレインは「ちなみに〜ありますか」を参考（temporary）と読み、
  //   登録の希望エリアを戻していた（9/30 以降のブレインの temporary・文の語なし 6件はスタッフの動きと照らして当たり0）。本番180日で当たる 53通は全部エリアの依頼
  const areaAsk = areaAskCue(input.text);
  if (areaAsk) return { scope: "permanent", by: "text_permanent_area_ask", evidence: areaAsk };
  const b = normalizeBrainScope(input.brainScope);
  if (b) return { scope: b, by: "brain", evidence: null };
  return { scope: "permanent", by: "default", evidence: null };
}

// ─────────────────────────── 未返信の発言の束（2026-09-30） ───────────────────────────
// ブレインの後の判断に渡る文（msgText）は、未返信のお客様の発言を区切り（reply-context MSG_SEP＝U+2063）でつないだ物。
//   YUMA の通しテスト: 先の発言「今回だけ1階も見たいです」が未返信のまま「これからは駅10分以内でお願いします」「やっぱり1Kに変えてください」が来ると、
//   束の中の「今回だけ」に当たって後の発言まで今回だけ（temporary）になり、P4 が書いた登録の変更（間取り 1K）まで戻された。
//   直し: 判断は発言ごと。
//     ・最後の発言＝今回の判断（文の語 → ブレイン → 既定）。P4 の書き込みを戻す・記録に残す・条件の橋／条件ブレインを動かすかはこれで決める
//     ・前の発言＝文の語だけ（ブレインの欄は最後の発言への答えなので使わない）。「今回だけ」の語がある発言は、返信するまでその回の上書きに残す
//   上書き（その回だけの検索の条件）は「今回だけ」の発言だけから作る（temporaryText）。登録を書く側（橋・条件ブレイン）には今回だけの発言を渡さない（permanentText）
export const BUNDLE_SEP = "\u2063";
export type BundleScope = {
  /** 最後の発言の判断（今回の判断） */
  decision: ScopeDecision;
  lastText: string;
  /** 今回だけの発言をつないだ物（その回の上書きの元）。無ければ null */
  temporaryText: string | null;
  /** 今回だけでない発言をつないだ物（登録を書く側に渡す文）。無ければ null */
  permanentText: string | null;
  parts: number;
};
export function resolveScopeForBundle(input: { text: string | null | undefined; brainScope?: unknown; registered?: Record<string, unknown> | null }): BundleScope {
  const raw = String(input.text ?? "");
  const parts = raw.split(BUNDLE_SEP).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) {
    const d = resolveConditionChangeScope(input);
    const only = parts[0] ?? raw;
    return { decision: d, lastText: only, temporaryText: d.scope === "temporary" ? only : null, permanentText: d.scope === "permanent" ? only : null, parts: parts.length };
  }
  const last = parts[parts.length - 1];
  const decision = resolveConditionChangeScope({ text: last, brainScope: input.brainScope, registered: input.registered });
  const temp: string[] = [], perm: string[] = [];
  for (const p of parts.slice(0, -1)) {
    // 前の発言は文の語だけ: 強い今回だけ → 今回だけ／期間の「これから」→ 切り替え／弱い今回だけ → 今回だけ／それ以外は切り替え側（今まで通り登録を書く側に渡る）
    const isTemp = !!temporaryScopeCue(p) || (!futurePermanentScopeCue(p) && !!weakTemporaryScopeCue(p));
    (isTemp ? temp : perm).push(p);
  }
  if (decision.scope === "temporary") temp.push(last);
  else if (decision.scope === "permanent") perm.push(last);
  const join = (a: string[]) => (a.length ? a.join(`\n${BUNDLE_SEP}\n`) : null);
  return { decision, lastText: last, temporaryText: join(temp), permanentText: join(perm), parts: parts.length };
}

/**
 * ブレインより先に走る経路（P4・フォームの読み取り）が登録の条件を書いてよいか（「今回だけ」の語が無い時だけ書く）。
 *   強い語は必ず止める。弱い語（一旦・とりあえず）は登録の条件がある人（registered を渡して空でない）の時だけ止める
 *   （渡さない P4 は書く→ブレインが今回だけと決めたら condition-scope-server が戻す）。期間の「これから」の語があれば書く
 */
export function preBrainMayWriteRegistered(text: string | null | undefined, registered?: Record<string, unknown> | null): { ok: boolean; evidence: string | null } {
  const tmp = temporaryScopeCue(text);
  if (tmp) return { ok: false, evidence: tmp };
  if (registered !== undefined && hasRegisteredConditions(registered) && !futurePermanentScopeCue(text)) {
    const weak = weakTemporaryScopeCue(text);
    if (weak) return { ok: false, evidence: weak };
  }
  return { ok: true, evidence: null };
}

/** 登録の条件を戻す時に見る列（検索に効く列だけ。こだわり・NG の文字の列は戻さない＝メモとして残る） */
export const SCOPE_REVERT_FIELDS = ["desired_area", "floor_plan", "rent_max", "rent_min", "floor_area_min", "walk_minutes", "building_age"] as const;
const NUMERIC_REVERT = new Set(["rent_max", "rent_min", "floor_area_min", "walk_minutes", "building_age"]);

export type HistoryRowLite = { changed_field: string; old_value: string | null; new_value: string | null; created_at: string };

/** P4・ブレインの橋が additional_conditions に足す行「[9/30 17:23|auto] 家賃上限: 120000」の見出し（line-webhook-text FIELD_LABELS と同じ字） */
export const REVERT_NOTE_LABELS: Record<string, string> = {
  desired_area: "エリア", floor_plan: "間取り", rent_max: "家賃上限", rent_min: "家賃下限", floor_area_min: "広さ(㎡以上)", walk_minutes: "徒歩分数", building_age: "築年数",
};
/**
 * 2026-09-30 YUMA「一旦家賃12万で」: 登録の家賃は 9万に戻したのに、追加条件に「[9/30 17:23|auto] 家賃上限: 120000」が残った
 *   （新着要望の帯・自由文を読む判定に今回だけの値が残る）。戻した列について、その発言で足された行の「見出し: 書いた値」だけを外す（純関数）。
 *   written: 列 → P4 が書いた値（履歴の最後の new_value）。一番後ろの auto の行から探し、見出しと値がそのまま一致する所だけ（無ければ何もしない）。
 *   同じ行の他の項目（こだわり等）は残す・行が空になれば行ごと外す・人が書いた行（|auto でない）は触らない
 */
export function stripRevertedAutoNotes(additional: string | null | undefined, written: Record<string, unknown>): { text: string | null; removed: string[] } {
  const src = String(additional ?? "");
  const removed: string[] = [];
  if (!src.trim()) return { text: additional == null ? null : src, removed };
  const lines = src.split("\n");
  for (const [field, val] of Object.entries(written)) {
    const label = REVERT_NOTE_LABELS[field];
    if (!label || val == null || String(val) === "") continue;
    const seg = `${label}: ${String(val)}`;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^(\[[^\]]*\|auto\]\s?)(.*)$/);
      if (!m) continue;
      const body = m[2];
      const at = body.indexOf(seg);
      if (at < 0) continue;
      // 値の途中で切らない（「家賃上限: 120000」が「家賃上限: 1200000」の頭に当たらない）
      const after = body.slice(at + seg.length);
      const before = body.slice(0, at);
      if (after && !after.startsWith("、")) continue;
      if (before && !before.endsWith("、")) continue;
      const rest = (before + after.replace(/^、/, "")).replace(/、$/, "").trim();
      if (rest) lines[i] = m[1] + rest; else lines.splice(i, 1);
      removed.push(seg);
      break;
    }
  }
  // 2026-10-06 経路C が足す「[…|auto] エリア変更: +旭区・都島区」（画面の帯に出す差分）も、希望エリアを戻した時は外す（一番後ろの1行だけ）
  if (written.desired_area != null && String(written.desired_area) !== "") {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^\[[^\]]*\|auto\]\s?(エリア変更: .*)$/);
      if (!m) continue;
      removed.push(m[1]);
      lines.splice(i, 1);
      break;
    }
  }
  const out = lines.join("\n").trim();
  return { text: out ? out : null, removed };
}

/**
 * ブレインが「今回だけ」と決めた時に、P4 がこの発言で書いた登録の条件を戻す値を決める（純関数）。
 *   その発言の時刻（少し前から）より後の履歴だけ・列ごとに一番古い old_value へ戻す。
 *   今の値が履歴の最後の new_value と違う列（間にスタッフが手で直した等）は戻さない。
 */
export function planScopeRevert(
  rows: ReadonlyArray<HistoryRowLite>,
  current: Record<string, unknown> | null | undefined,
  sinceIso: string,
  opts: { slackMs?: number; keepNewFields?: boolean } = {},
): { updates: Record<string, unknown>; skipped: string[]; written: Record<string, unknown> } {
  const since = Date.parse(sinceIso) - (opts.slackMs ?? 10_000);
  const updates: Record<string, unknown> = {};
  const skipped: string[] = [];
  /** 戻す列 → この発言で書かれていた値（追加条件の行から同じ値を外すのに使う・stripRevertedAutoNotes） */
  const written: Record<string, unknown> = {};
  if (!Number.isFinite(since)) return { updates, skipped, written };
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
    // 2026-09-30 弱い「今回だけ」の語（一旦・とりあえず）の時は、この発言で初めて入った列（元が空）は戻さない＝初めての条件を消さない
    if ((ov == null || ov === "") && opts.keepNewFields) { skipped.push(`${f}（この発言で初めて入った列・弱い語なので残す）`); continue; }
    if (ov == null || ov === "") updates[f] = null;
    else if (NUMERIC_REVERT.has(f)) { const n = Number(ov); if (Number.isFinite(n)) updates[f] = n; else skipped.push(`${f}（数字でない ${ov}）`); }
    else updates[f] = ov;
    if (f in updates) written[f] = last.new_value;
  }
  return { updates, skipped, written };
}

// ─────────────────────────── 当たり外れ（2026-09-30） ───────────────────────────
// 竹内「一時調整でその一回限定して行うか、そもそもの条件自体を変えるのかの判断の部分も強化する」:
//   判断（condition_scope_decisions の1行）を、その後のスタッフの動きと照らして「どちらが正しかったか」を決める（純関数）。
//   週のまとめ（condition-scope-server.ts weeklyConditionScope）と過去の監査（scripts/audit-condition-scope.ts）が同じ物差しを使う。
//   物差し（上から・最初に決まった物）:
//   1. スタッフが登録の条件を手で直した（履歴の書き手 screen_edit／manual）→ 72時間以内に元に戻した＝temporary／戻さない＝permanent
//      （P4・ブレインの橋など自動の書き手は判断を受けた側なので物差しにしない。scope:temporary の戻しも同じ）
//   2. スタッフがメモの一時調整で検索した（web_brain の search_override）＝temporary
//   3. スタッフの返事の言い方: 今回は・ひとまず・一旦・試しに＝temporary／今後は・条件を変更・条件に加え・も含めて・外し・新しい条件で＝permanent
//   4. どれも無い＝unknown（当たり外れに数えない）
export type ScopeOutcome = "permanent" | "temporary" | "unknown";
export type ScopeFollowup = {
  /** 判断の後の条件の履歴（source_message_id の書き手で人の手直しを見分ける） */
  history: ReadonlyArray<HistoryRowLite & { source_message_id?: string | null }>;
  /** 判断の後のスタッフのメモの一時調整の検索（automation_commands の web_brain で search_override がある物）の時刻 */
  overrideAt: ReadonlyArray<string>;
  /** 判断の後のスタッフの返事（最初の数通） */
  staffTexts: ReadonlyArray<{ text: string | null; created_at: string }>;
};
const STAFF_TEMP_RE = /今回(?:は|だけ|のみ)|ひとまず|一旦|いったん|とりあえず|試しに|参考まで/;
const STAFF_PERM_RE = /今後は|これからは|(?:ご)?条件(?:を|も)?(?:変更|切り替え|追加|加え)|条件に加え|も含めて|外し(?:て|、)|新しい(?:ご)?条件|改めて(?:ピックアップ|お探し|お部屋)/;
const HUMAN_WRITER_RE = /^(?:screen_edit|manual)/i;

export function labelScopeOutcome(decidedAtIso: string, f: ScopeFollowup, opts: { windowMs?: number; revertMs?: number } = {}): { truth: ScopeOutcome; evidence: string } {
  const t0 = Date.parse(decidedAtIso);
  const win = opts.windowMs ?? 72 * 3600_000;
  if (!Number.isFinite(t0)) return { truth: "unknown", evidence: "時刻が読めない" };
  const inWin = (iso: string, w = win) => { const t = Date.parse(iso); return Number.isFinite(t) && t >= t0 - 60_000 && t <= t0 + w; };
  // 1. 人の手直し
  const human = f.history.filter((h) => HUMAN_WRITER_RE.test(String(h.source_message_id ?? "")) && (SCOPE_REVERT_FIELDS as readonly string[]).includes(h.changed_field));
  const firstHuman = human.filter((h) => inWin(h.created_at)).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (firstHuman) {
    const revertWin = opts.revertMs ?? 72 * 3600_000;
    const back = f.history.find((h) => h.changed_field === firstHuman.changed_field && h.created_at > firstHuman.created_at
      && Date.parse(h.created_at) - Date.parse(firstHuman.created_at) <= revertWin && String(h.new_value ?? "") === String(firstHuman.old_value ?? ""));
    return back
      ? { truth: "temporary", evidence: `人が ${firstHuman.changed_field} を直して元に戻した` }
      : { truth: "permanent", evidence: `人が ${firstHuman.changed_field} を直したまま（${String(firstHuman.old_value ?? "").slice(0, 20)}→${String(firstHuman.new_value ?? "").slice(0, 20)}）` };
  }
  // 2. メモの一時調整で検索
  const ov = f.overrideAt.find((iso) => inWin(iso));
  if (ov) return { truth: "temporary", evidence: "スタッフがメモの一時調整で検索" };
  // 3. スタッフの返事（24時間以内の最初の3通）
  const replies = f.staffTexts.filter((s) => inWin(s.created_at, 24 * 3600_000) && s.text).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, 3);
  for (const r of replies) {
    const txt = String(r.text).normalize("NFKC");
    const tm = txt.match(STAFF_TEMP_RE), pm = txt.match(STAFF_PERM_RE);
    if (tm && !pm) return { truth: "temporary", evidence: `返事「${tm[0]}」` };
    if (pm && !tm) return { truth: "permanent", evidence: `返事「${pm[0]}」` };
  }
  return { truth: "unknown", evidence: "スタッフの動きから決められない" };
}

/** 判断の当たり外れを数える（週のまとめ・監査）。unknown・none は数えない */
export function scoreScopeDecisions(rows: ReadonlyArray<{ scope: string; by: string; truth: ScopeOutcome }>): {
  n: number; hit: number; wrongPermanent: number; wrongTemporary: number; byRule: Record<string, { n: number; hit: number }>;
} {
  let n = 0, hit = 0, wrongPermanent = 0, wrongTemporary = 0;
  const byRule: Record<string, { n: number; hit: number }> = {};
  for (const r of rows) {
    if (r.truth === "unknown" || (r.scope !== "permanent" && r.scope !== "temporary")) continue;
    n++;
    const ok = r.scope === r.truth;
    if (ok) hit++;
    else if (r.scope === "permanent") wrongPermanent++; // 今回だけなのに登録を直した（出口の誤り＝重い）
    else wrongTemporary++; // 切り替えなのに今回だけ（入口の誤り＝次の言い直しで直る）
    const b = (byRule[r.by] ??= { n: 0, hit: 0 });
    b.n++; if (ok) b.hit++;
  }
  return { n, hit, wrongPermanent, wrongTemporary, byRule };
}
