/**
 * 統括に材料が「届いているか」を自動で点検する（2026-11-15 竹内さん）
 *
 *   竹内さん「追加する」「強化したらちゃんと反映されるように統括もちゃんと把握するように」
 *   「必要な土台があれば強化する」
 *
 * ★ なぜ要るか（**同じ失敗を2回した**）
 *   ① `toggles`（外した/選んだ）を作ったのに `buildMeeting` に渡していなかった
 *      → 統括の根拠にも議題にも**出ていなかった**（作った意味が無かった）
 *   ② `shot_learn`（写真から読んだ欄）は415件学んでいたのに、束には**数だけ**で中身が無かった
 *      → 統括は「学べている」と知らないままだった
 *
 *   どちらも**「作った」のに「届いていない」**。目で見て気づくしかない状態だった。
 *   → **機械的に点検する**（材料の項目が全部、統括の材料に入っているかを毎回確かめる）。
 *
 * ★ 点検の仕方
 *   ・`SupervisorInput` の項目名を**ソースから読む**
 *   ・`buildMeeting` に渡している所を**ソースから読む**（変数名に変換されている物も追う）
 *   ・渡っていない物があれば**名指し**する
 *   ⚠ これは「配線の点検」。中身が正しいかは別（それは数字で見る）。
 */

/** 点検の結果 */
export type WiringReport = {
  /** 材料の項目（全部） */
  total: number;
  /** 統括に届いている項目 */
  wired: string[];
  /** 届いていない項目 */
  missing: string[];
  /** 点検できたか（ソースが読めない時は false） */
  ok: boolean;
  /** 人が読む1行 */
  line: string;
};

/**
 * `SupervisorInput` の項目名を抜く（純関数）。
 *   ⚠ コメントアウトされた物・入れ子の物（`commands` の中の `total` など）は拾わない。
 *     拾うのは**トップレベルの `key?:` だけ**（インデント2つ）。
 */
export function inputKeys(src: string): string[] {
  const s = String(src ?? "");
  const start = s.indexOf("export type SupervisorInput = {");
  if (start < 0) return [];
  // 次の `export type` までを範囲にする
  const next = s.indexOf("\nexport type ", start + 10);
  const body = s.slice(start, next > 0 ? next : s.length);
  const keys: string[] = [];
  const re = /^ {2}([a-z_][a-z0-9_]*)\??:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (keys.indexOf(m[1]) < 0) keys.push(m[1]);
  }
  return keys;
}

/**
 * `buildMeeting({...})` に渡している**項目名**を抜く（純関数）。
 *   ⚠ 材料の名前と、渡す時の名前が違う物がある（`shot_rows` → `shotRows`）。
 *     → **変換表**で対応させる（`camelOf`）。
 */
export function buildMeetingArgs(src: string): string[] {
  const s = String(src ?? "");
  /**
   * ⚠ 実測: 実際は `    meeting: buildMeeting({`（**行頭に4つの空白**）。
   *   `"meeting: buildMeeting({"` で探すと**見つからなかった**（点検が丸ごと効かなかった）。
   *   → **空白を許す形**で探す。
   *
   * ⚠ 括弧を数える方式は、コメントや文字列の中の括弧で狂う（実測で0件になった）。
   *   → **行で見る**: `buildMeeting({` の行から始めて、
   *     **深さ0に戻る行**（`}),` など）までを範囲にする。深さは行頭の括弧だけで数える。
   */
  const lines = s.split("\n");
  const startLine = lines.findIndex((l) => /meeting:\s*buildMeeting\(\{/.test(l));
  if (startLine < 0) return [];
  const args: string[] = [];
  let depth = 0;
  let started = false;
  for (let i = startLine; i < lines.length; i++) {
    const ln = lines[i];
    // コメント行は深さに数えない
    const code = ln.replace(/\/\/.*$/, "").replace(/\*.*$/, "");
    if (!started) { started = true; depth = 1; continue; }   // `buildMeeting({` の行
    // トップレベル（深さ1のまま）の `key:` を拾う
    const m = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/.exec(code);
    if (m && depth === 1) args.push(m[1]);
    /**
     * ⚠ 実測: 実際は**1行にまとめて**書かれている:
     *   `site, verdict, coverage, rows, next, points, opens, screens, sequence,`
     *   → 行ごとの `key:` だけ見ると**11件を取りこぼした**（本当は届いている）。
     *   → 深さ1の時は**カンマ区切りの名前だけの行**も拾う。
     */
    if (depth === 1 && !m && /^[\s]*[a-zA-Z_][a-zA-Z0-9_]*(\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*)*\s*,?\s*$/.test(code)) {
      for (const part of code.split(",")) {
        const nm = part.trim();
        if (nm && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(nm)) args.push(nm);
      }
    }
    for (const ch of code) {
      if (ch === "{" || ch === "(" || ch === "[") depth++;
      else if (ch === "}" || ch === ")" || ch === "]") depth--;
    }
    if (depth <= 0) break;
  }
  return args;
}

/** 材料の名前 → 渡す時の名前（違う物だけ・`snake_case` → `camelCase` が基本） */
export function camelOf(key: string): string {
  const special: Record<string, string> = {
    with_ops: "withOps",
    weak: "weakN",
    rows: "rows",
    next: "next",
    points: "points",
    opens: "opens",
    screens: "screens",
    sequence: "sequence",
    site: "site",
    site_counts: "siteCounts",
    mode_counts: "modeCounts",
    guessed_opens: "guessedOpens",
    shot_rows: "shotRows",
    human_ops: "humanOps",
    auto_ops: "autoOps",
    same_runs: "sameRuns",
    shot_bytes: "shotBytes",
    scene_flows: "scene_flows",
    scene_missing: "scene_missing",
    scene_missing_names: "scene_missing_names",
    stopped_scene: "stopped_scene",
    improvements: "improvements",
    audits: "audits",
    commands: "commands",
    toggles: "toggles",
    photo_kinds: "photoKinds",
    image_match: "imageMatch",
    bundle_reflect: "bundleReflect",
    gap_ms: "gapMs",
    prev: "prev",
  };
  if (special[key]) return special[key];
  return key.replace(/_([a-z])/g, (_x, c: string) => c.toUpperCase());
}

/**
 * 材料が統括に届いているか点検する（純関数）。
 *   ⚠ **届いていない物を名指しする**（「たぶん大丈夫」で流さない）。
 */
export function checkWiring(supervisorSrc: string): WiringReport {
  const keys = inputKeys(supervisorSrc);
  const args = buildMeetingArgs(supervisorSrc);
  if (!keys.length || !args.length) {
    return { total: keys.length, wired: [], missing: keys, ok: false, line: "点検できません（材料の型か buildMeeting が見つからない）" };
  }
  const argSet = new Set(args);
  // ⚠ `prev` は `superviseLearn` の中で `buildMeeting` に渡さない（前回比較は別の所で使う）
  const skip = new Set(["prev", "gap_ms"]);
  const wired: string[] = [];
  const missing: string[] = [];
  for (const k of keys) {
    if (skip.has(k)) continue;
    const want = camelOf(k);
    // ⚠ 材料の名前そのままでも、camel でも、どちらかで渡っていれば「届いている」
    if (argSet.has(want) || argSet.has(k)) wired.push(k);
    else missing.push(k);
  }
  const line = missing.length
    ? `⚠ 統括に届いていない材料 ${missing.length}件: ${missing.join(", ")}`
    : `材料 ${wired.length}件すべて統括に届いています`;
  return { total: keys.length, wired, missing, ok: true, line };
}
