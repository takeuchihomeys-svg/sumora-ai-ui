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

/** #675 の続き（2026-11-28 作業員A・統括役の決め／L の整え）: 2つ以上のスイッチを持つ行は switch_name に1つだけ入れ、残りは next_step に書く。
 *  その next_step の大文字の名前のうち、コードで読まれていて他の行の switch_name でない物も、その行の物として読む（地図の外に見えないように）。
 *  題は見ない（#674 の題のように他の行のスイッチを並べる事があるため）。switch_name の無い行は従来どおり switchNamesOf */
export function extraSwitchesOf(it: Pick<OffItem, "switch_name" | "next_step">, readInCode: ReadonlySet<string>, ownedByRows: ReadonlySet<string>): string[] {
  if (!it.switch_name) return [];
  const own = it.switch_name.trim();
  const out = new Set<string>();
  for (const m of String(it.next_step ?? "").matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)) {
    const s = m[0];
    if (s !== own && readInCode.has(s) && !ownedByRows.has(s)) out.add(s);
  }
  return [...out];
}

export type OffCtx = {
  map: readonly LinkageRow[];
  /** コードのどこかで env として読まれているスイッチ（静的な読み）。undefined＝確かめない */
  readInCode?: ReadonlySet<string>;
  /** #675 の続き: 行ごとの next_step の残りのスイッチ（extraSwitchesOf）。undefined＝switch_name だけ */
  extra?: ReadonlyMap<number, readonly string[]>;
};

export function classifyOff(it: OffItem, ctx: OffCtx): OffVerdict {
  const text = [it.title, it.next_step, it.blocker, it.exam_result].filter(Boolean).join(" ");
  const sws = switchNamesOf(it);
  const own = it.switch_name ? [it.switch_name, ...(ctx.extra?.get(it.id) ?? [])] : sws;
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
      // #675 の続き（11/24 夕）: 読む所から読む側を足した行（autoReadersOf・why は r.next）
      const why = r.next.startsWith("読む側: ") ? r.next.slice(5) : "";
      if (why) {
        if (r.readers.some((x) => x.startsWith("conductor."))) return out(4, "統括は読む（既定で動く）・判断に使うかは試験で", `${r.key}: ${why}`);
        if (r.readers.includes("read.brain")) return out(3, "統括の読む所なし（読む側 read.brain）", `${r.key}: ${why}（統括は判断の結果を通してだけ読む）`);
        if (/欄 meta\./.test(why)) return out(3, "統括の読む所なし（ブレインの欄を統括が読まない）", `${r.key}: ${why}`);
        const dj = r.readers.find((x) => x.startsWith("direct."));
        if (dj) return out(3, `統括の読む所なし（統括を通らず ${JOINT_JA[Number(dj.slice(7)) as Joint]} が直に読む）`, `${r.key}: ${why}`);
        return out(2, "読む側が無い", `${r.key}: ${why}`);
      }
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
      // #675 の続き（11/24 夕）: 統括の読む側が既定で動く＝③までは届く。止まりは④（判断に使うか）として数える（使うかは試験で）
      return out(4, "統括は読む（既定で動く）・判断に使うかは試験で", `${at(p)}: 統括の読む側（${cond.join("・")}）は既定で動く・④の確かめは試験で`);
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

// ── #675 の続き（2026-11-24 夕 作業員A・統括役の頼み）: 地図の外のブレインの材料の行に「統括が読むか」を足す（読むだけ・動きは変えない）──
export type CodeFile = { path: string; text: string };
export type AutoReaders = { readers: string[]; why: string };
const isConductorFile = (p: string) => /\/conductor-[\w-]+\.ts$/.test(p);
const condId = (p: string) => `conductor.${p.split("/").pop()!.replace(/^conductor-|\.ts$/g, "")}`;
/**
 * スイッチを読む所（file:line）から読む側を決める（証拠つき・決められない時は readers 空）。
 *  1) 読む行か上の2行が meta の欄（`key:`）→ 統括の部品（conductor-*.ts）がその欄の名を読むか
 *  2) 入口の関数（上の5行の export function／const）を呼ぶ所 → conductor-*.ts が呼ぶ＝統括が直に読む・brain-core が呼ぶ＝ブレインの入力
 *  3) brain-core.ts の中の決まり（欄でない）→ ブレインの入力（read.brain）
 */
export function autoReadersOf(file: string, line: number, files: readonly CodeFile[]): AutoReaders {
  const fl = files.find((x) => x.path === file);
  if (!fl) return { readers: [], why: "ファイルが読めない" };
  const ls = fl.text.split(/\r?\n/);
  const conds = files.filter((x) => isConductorFile(x.path));
  for (let j = line - 1; j >= Math.max(0, line - 3); j--) {
    const m = ls[j]?.match(/^\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)+):\s/);
    if (!m) continue;
    const key = m[1], re = new RegExp(`\\b${key}\\b`);
    const hits = conds.map((c) => ({ c, k: c.text.split(/\r?\n/).findIndex((l) => re.test(l)) })).filter((h) => h.k >= 0);
    if (hits.length) return { readers: hits.map((h) => condId(h.c.path)), why: `欄 meta.${key}（${file}:${j + 1}）を統括が読む: ${hits.map((h) => `${h.c.path}:${h.k + 1}`).join("・")}` };
    return { readers: [], why: `欄 meta.${key}（${file}:${j + 1}）を読む統括の部品が無い（conductor-*.ts に名が0か所）` };
  }
  if (/brain-core\.ts$/.test(file)) return { readers: ["read.brain"], why: `brain-core の中の決まり（${file}:${line}・欄でない）＝ブレインの入力` };
  return gateReaders(file, line, files, 5);
}
const GATE_RE = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^export\s+const\s+(\w+)/;
const EXPORT_RE = /export\s+(?:async\s+)?(?:function|const)\s+(\w+)/;
/** 読む行を囲む入口の関数（上へ 120 行までの一番近い export）→ 呼ぶ所。外から呼ばれなければ同じファイルの中で呼ぶ所の入口へ（depth 段まで） */
function gateReaders(file: string, line: number, files: readonly CodeFile[], depth: number, seen = new Set<string>()): AutoReaders {
  const fl = files.find((x) => x.path === file);
  if (!fl) return { readers: [], why: "ファイルが読めない" };
  const ls = fl.text.split(/\r?\n/);
  let gate: string | null = null;
  for (let j = line - 1; j >= Math.max(0, line - 120) && !gate; j--) { const m = ls[j]?.match(GATE_RE); if (m) gate = m[1] ?? m[2]; }
  if (!gate) return { readers: [], why: `入口の関数が見つからない（${file}:${line}）` };
  if (seen.has(`${file}#${gate}`)) return { readers: [], why: `入口 ${gate} がめぐる` };
  seen.add(`${file}#${gate}`);
  const gre = new RegExp(`\\b${gate}\\(`);
  const callers = files
    .filter((f) => f.path !== file && !/__tests__|(^|\/)scripts\//.test(f.path))
    .map((f) => ({ f, k: f.text.split(/\r?\n/).findIndex((l) => gre.test(l) && !EXPORT_RE.test(l)) }))
    .filter((h) => h.k >= 0);
  const c = callers.filter((h) => isConductorFile(h.f.path));
  if (c.length) return { readers: c.map((h) => condId(h.f.path)), why: `入口 ${gate} を統括の部品が呼ぶ: ${c.map((h) => `${h.f.path}:${h.k + 1}`).join("・")}` };
  const b = callers.find((h) => /brain-core\.ts$/.test(h.f.path));
  if (b) return { readers: ["read.brain"], why: `入口 ${gate} を brain-core が呼ぶ（${b.f.path}:${b.k + 1}）＝ブレインの入力` };
  if (callers.length) {
    // 外の呼ぶ所が統括でもブレインでもない: その呼ぶ所の場所（書き手・物差し等）を読む側にする（統括を通らない）
    const pl = callers.map((h) => ({ h, j: chainPlaceOf(h.f.path) })).find((x) => x.j);
    if (pl) return { readers: [`direct.${pl.j}`], why: `入口 ${gate} を ${pl.h.f.path}:${pl.h.k + 1} が直に呼ぶ（${JOINT_JA[pl.j!]}・統括を通らない）` };
    if (depth > 1) for (const h of callers.slice(0, 4)) { const r = gateReaders(h.f.path, h.k + 1, files, depth - 1, seen); if (r.readers.length) return { readers: r.readers, why: `入口 ${gate} → ${h.f.path}:${h.k + 1} → ${r.why}` }; }
    return { readers: [], why: `入口 ${gate} を呼ぶのは ${callers.slice(0, 3).map((h) => `${h.f.path}:${h.k + 1}`).join("・")}（統括の部品でもブレインでもない）` };
  }
  // 同じファイルの中で呼ぶ所 → その入口へ
  const own = new RegExp(`(?:function|const)\s+${gate}\b`);
  const inner = ls.findIndex((l, k) => k !== line - 1 && gre.test(l) && !own.test(l));
  if (inner >= 0 && depth > 1) { const r = gateReaders(file, inner + 1, files, depth - 1, seen); return { readers: r.readers, why: `入口 ${gate} は同じファイルの ${file}:${inner + 1} から → ${r.why}` }; }
  return { readers: [], why: `入口 ${gate} を呼ぶ所が無い` };
}

/** スイッチの無い行（コードの直し・物差しの穴）の鎖の場所を題の言葉で分ける（証拠＝当たった言葉・決められない物は null） */
const TITLE_PLACE: Array<[Joint, RegExp]> = [
  [8, /物差し|本番の数字|quality_daily|分母|監査|試験で確かめられない|数え方/],
  [7, /記録に残らない|行動台帳|送った物の記録/],
  [4, /統括|重点/],
  [5, /返信で|下書き|AIX の文|2通目|次の返信|文と締め|ピックアップに/],
  [1, /画像|写真|築年|時系列|約束|材料|把握|読み/],
];
export function titlePlaceOf(title: string): { place: Joint | null; word: string } {
  for (const [j, re] of TITLE_PLACE) { const m = title.match(re); if (m) return { place: j, word: m[0] }; }
  return { place: null, word: "" };
}
/** 読み込む所（import）の場所の多数（同数は鎖の前の方）。importers は読み込むファイルの場所の並び */
export function majorityPlace(places: ReadonlyArray<Joint | null>): Joint | null {
  const c = new Map<Joint, number>(); for (const p of places) if (p) c.set(p, (c.get(p) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
}
