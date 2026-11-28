// scripts/lib/switch-life.ts — 台帳 #816「スイッチの一生の台帳」（純関数・DB なし・LLM なし）
// 2026-11-27 作業員L（竹内さん 11/27「ブレインの管理を任せる土台」・統括役の頼み）:
//   既定 off の部品ごとに 目的・持ち主・状態・最後の試験と結果・届いたかの印・効く問題の数（辞書・eff・RAG）・台帳の番号・決めの設計知見 を1行に。
//   「試験が STALE_DAYS 日無い off」は「試す（届く組を積む）か退役か」の候補として並べる。戻し口・cron の物・凍結・退役・試験で測らない物は外す。
//   材料は呼ぶ側（scripts/switch-life.ts）が集める: コードの既定（rule-code-drift.scanCodeDefaults）・本番の env（brain_switch_versions の最新）・
//   段階の名簿（STAGED_SWITCHES）・台帳（work_items の switch_name）・印（SWITCH_TARGET_MARK・SWITCH_REACH）・試験の辞書・RAG の候補・前の回の meta（on のスイッチと日）
export type LifeState = "off" | "記録だけ" | "段階" | "on" | "凍結" | "退役" | "戻し口";
export type LifeLedger = { id: number; title: string; stage: string; owner: string | null; switch_default: string | null; exam_result: string | null; exam_labels: string[] | null; kb_ids: string[] | null; next_step?: string | null; blocker?: string | null; requested_at?: string | null };
export type LifeIn = {
  sw: string;
  code: "on" | "off" | "staged" | "absent" | null; where: readonly string[];
  prod: string | null; staged: string | null; revert: boolean; cron: boolean; notExam: string | null;
  ledger: LifeLedger | null; codeOwner: string | null; codePurpose: string | null;
  mark: string | null; dictN: number; effN: number; ragN: number;
  lastExam: { label: string; at: string } | null; reachedN: number | null;
  kbIds: readonly string[];
  /** コードの既定が見つからない時、名前がどこに出るか（app＝読み方が分からない・scripts＝試験の道具・none＝どこにも無い） */ seen?: "app" | "scripts" | "none";
  /** コードのコメントの一番古い日（作った日の目安・台帳の created_at は台帳を作った日で使えない） */ madeAt?: string | null;
};
export type LifeRow = LifeIn & { state: LifeState; owner: string | null; purpose: string; daysSinceExam: number | null; candidate: "試す" | "印が先" | "退役" | null; why: string };
export const STALE_DAYS = 14;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** 状態（純関数）: 台帳の退役・凍結 → 戻し口 → 本番で on（env か段階の all かコードの既定）→ 段階 → 記録だけ → off */
export function lifeStateOf(i: Pick<LifeIn, "code" | "prod" | "staged" | "revert" | "ledger">): LifeState {
  const st = i.ledger?.stage ?? ""; const txt = `${i.ledger?.title ?? ""} ${i.ledger?.next_step ?? ""} ${i.ledger?.blocker ?? ""}`;
  if (st === "dropped") return "退役";
  if (/凍結/.test(txt) && st !== "on" && st !== "done") return "凍結";
  if (i.revert) return "戻し口";
  const prod = (i.prod ?? "").trim().toLowerCase();
  if (prod === "on" || i.staged === "all" || i.code === "on") return "on";
  if (i.staged && i.staged !== "off") return "段階";
  if (prod === "shadow" || i.ledger?.switch_default === "shadow") return "記録だけ";
  return "off";
}
export function daysBetween(fromIso: string, nowIso: string): number { return Math.floor((Date.parse(nowIso) - Date.parse(fromIso)) / 86_400_000); }
/** 1行（純関数）。候補: off で試験が STALE_DAYS 日無い（一度も無いも含む）物。印があって効く問題が3問以上なら「試す」・それ以外は「退役」の候補（決めるのは持ち主と統括役） */
export function lifeRowOf(i: LifeIn, nowIso: string): LifeRow {
  const state = lifeStateOf(i);
  const owner = i.ledger?.owner?.trim() || i.codeOwner || null;
  const purpose = clip((i.ledger?.title ?? i.codePurpose ?? "").replace(/\s+/g, " ").trim(), 80);
  const daysSinceExam = i.lastExam ? daysBetween(i.lastExam.at, nowIso) : null;
  let candidate: LifeRow["candidate"] = null; let why = "";
  if (state !== "off") why = state;
  else if (i.cron) why = "cron の物";
  else if (i.notExam) why = `試験で測らない（${clip(i.notExam, 30)}）`;
  else if (daysSinceExam != null && daysSinceExam < STALE_DAYS) why = `${daysSinceExam}日前に試験`;
  else if (!i.where.length && i.seen === "app") why = "コードの読み方が分からない（名前だけ出る）";
  else if (!i.where.length && i.seen === "scripts") why = "試験の道具（scripts だけ）";
  else if (!i.where.length) { candidate = "退役"; why = "コードのどこにも無い（台帳だけに名前が残る）"; }
  else if (i.madeAt && daysBetween(i.madeAt, nowIso) < STALE_DAYS) why = `作って${daysBetween(i.madeAt, nowIso)}日`;
  else if (i.ledger?.requested_at && daysBetween(i.ledger.requested_at, nowIso) < STALE_DAYS) why = `頼まれて${daysBetween(i.ledger.requested_at, nowIso)}日`; // 台帳の created_at は台帳を作った日（11/13〜）＝部品の日ではない
  else {
    // 2026-11-27: 印の無い物は「届いたか」を試験で見分けられない＝試すには印が先（退役と混ぜると朝の数が 200 近くになり読めない）
    if (!i.mark) { candidate = "印が先"; why = "届いたかの印が無い（試すなら印を足す・要らなければ退役）"; }
    // on の回で走ったのに一度も届かなかった（前の回・昼の届きの確かめ）＝効く場面が試験に無いか部品が動かない
    else if (i.reachedN === 0 && i.ragN === 0 && daysSinceExam != null) { candidate = "退役"; why = `印 ${i.mark} が on の回で一度も出ない`; }
    else { candidate = "試す"; why = `印 ${i.mark}・効く問題 辞書${i.dictN}・eff${i.effN}・RAG${i.ragN}（無ければ RAG の候補を昼の届きの確かめに）`; }
    why += daysSinceExam == null ? "・試験が一度も無い" : `・試験から${daysSinceExam}日`;
  }
  return { ...i, state, owner, purpose, daysSinceExam, candidate, why };
}
/** 朝の1枚の1行（純関数） */
export function lifeMorningLine(rows: readonly LifeRow[]): string {
  const off = rows.filter((r) => r.state === "off");
  const tryN = rows.filter((r) => r.candidate === "試す").length, retN = rows.filter((r) => r.candidate === "退役").length, markN = rows.filter((r) => r.candidate === "印が先").length;
  const noOwner = off.filter((r) => !r.owner).length;
  return `スイッチの一生（#816）: 既定 off ${off.length}・試す候補 ${tryN}・退役の候補 ${retN}・持ち主の無い物 ${noOwner}・印が先 ${markN}`;
}
/** 台帳に積む題（純関数・題で重ねない） */
export function lifeLedgerTitle(r: LifeRow): string { return `【スイッチの一生】${r.sw}: 試験が${r.daysSinceExam == null ? "一度も無い" : `${r.daysSinceExam}日無い`} off → ${r.candidate === "試す" ? "試す（届く組を積む）" : r.candidate === "印が先" ? "印を足して試すか退役か決める" : "試すか退役か決める"}`; }
/** コードのコメントから持ち主（作業員X・Cursor 等）と目的を拾う（純関数）: スイッチの名前の行の前 8 行のコメント */
export function ownerPurposeFromCode(src: string, sw: string): { owner: string | null; purpose: string | null; madeAt?: string | null } {
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(sw)) continue;
    const xs: string[] = [];
    for (let j = Math.max(0, i - 8); j <= i; j++) { const m = lines[j].match(/\/\/\s?(.*)$/) ?? lines[j].match(/^\s*\/?\*{1,2}\s?(.*)$/); if (m) xs.push(m[1].trim()); } // 2026-11-27: JSDoc（ * ）の説明も読む
    const t = xs.join(" ");
    const o = t.match(/作業員\s?([A-Z][A-Z0-9]?|[0-9]+)/);
    const d = [...t.matchAll(/20\d\d-[01]\d-[0-3]\d/g)].map((x) => x[0]).sort()[0] ?? null;
    if (o) return { owner: `作業員${o[1]}`, purpose: clip(t.replace(/^.*?[:：]\s*/, ""), 80) || null, madeAt: d ? `${d}T00:00:00.000Z` : null };
  }
  // 名前の近くに無ければファイルの頭（先頭 6 行）の持ち主（部品のファイルを作った人）
  const head = lines.slice(0, 6).join(" "); const ho = head.match(/作業員s?([A-Z][A-Z0-9]?|[0-9]+)/);
  if (ho && src.includes(sw)) { const d = head.match(/20dd-[01]d-[0-3]d/)?.[0] ?? null; return { owner: `作業員${ho[1]}`, purpose: null, madeAt: d ? `${d}T00:00:00.000Z` : null }; }
  return { owner: null, purpose: null };
}
/** 表の1行の文（朝の1枚・--table） */
export function lifeLine(r: LifeRow): string {
  const ex = r.lastExam ? `${r.lastExam.at.slice(5, 10)} ${r.lastExam.label}${r.ledger?.exam_result ? `（${clip(r.ledger.exam_result.replace(/\s+/g, " "), 30)}）` : ""}` : "試験なし";
  return [r.sw, r.state, r.owner ?? "持ち主なし", ex, r.mark ? `印 ${r.mark}${r.reachedN != null ? `（届いた ${r.reachedN}）` : ""}` : "印なし", `効く 辞書${r.dictN}・eff${r.effN}・RAG${r.ragN}`, r.ledger ? `#${r.ledger.id}` : "台帳なし", r.kbIds.length ? `KB ${r.kbIds.slice(0, 2).join(",")}` : "KB なし", r.candidate ? `→ ${r.candidate}の候補（${r.why}）` : "", r.purpose].filter(Boolean).join(" ｜ ");
}
