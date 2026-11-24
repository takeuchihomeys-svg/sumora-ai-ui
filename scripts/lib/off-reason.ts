// scripts/lib/off-reason.ts — 台帳の built_off の行を「なぜ off のままか」で5つに分ける（純関数・DB/LLM なし）
//
// 2026-11-24 作業員A（竹内さん 11/24「まだ off の部分も、統括の土台をちゃんと細分化して、統括の使い方がちゃんとできるようになったら on にできるものも多いのではないか」・統括役の頼み）。
//   分け方（上から順に当てる＝先に当たった物）:
//     (e) 竹内さん待ち・他の行に置き換わった（台帳の文に印がある）
//     (c) 試験で悪化した・差が無い（試験の記録か台帳の文に印がある）
//     (a) 統括が材料を作っていない・渡していない（統括の土台の欠け）
//         ＝連携の地図（app/lib/linkage-map.ts）で、このスイッチが ①〜③（お客様の通・ブレインの読み・統括）の材料を「作る側」の行／コードのどこからも読まれていないスイッチ
//     (b) 材料は届いているが、統括がその部品を使う判断をしていない（使い方の欠け）
//         ＝連携の地図で、このスイッチが「読む側の親」（readerSwitches）の行か、統括より後（組・RAG・書き手・最終チェック）で材料を使う部品の行
//     (d) 試験の問題が無い・まだ測っていない（上のどれにも当たらない残り・試験の道なし・#648 で材料0）
//   届き（conductor_reach）: (a)＝届いていない・(b)(c)＝届いている・(d)(e)＝未確認
//   (a)(b) は「統括の欠けた部品」（連携の地図の行）ごとにまとめ、1つの土台を直すと on の候補（試験に進められる行）が何行増えるかの順に並べる。
//   設計図（conductor.compose_plan）を読む行は、作る側が新しい判断の番（brainLocalFresh）にしか作られない守りでまとめて止まっている（KB 89672025・7日 128 中 9）＝別の土台として数える
import type { LinkageRow } from "../../app/lib/linkage-map";
import type { DutyRow } from "./conductor-duty";

export type OffReason = "a" | "b" | "c" | "d" | "e";
export const OFF_REASON_JA: Record<OffReason, string> = {
  a: "統括が材料を作っていない・渡していない（土台の欠け）",
  b: "材料は届いているが統括が使う判断をしていない（使い方の欠け）",
  c: "試験で悪化・差が無い（中身の問題）",
  d: "試験の問題が無い・まだ測っていない",
  e: "竹内さん待ち・他の行に置き換わった",
};
export type Reach = "届いていない" | "届いている" | "未確認";
export const REACH_OF: Record<OffReason, Reach> = { a: "届いていない", b: "届いている", c: "届いている", d: "未確認", e: "未確認" };

export type OffItem = {
  id: number; title: string; owner: string | null; switch_name: string | null;
  next_step?: string | null; blocker?: string | null; exam_result?: string | null; exam_labels?: string[] | null;
  owner_question_id?: unknown; owner_question_uuid?: unknown;
};
export type OffVerdict = { id: number; reason: OffReason; why: string; switches: string[]; parts: string[]; reach: Reach; title?: string };

const E_RE = /竹内さん(?:の)?(?:確認|待ち|決め待ち|の了承待ち|の返事)|確認事項|owner_questions|置き換|取り下げ|dropped|代わりに|が受け持つ|退役|不要になった|使わない事にした/;
// 「悪化0」「確かな悪化0」「悪化0なら既定 on」は悪化ではない（台帳の決まり文句）
const C_RE = /悪化(?![0０]|なし|無し|が無|は無|は0)|差が無い|差なし|差は無|変わらない|揺れの内|割れ|保留|落ちた|悪くな/;
const READ_STAGES = new Set(["in", "read", "conductor"]);
/** 統括より後で材料を使う段（ここで off＝材料はあるのに使っていない） */
const USE_STAGES = new Set(["combo", "rag", "writer", "check"]);

/** 題・次の一手からスイッチの名前（大文字と _ の並び・_ を1つ以上）を拾う */
export function switchNamesOf(it: Pick<OffItem, "switch_name" | "title" | "next_step">): string[] {
  const out = new Set<string>();
  if (it.switch_name) out.add(it.switch_name.trim());
  for (const m of `${it.title ?? ""} ${it.next_step ?? ""}`.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) out.add(m[0]);
  return [...out];
}

export type OffCtx = {
  map: readonly LinkageRow[];
  /** コードのどこかで env として読まれているスイッチ（静的な読み）。undefined＝確かめない */
  readInCode?: ReadonlySet<string>;
};

export function classifyOff(it: OffItem, ctx: OffCtx): OffVerdict {
  const text = [it.title, it.next_step, it.blocker, it.exam_result].filter(Boolean).join(" ");
  const sws = switchNamesOf(it);
  const own = it.switch_name ? [it.switch_name] : sws;
  const v = (reason: OffReason, why: string, parts: string[] = []): OffVerdict => ({ id: it.id, reason, why, switches: own, parts, reach: REACH_OF[reason], title: it.title });
  if (it.owner_question_id != null || it.owner_question_uuid != null) return v("e", "竹内さんの確認事項につながっている");
  const em = text.match(E_RE);
  if (em) return v("e", `台帳の文に「${em[0]}」`);
  const tested = (it.exam_labels?.length ?? 0) > 0 || /試験/.test(text);
  const cm = text.match(C_RE);
  if (cm && tested) return v("c", `試験の記録・台帳の文に「${cm[0]}」`);
  // 連携の地図で見る
  const produce = ctx.map.filter((r) => own.some((s) => r.switches.includes(s)));
  const readerOf = ctx.map.filter((r) => own.some((s) => r.readerSwitches.includes(s)));
  const pa = produce.filter((r) => READ_STAGES.has(r.stage));
  if (pa.length) return v("a", `統括の材料を作る側（${pa.map((r) => r.id).join("・")}）が off`, pa.map((r) => r.id));
  const pb = [...readerOf, ...produce.filter((r) => USE_STAGES.has(r.stage))];
  if (pb.length) return v("b", `材料を使う側（${[...new Set(pb.map((r) => r.id))].join("・")}）が off`, [...new Set(pb.map((r) => r.id))]);
  if (it.switch_name && ctx.readInCode && own.every((s) => !ctx.readInCode!.has(s))) return v("a", "コードのどこからも読まれていない（配線が無い）", ["配線なし"]);
  if (/試験の道(?:が)?(?:無|な)い|問題(?:が)?(?:無|な)い|材料0|材料が0/.test(text)) return v("d", "試験の道・問題が無い");
  return v("d", tested ? "試験の記録はあるが結果の印が無い" : "まだ測っていない");
}

export type PartGroup = { part: string; name: string; rows: number[]; reasons: Record<"a" | "b", number>; duty: string[]; composePlan: boolean };
/** (a)(b) を統括の欠けた部品（連携の地図の行）ごとにまとめる。設計図（conductor.compose_plan）を読む行の部品は composePlan の印 */
export function groupByPart(vs: readonly OffVerdict[], map: readonly LinkageRow[], duty: readonly DutyRow[]): PartGroup[] {
  const by = new Map<string, PartGroup>();
  const byId = new Map(map.map((r) => [r.id, r]));
  for (const v of vs) {
    if (v.reason !== "a" && v.reason !== "b") continue;
    for (const p of v.parts.length ? v.parts : ["不明"]) {
      const row = byId.get(p);
      const g = by.get(p) ?? { part: p, name: row?.name ?? p, rows: [], reasons: { a: 0, b: 0 }, duty: duty.filter((d) => [...d.have, ...d.use, ...d.reflect].includes(p)).map((d) => d.name), composePlan: !!row && (row.id === "conductor.compose_plan" || row.readers.includes("conductor.compose_plan")) };
      if (!g.rows.includes(v.id)) { g.rows.push(v.id); g.reasons[v.reason]++; }
      by.set(p, g);
    }
  }
  return [...by.values()].sort((x, y) => y.rows.length - x.rows.length || x.part.localeCompare(y.part));
}

/** 設計図の土台（compose_plan を読む部品）をまとめた行の数（重なりなし） */
export function composePlanRows(groups: readonly PartGroup[]): number[] {
  return [...new Set(groups.filter((g) => g.composePlan).flatMap((g) => g.rows))].sort((a, b) => a - b);
}

// ── 継ぎ目（2026-11-24 統括役の足し・竹内さん「連携の部分ちゃんと細分化細かく」）────────────────
//   (a)(b) の行を「その部品を on にした時に、連携の鎖のどの継ぎ目で最初に切れるか」で分ける。言葉は統括の受け持ちの表（conductor-duty の have/use/reflect）にそろえる:
//     ①材料を作る・②統括に渡す＝持つ（have）／③統括が読む・④統括が使う判断をする＝使う（use）／⑤書き手・AIX・ピッカーに渡す・⑥最終チェックで消されない・⑦送った物の記録に残る＝反映（reflect）／⑧物差しで測れる
//   証拠はコードの静的な読み（連携の地図の行の位置・読む側の親のスイッチの既定）と、測った数（設計図 9/128）だけ。取れない行は「未確認」（推して埋めない）
export type Joint = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const JOINT_JA: Record<Joint, string> = { 1: "①材料を作る", 2: "②統括に渡す", 3: "③統括が読む", 4: "④統括が使う判断をする", 5: "⑤書き手・AIX・ピッカーに渡す", 6: "⑥最終チェックで消されない", 7: "⑦送った物の記録に残る", 8: "⑧物差しで測れる" };
export const JOINT_DUTY: Record<Joint, "have" | "use" | "reflect" | "measure"> = { 1: "have", 2: "have", 3: "use", 4: "use", 5: "reflect", 6: "reflect", 7: "reflect", 8: "measure" };
export type JointVerdict = { id: number; joint: Joint | null; block: string; evidence: string };
export type JointCtx = OffCtx & {
  /** スイッチ → コードの既定（"on"/"off"・不明は無し） */
  defaults: ReadonlyMap<string, "on" | "off">;
  /** 連携の地図の行 id → linkage-map.ts の行番号 */
  mapLine: ReadonlyMap<string, number>;
  /** 設計図（compose_plan）が作られた番の数（例 { made: 9, n: 128 }・無ければ数は書かない） */
  composePlanMade?: { made: number; n: number } | null;
};
const STAGE_JOINT: Record<string, Joint> = { combo: 5, rag: 5, writer: 5, bridge: 5, staff: 5, check: 6, sent: 7, next: 8 };
const readerJoint = (readers: readonly string[]): Joint | null =>
  readers.some((r) => r.startsWith("conductor.")) ? 3 : readers.some((r) => /^(writer|rag|combo)\.|ピッカー|AIX/.test(r)) ? 5 : readers.some((r) => r.startsWith("check.")) ? 6 : null;

export function jointOf(v: OffVerdict, ctx: JointCtx): JointVerdict {
  const out = (joint: Joint | null, block: string, evidence: string): JointVerdict => ({ id: v.id, joint, block, evidence });
  if (v.reason !== "a" && v.reason !== "b") return out(null, "-", "(a)(b) ではない");
  if (v.parts.includes("配線なし")) return out(1, "配線なし", `env の読みがコードに0か所（${v.switches.join("・")}）`);
  const at = (id: string) => `app/lib/linkage-map.ts:${ctx.mapLine.get(id) ?? "?"}`;
  const byId = new Map(ctx.map.map((r) => [r.id, r]));
  for (const p of v.parts) {
    const r = byId.get(p); if (!r) continue;
    const mine = v.switches.some((s) => r.switches.includes(s));
    // 2026-11-24 作業員A（#675）: 地図の外の行を、スイッチを読む所（ファイル:行）から足した行（id が auto.）。読む側が分からないので、場所で分かる所まで
    if (p.startsWith("auto.")) {
      const file = r.producer;
      if (/compose-/.test(file)) {
        const c = ctx.composePlanMade;
        return out(1, "設計図（conductor.compose_plan）", `${r.key} は設計図の中の部品。設計図は判断を新しく作った番（brainLocalFresh）にしか作られない${c ? `（${c.made}/${c.n}）` : ""}・KB 89672025`);
      }
      if (r.stage === "conductor") return out(4, `統括の部品（${file.split("/").pop()}）`, `${r.key}（統括の判断の部品そのものが既定 off）`);
      if (STAGE_JOINT[r.stage]) return out(STAGE_JOINT[r.stage], `${r.stage} の部品（${file.split("/").pop()}）`, `${r.key}（統括より後の段で off）`);
      return out(null, "未確認", `${r.key}: ブレインの材料の部品だが、統括が読むかは地図に無い（読む側が分からない）`);
    }
    if (mine && (r.stage === "in" || r.stage === "read")) {
      // 作る側を on にした時、統括が読むか
      if (r.readers.includes("conductor.compose_plan")) {
        const c = ctx.composePlanMade;
        return out(3, "設計図（conductor.compose_plan）", `${at(p)} の読む側は設計図。設計図は判断を新しく作った番（brainLocalFresh）にしか作られない${c ? `（${c.made}/${c.n}）` : ""}・KB 89672025`);
      }
      const offReader = r.readerSwitches.find((s) => ctx.defaults.get(s) === "off");
      if (offReader) return out(3, `読む側の親 ${offReader}`, `${at(p)} の readerSwitches の ${offReader} がコードの既定 off`);
      if (!r.readers.length) return out(2, "読む側が無い", `${at(p)} に readers が無い（統括に渡す先が無い）`);
      // 読む側に統括の行（conductor.*）が無い＝統括は読まない（ブレイン・物差しだけ）
      const cond = r.readers.filter((x) => x.startsWith("conductor."));
      if (!cond.length) return out(3, `統括の読む所なし（読む側 ${r.readers.join("・")}）`, `${at(p)} の readers に統括の行が無い`);
      // 統括の読む行の作る側が既定 off なら、そこで止まる
      for (const c of cond) {
        const cr = byId.get(c);
        const offSw = cr?.switches.find((s) => ctx.defaults.get(s) === "off");
        if (cr && offSw) return out(3, `統括の ${c}（${offSw} が既定 off）`, `${at(p)} の読む側 ${c}（${at(c)}）の作る側 ${offSw} がコードの既定 off`);
      }
      return out(null, "未確認", `${at(p)}: 統括の読む側（${cond.join("・")}）は既定で動く・④以降の確かめが無い`);
    }
    if (mine && r.stage === "conductor") return /既定 shadow/.test(v.why + (v.title ?? "")) ? out(4, "記録だけ（shadow）の統括の部品・on の判断待ち", `${at(p)}（題に「既定 shadow」）`) : out(4, `統括の部品 ${r.id}`, `${at(p)}（統括の判断の部品そのものが既定 off）`);
    if (mine && STAGE_JOINT[r.stage]) return out(STAGE_JOINT[r.stage], `${r.stage} の部品 ${r.id}`, `${at(p)}（統括より後の段で off）`);
    if (!mine) { // 読む側の親のスイッチ
      const j = readerJoint(r.readers);
      if (j) return out(j, `読む側の親（${r.id} を読む ${r.readers.join("・")}）`, `${at(p)} の readerSwitches に ${v.switches.filter((s) => r.readerSwitches.includes(s)).join("・")}`);
    }
  }
  return out(null, "未確認", "連携の地図の行から継ぎ目を決められない");
}

/** 継ぎ目×止めている物ごとの行の数（1つ直すと on の候補が何行増えるかの順） */
export function blockRanking(js: readonly JointVerdict[]): Array<{ joint: Joint | null; block: string; rows: number[] }> {
  const m = new Map<string, { joint: Joint | null; block: string; rows: number[] }>();
  for (const j of js) {
    if (j.block === "-") continue;
    // 2026-11-24: 1つの直しは止めている物（block）で数える（同じ設計図で ① と ③ に分かれる行もまとめる）
    const k = j.block;
    const g = m.get(k) ?? { joint: j.joint, block: j.block, rows: [] };
    g.rows.push(j.id); m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.rows.length - a.rows.length);
}

/** コードの文から、スイッチの既定（=== "on" で入る＝off・!== "off" で止める＝on）を読む */
export function defaultsFromCode(code: string, names: readonly string[]): Map<string, "on" | "off"> {
  const out = new Map<string, "on" | "off">();
  for (const n of names) {
    const re = new RegExp(`env\\.${n}\\b[^\\n]{0,80}?(===|!==)\\s*"(on|off)"`, "g");
    const hits = [...code.matchAll(re)].map((m) => (m[1] === "===" && m[2] === "on" ? "off" : m[1] === "!==" && m[2] === "off" ? "on" : null)).filter((x): x is "on" | "off" => !!x);
    if (hits.length && hits.every((h) => h === hits[0])) out.set(n, hits[0]);
  }
  return out;
}

// ── #675（2026-11-24 作業員A）: 地図の外の行を載せる（動きは変えない・連携の見張りの LINKAGE_MAP には入れない＝scripts/lib/linkage-offparts.json に別に持つ）──
const PLACE_STAGE: Partial<Record<Joint, LinkageRow["stage"]>> = { 1: "read", 4: "conductor", 5: "writer", 6: "check", 7: "sent", 8: "next" };
/** スイッチを読む所から、地図の行（id は auto.<スイッチ>・読む側は分からないので空） */
export function offpartRowOf(sw: string, file: string, line: number, place: Joint | null): LinkageRow | null {
  const stage = place ? PLACE_STAGE[place] : undefined;
  if (!stage) return null;
  return { id: `auto.${sw}`, stage, name: `${sw}（地図の外の off の部品・${file.split("/").pop()}）`, producer: file, key: `${file}:${line}`, readers: [], switches: [sw], readerSwitches: [], fill: { src: "meta", path: "-" } as LinkageRow["fill"], owner: "-", layer: "連携", next: "読む側を確かめて地図に正式な行を足す（#675）" };
}
/** スイッチ名の無い台帳の行に入れる名前（題・次の一手の大文字の名前のうち、コードで読まれている物がちょうど1つの時だけ） */
export function switchForUnnamed(it: Pick<OffItem, "switch_name" | "title" | "next_step">, readInCode: ReadonlySet<string>): string | null {
  if (it.switch_name) return null;
  const c = switchNamesOf(it).filter((s) => readInCode.has(s));
  return c.length === 1 ? c[0] : null;
}
export const NO_SWITCH_MARK = "スイッチ無し（コードの直し）";

/** スイッチを読む所（ファイル）→ 鎖の場所（継ぎ目の言葉）。地図に行が無いスイッチの「どこにある部品か」の証拠（ファイル:行）に使う */
export function chainPlaceOf(path: string): Joint | null {
  const p = path.replace(/\\/g, "/");
  if (/final-check|delivery-check|reply-final|post-check/.test(p)) return 6;
  if (/sent-facts|action-ledger|sent-record/.test(p)) return 7;
  if (/\/cron\/|watch|audit|yardstick|exam/.test(p)) return 8;
  if (/aix-template-generate|second-|writer|generate-reply\/route|aix\/action|picker|two-message|viewing-greeting/.test(p)) return 5;
  if (/conductor-|compose-/.test(p)) return 4;
  if (/brain-|situation|customer-state|turn-read|latent|exchange-ledger|promise-/.test(p)) return 1;
  return null;
}
