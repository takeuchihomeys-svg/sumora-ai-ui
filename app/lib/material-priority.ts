// app/lib/material-priority.ts — 読み手（本番のブレイン）の材料に優先順位を付ける（純関数・DB/LLM なし・台帳 #747・MATERIAL_PRIORITY・既定 off）
// 2026-11-26 作業員L（竹内さん 11/25 夜「ちゃんと読み手に優先順位つけたらより質あがるのでは？」「統括ブレインなぜできるようになっていないのか・連携が弱いのかな？」
//   「ここの統括のところ優先度かなり上げる・統括をちゃんとできなければいけない」・統括役の割り振り・作業員A と形を合意）
//   今は材料の行が場面に関係なく足した順に並ぶ。統括の入口（conductor_intake）が読んだ重点（focus_read.focus）と、AIX の番と見たか・地図の駅があるかから
//   「まず見る3つ」を選び、その行だけを材料の先頭の【まず見る】の塊に移す（統括→ブレインの連携）。残りは今の順のまま。行の中身は1文字も変えない。
//   入口が間に合わない番（返す前の待ちの内に答えが無い）と off の時は今の並び。道を引っぱらない置き方（q406・q065 の教訓）: 塊の見出しは「先に目を通す」だけで、
//   「この順で決めよ」とは書かない（ブレインに決め直しはさせない）。
//   単位は material_marks のキー（1行ごと・作業員A と合意）。行は brain-core が足す時に { key, text, from } で登録する（登録の無い行は動かない）。
//   切替: MATERIAL_PRIORITY=off（既定）／shadow（選ぶだけ・並べ替えない・記録 meta.material_priority）／on（並べ替える・入口を最大 4秒待つ）
// テスト: app/lib/__tests__/material-priority.test.ts

type Env = Record<string, string | undefined>;
export type MaterialPriorityMode = "off" | "shadow" | "on";
export function materialPriorityMode(env: Env = typeof process !== "undefined" ? process.env : {}): MaterialPriorityMode {
  const v = (env.MATERIAL_PRIORITY ?? "").trim().toLowerCase();
  return v === "on" ? "on" : v === "shadow" ? "shadow" : "off";
}
/** 選び方の版（表を変えたら上げる・記録に残る） */
export const MATERIAL_PRIORITY_VERSION = "mp-v1";

export type MaterialBlock = { key: string; text: string; from: "cs" | "route" };

/**
 * 重点（入口の focus_read.focus）ごとに、先に見る行のキー（左ほど先）。v1 は作業員A の案（11/25 夜）と check-order の竹内さんの確認の順の型から:
 *   約束を作る・果たす番は確認の約束の流れ／果たせる物を先、答える番は今答えられる材料を先、締め・提案は地図の駅と逆算の計画を先
 */
export const FOCUS_FIRST_KEYS: Readonly<Record<string, readonly string[]>> = {
  answer: ["now_fulfillable", "info_fill", "check_promise_flow"],
  promise_make: ["check_promise_flow", "pickup_why", "now_fulfillable"],
  promise_keep: ["check_promise_flow", "now_fulfillable", "pickup_why"],
  ease: ["ack_confirm", "topic_state"],
  close: ["station_state", "route_backplan", "now_fulfillable"],
  propose: ["pickup_why", "station_state", "route_backplan"],
  relation: ["ack_confirm", "topic_state"],
};
/** 入口が AIX の番と見た時に先に足す行（確認の約束の流れ＝作業員A の #744 の分かれ目） */
const AIX_FIRST_KEYS = ["check_promise_flow"] as const;
/** 地図の駅がある番に足す行 */
const STATION_KEYS = ["station_state", "route_backplan"] as const;

/** 「まず見る3つ」を選ぶ（入口の答えが無ければ空＝今の並び） */
export function pickFirstKeys(o: { focus: string | null | undefined; saysAix: boolean; hasStation: boolean; available: readonly string[]; max?: number }): { keys: string[]; why: string } {
  const max = o.max ?? 3;
  if (!o.focus) return { keys: [], why: "入口の答えが無い" };
  const avail = new Set(o.available);
  const order = [...(o.saysAix ? AIX_FIRST_KEYS : []), ...(FOCUS_FIRST_KEYS[o.focus] ?? []), ...(o.hasStation ? STATION_KEYS : [])];
  const keys: string[] = [];
  for (const k of order) if (avail.has(k) && !keys.includes(k)) { keys.push(k); if (keys.length >= max) break; }
  return { keys, why: `重点 ${o.focus}${o.saysAix ? "・AIX の番" : ""}${o.hasStation ? "・駅あり" : ""}` };
}

/** 選んだ行を材料の先頭の【まず見る】の塊へ移す（行の中身は変えない・見つからない行は動かさない） */
export function applyMaterialPriority(o: { cs: string; route: string; blocks: readonly MaterialBlock[]; keys: readonly string[]; why: string }): { cs: string; route: string; moved: string[] } {
  let cs = o.cs, route = o.route;
  const lead: string[] = [];
  const moved: string[] = [];
  for (const k of o.keys) {
    const b = o.blocks.find((x) => x.key === k && x.text.trim());
    if (!b) continue;
    const src = b.from === "route" ? route : cs;
    const i = src.indexOf(b.text);
    if (i < 0) continue;
    const next = (src.slice(0, i) + src.slice(i + b.text.length)).replace(/\n{3,}/g, "\n\n");
    if (b.from === "route") route = next; else cs = next;
    lead.push(b.text.trim());
    moved.push(k);
  }
  if (!lead.length) return { cs: o.cs, route: o.route, moved: [] };
  const head = `【まず見る（統括の入口の読み: ${o.why}）】\n${lead.join("\n")}`;
  return { cs: `${head}\n\n${cs.replace(/^\n+/, "")}`, route, moved };
}

/** 記録の1行（digest.mpr）: 版|mode|入口の答えが間に合ったか|選んだキー|動かしたキー */
export function materialPriorityDigest(r: { mode: MaterialPriorityMode; ready: boolean; keys: readonly string[]; moved: readonly string[] } | null | undefined): string | null {
  if (!r || r.mode === "off") return null;
  return `${MATERIAL_PRIORITY_VERSION}|${r.mode[0]}|${r.ready ? "r" : "-"}|${r.keys.join(",")}|${r.moved.join(",")}`;
}

/**
 * 物差し②「選んだ行をブレインの判断が使ったか」の目印（キー → 判断の digest から決める・作業員A と朝に埋める表・v1 は決まった物だけ）。
 *   true＝使った・false＝使わなかった・null＝この番では決められない
 */
export const USED_MARKERS: Readonly<Record<string, (d: Record<string, unknown>) => boolean | null>> = {
  // 確認の約束の流れ（お礼だけの返事を待つ番）: ブレインの AIX が確認の結果になったか（作業員A の案）
  check_promise_flow: (d) => (typeof d.aix === "string" || d.aix == null ? String(d.aix ?? "") === "property_check_result" : null),
  // 今果たせる物: ブレインが AIX を選んだか（果たす一手）
  now_fulfillable: (d) => !!String(d.aix ?? "").trim(),
};

/** 物差し①②を記録の行から数える（毎朝の1枚） */
export function materialPriorityMeasures(digests: ReadonlyArray<Record<string, unknown>>): { picked: number; ready: number; headShare: number | null; used: number; usedOf: number } {
  let picked = 0, ready = 0, keysN = 0, movedN = 0, used = 0, usedOf = 0;
  for (const d of digests) {
    const m = String(d.mpr ?? "").split("|");
    if (m.length < 5) continue;
    picked++;
    if (m[2] === "r") ready++;
    const keys = m[3] ? m[3].split(",") : [], moved = m[4] ? m[4].split(",") : [];
    keysN += keys.length; movedN += moved.length;
    for (const k of keys) { const f = USED_MARKERS[k]; const u = f ? f(d) : null; if (u != null) { usedOf++; if (u) used++; } }
  }
  return { picked, ready, headShare: keysN ? Math.round((movedN / keysN) * 1000) / 10 : null, used, usedOf };
}
