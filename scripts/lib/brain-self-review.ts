// scripts/lib/brain-self-review.ts — LINE のブレインが「なぜ外れたか」を自分で説明し、直しの案を出す（決め方だけ・純関数・LLM も DB も呼ばない）
//
// 2026-10-18 竹内さん 10/16 OK「ブレイン同士で会話させて自己改善する輪」の一歩目:
//   毎日拾うブレイン（edited-turn-miner）→ 試験のブレイン（exam-brain）→ ★LINE のブレインが外れを説明する → ★直しの案を出す → 試験のブレインが確かめる。
//   直しの案は自動で入れない（貯めて竹内さんに見せる）。読み書きは scripts/lib/brain-self-review-io.ts、入口は scripts/brain-self-review.ts。
//
// ここで決める事:
//   ① 説明の語（どこで外れたか・直しの種類）を固定する（LLM には決まった語で返させ、外れた語は捨てる）
//   ② 説明に渡す「1つにまとめた材料」（問題と正解・ブレインの判断・決まりの後・下書き・材料の抜粋・設計知見）を行番号つきで作る
//      材料（録音の要求）は 7〜13万字ある → 問題の言葉・正解の言葉で行を選んで抜く（元の順番のまま・見出しは残す）
//   ③ LLM の答えを読み、根拠（L番号＋その行からの引用）が本当にその行にあるかを確かめる（無い根拠は「根拠なし」に落とす）
//   ④ 直しの案を束ねる（同じ原因＝直しの種類・外れの場所が同じで原因の名前が近い物）。数の多い順。竹内さんの決定が要る物は別に分ける
//   ⑤ 竹内さんに見せる Markdown と、朝の報告に入れる1行
export const WHERE = [
  "材料に無かった",
  "材料にあったのに読めなかった",
  "判断は合っていて下書きで崩れた",
  "決まり・出口が上書きした",
  "人しか知らない事（AIX の番）",
  "採点・問題の側",
  "分けられない",
] as const;
export type Where = typeof WHERE[number];
export const FIX = ["知識を足す", "材料をつなぐ", "決まりを変える", "出口を直す", "お手本を足す", "竹内さんに聞く"] as const;
export type FixKind = typeof FIX[number];

// ─── ② 材料の抜粋 ─────────────────────────────────────────────────────
/** 1行が長すぎる時は切る（行番号で指せるように） */
export function splitLines(text: string, maxLen = 240): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const l = raw.replace(/\s+$/g, "");
    if (!l.trim()) continue;
    const cs = [...l];
    for (let i = 0; i < cs.length; i += maxLen) out.push(cs.slice(i, i + maxLen).join(""));
  }
  return out;
}
const STOP = new Set(["こちら", "お客様", "させて", "頂き", "頂きます", "致します", "ください", "お願い", "よろしく", "ます", "です", "こと", "もの", "場合", "返信", "物件", "お部屋", "部屋", "確認", "スタッフ", "ブレイン", "今回", "会話", "AIX", "aix", "null", "true", "false"]);
/** 言葉（漢字・カタカナ・英数の2字以上の並び。ひらがなだけの語は外す） */
export function keywordsOf(texts: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of String(t ?? "").matchAll(/[一-龯々〆ヵヶ]{2,}|[ァ-ヴー]{2,}|[A-Za-z][A-Za-z0-9_]{2,}|[0-9]{2,}[万円㎡帖]/g)) {
    const w = m[0];
    if (!STOP.has(w) && w.length <= 12) out.add(w);
  }
  return [...out];
}
/** 指示らしい行（下書きの材料で、締め・書くな・必ず の行は問題の言葉が無くても拾う） */
export const INSTRUCTION_MARK = /締め|書かない|足さない|入れない|禁止|必ず含め|必ず書|⛔|🔚|書くな|しない（|だけにする|上書き|最優先/;
export const MATERIAL_HEAD = /^\s*【[^】]{0,40}材料[^】]{0,10}】/;
export type ExcerptPart ={ name: string; text: string; budget: number; weight?: number; instructions?: boolean };
export type Excerpt = { name: string; lines: string[]; total: number; kept: number };
/**
 * 材料（長い）から、言葉が当たる行（とその前後1行）・見出しの行を、元の順で予算まで抜く。
 *   点 = 当たった言葉の珍しさ（その材料の中で少ない語ほど重い）の和 × weight。instructions の時は指示らしい行に 0.6 足す。
 *   抜いた所の間は「…（N行省略）」1行にする（行番号は振り直す＝LLM には抜いた後の行番号で指させる）
 */
export function excerptOf(part: ExcerptPart, keywords: ReadonlyArray<string>): Excerpt {
  const lines = splitLines(part.text);
  const total = lines.length;
  if (!total) return { name: part.name, lines: [], total: 0, kept: 0 };
  const sum = lines.reduce((s, l) => s + [...l].length, 0);
  if (sum <= part.budget) return { name: part.name, lines, total, kept: total };
  const df = new Map<string, number>();
  for (const k of keywords) { let n = 0; for (const l of lines) if (l.includes(k)) n++; if (n) df.set(k, n); }
  const w = part.weight ?? 1;
  const score = lines.map((l) => {
    let s = 0;
    for (const [k, n] of df) if (l.includes(k)) s += 1 / Math.log2(1 + n);
    if (part.instructions && INSTRUCTION_MARK.test(l)) s += 0.6;
    // この番の材料の塊（【…（材料）】で始まる行）は、言葉が1つでも当たれば先に入れる（材料の見出しと決まりの見出しの食い違いを見せるため）
    if (s > 0 && MATERIAL_HEAD.test(l)) s += 1.5;
    return s * w;
  });
  const heading = (l: string) => /^\s*【[^】]{1,40}】/.test(l) || /^\s*■/.test(l);
  const keep = new Set<number>();
  let used = 0;
  const add = (i: number) => { if (i < 0 || i >= total || keep.has(i)) return; keep.add(i); used += [...lines[i]].length; };
  // 見出しは短く（40字まで）全部入れる（どこに何があるかを LLM が言えるように）。ただし予算の 15% まで
  for (let i = 0; i < total && used < part.budget * 0.15; i++) if (heading(lines[i])) { lines[i] = [...lines[i]].slice(0, 40).join(""); add(i); }
  const order = score.map((s, i) => [s, i] as const).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (used >= part.budget) break;
    add(i); if (used < part.budget) add(i - 1); if (used < part.budget) add(i + 1);
  }
  const idx = [...keep].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -1;
  for (const i of idx) { if (i > prev + 1) out.push(`…（${i - prev - 1}行省略）`); out.push(lines[i]); prev = i; }
  if (prev < total - 1) out.push(`…（${total - 1 - prev}行省略）`);
  return { name: part.name, lines: out, total, kept: idx.length };
}

/**
 * 物件名に付いた素の部屋番号（「ライオンズ渋谷401」「レジデンス 303（」「大正405の」）も伏せる（maskRoomNo は「号室」付きだけ）。
 *   2026-10-18 確かめる人: ブレインの action・送付済み物件の行に号室なしの部屋番号が残り、DeepSeek と report に出ていた。
 *   誤りを減らすため: 直前が漢字・カタカナ（または英字2字）・3〜4桁・直後が終わりか区切りの記号の時だけ（「1500 トークン」「365日」「131回」は触らない）
 */
export function maskBareRoomNo(s: string): string {
  return String(s ?? "").replace(/(?<=[一-龯々ァ-ヴー]|[A-Za-z]{2})(\s?)[0-9０-９]{3,4}(?=$|[のをがにはでとやもへ（()）・、。'"」』:：\]】/／]|[,，](?![0-9０-９]))/gm, "$1◯");
}

// ─── 1つにまとめた材料（行番号つき） ─────────────────────────────────────
export type PacketSection = { name: string; lines: string[] };
export type Packet = { text: string; lines: Array<{ n: number; section: string; text: string }>; chars: number };
export function buildPacket(sections: ReadonlyArray<PacketSection>): Packet {
  const lines: Packet["lines"] = [];
  const out: string[] = [];
  let n = 0;
  for (const s of sections) {
    if (!s.lines.length) continue;
    out.push(`■ ${s.name}`);
    for (const l of s.lines) { n++; lines.push({ n, section: s.name, text: l }); out.push(`L${n}: ${l}`); }
  }
  const text = out.join("\n");
  return { text, lines, chars: [...text].length };
}

// ─── ③ LLM の答えを読む・根拠を確かめる ──────────────────────────────────
export type Evidence = { line: number; quote: string; absent?: boolean; section?: string; ok?: boolean };
export type Finding = { where: Where; why: string; evidence: Evidence[]; brainOk: boolean | null; causeKey: string; confidence: "高" | "中" | "低"; grounded: boolean };
export type Proposal = { kind: FixKind; plan: string; target: string; needsTakeuchi: boolean; question: string | null };
export type Explanation = { findings: Finding[]; fix: Proposal | null; raw?: unknown; invalid: string[] };
const norm = (s: string) => String(s ?? "").normalize("NFKC").replace(/[\s　「」『』"'`、。,.!！?？…・]/g, "").replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).toLowerCase();
function bigrams(s: string): Set<string> { const c = [...norm(s)]; const o = new Set<string>(); for (let i = 0; i + 1 < c.length; i++) o.add(c[i] + c[i + 1]); return o; }
/** 引用がその行にあるか（そのまま含む・または2字の組の 7割以上が行にある） */
export function quoteInLine(quote: string, line: string): boolean {
  const q = norm(quote), l = norm(line);
  // 1字の引用（「は」「の」）はどの行にもあるので根拠にしない
  if ([...q].length < 2) return false;
  if (l.includes(q)) return true;
  const qb = bigrams(quote), lb = bigrams(line);
  if (qb.size < 3) return false;
  let hit = 0; for (const b of qb) if (lb.has(b)) hit++;
  return hit / qb.size >= 0.7;
}
export function checkEvidence(ev: Evidence, packet: Packet): Evidence {
  const l = packet.lines.find((x) => x.n === ev.line) ?? packet.lines.find((x) => x.n === ev.line - 1 || x.n === ev.line + 1);
  if (!l) return { ...ev, ok: false };
  // 前後1行のずれは許す（LLM の行番号の1ずれ）が、引用がその行に無ければ落とす
  const exact = packet.lines.find((x) => x.n === ev.line);
  const hitLine = exact && quoteInLine(ev.quote, exact.text) ? exact : [l, ...packet.lines.filter((x) => Math.abs(x.n - ev.line) === 1)].find((x) => quoteInLine(ev.quote, x.text));
  return hitLine ? { ...ev, line: hitLine.n, section: hitLine.section, ok: true } : { ...ev, section: exact?.section ?? l.section, ok: false };
}
const pick = <T extends string>(v: unknown, vocab: readonly T[]): T | null => { const s = String(v ?? "").trim(); return (vocab as readonly string[]).includes(s) ? s as T : (vocab.find((x) => s && (x.startsWith(s) || s.startsWith(x))) ?? null); };
const strip = (s: unknown, n: number) => [...String(s ?? "").replace(/\s+/g, " ").trim()].slice(0, n).join("");
/** LLM の JSON → 説明（決まった語でない物は捨てる・根拠を確かめる） */
export function parseExplanation(raw: unknown, packet: Packet): Explanation {
  const invalid: string[] = [];
  const j = (typeof raw === "string" ? (() => { try { return JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()); } catch { return null; } })() : raw) as Record<string, unknown> | null;
  if (!j || typeof j !== "object") return { findings: [], fix: null, raw, invalid: ["JSON でない"] };
  const fs = Array.isArray(j.findings) ? j.findings as Array<Record<string, unknown>> : [];
  const findings: Finding[] = [];
  for (const f of fs.slice(0, 3)) {
    const where = pick(f.where, WHERE);
    if (!where) { invalid.push(`where「${strip(f.where, 20)}」は決まった語でない`); continue; }
    const evs = (Array.isArray(f.evidence) ? f.evidence as Array<Record<string, unknown>> : []).slice(0, 5).map((e) => checkEvidence({ line: Number(String(e.line ?? "").replace(/^L/i, "")) || 0, quote: strip(e.quote, 60), absent: e.absent === true }, packet));
    const grounded = evs.some((e) => e.ok);
    if (!grounded) invalid.push(`${where}: 根拠の行が確かめられない`);
    const conf = pick(f.confidence, ["高", "中", "低"] as const) ?? "低";
    findings.push({ where, why: strip(f.why, 260), evidence: evs, brainOk: typeof f.brain_ok === "boolean" ? f.brain_ok : null, causeKey: strip(f.cause_key, 24) || where, confidence: grounded ? conf : "低", grounded });
  }
  const fx = (j.fix ?? null) as Record<string, unknown> | null;
  let fix: Proposal | null = null;
  if (fx) {
    const kind = pick(fx.kind, FIX);
    if (!kind) invalid.push(`fix.kind「${strip(fx.kind, 20)}」は決まった語でない`);
    else {
      const q = strip(fx.question, 160);
      const needs = kind === "竹内さんに聞く" || fx.needs_takeuchi === true;
      fix = { kind, plan: strip(fx.plan, 300), target: strip(fx.target, 80), needsTakeuchi: needs, question: needs ? (q || strip(fx.plan, 160)) : null };
    }
  }
  return { findings, fix, raw: j, invalid };
}

// ─── ④ 直しの案を束ねる ──────────────────────────────────────────────
export type CaseResult = { caseId: string; source: "exam" | "miner"; ids: string[]; title: string; kb: Array<{ id: string; title: string }>; exp: Explanation };
export type Bundle = { kind: FixKind; where: Where; causeKeys: string[]; plans: string[]; targets: string[]; ids: string[]; cases: string[]; kb: Array<{ id: string; title: string; n: number }>; needsTakeuchi: boolean; questions: string[]; n: number };
/** 原因の名前の芯（「〜の見落とし」「〜の矛盾」等の型の語は束ねの近さに数えない＝別の原因が語尾だけで束ならないように） */
export function causeCore(s: string): string {
  return String(s ?? "").replace(/(の)?(見落とし|読み落とし|読めない|読み違い|未使用|不使用|不足|欠落|抜け|矛盾|誤り|ずれ|取り違え|上書き)$/g, "").trim() || String(s ?? "");
}
export function similarKey(a: string, b: string): number {
  const A = bigrams(causeCore(a)), B = bigrams(causeCore(b));
  if (!A.size || !B.size) return norm(causeCore(a)) === norm(causeCore(b)) ? 1 : 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}
/**
 * 同じ原因の案を束ねる: 直しの種類・外れの場所（主の説明）が同じで、原因の名前の芯が近い（2字の組の Jaccard ≥ 0.4）か直す所が近い（≥ 0.5）か、同じ設計知見の上位に結ぶ物。
 *   竹内さんの決定が要る物（竹内さんに聞く・needs_takeuchi）は別の束にする。数の多い順（同じ数なら竹内さんの番＝試験の問題が多い順）
 */
export function bundleProposals(results: ReadonlyArray<CaseResult>): Bundle[] {
  const bs: Bundle[] = [];
  for (const r of results) {
    const fx = r.exp.fix; const main = r.exp.findings.find((f) => f.grounded) ?? r.exp.findings[0];
    if (!fx || !main) continue;
    const kb0 = r.kb[0]?.id ?? null;
    const hit = bs.find((b) => b.kind === fx.kind && b.where === main.where && b.needsTakeuchi === fx.needsTakeuchi
      && (b.causeKeys.some((k) => similarKey(k, main.causeKey) >= 0.4) || b.targets.some((t) => fx.target && similarKey(t, fx.target) >= 0.5) || (kb0 && b.kb[0]?.id === kb0 && similarKey(b.causeKeys[0], main.causeKey) >= 0.2)));
    const b = hit ?? (() => { const nb: Bundle = { kind: fx.kind, where: main.where, causeKeys: [], plans: [], targets: [], ids: [], cases: [], kb: [], needsTakeuchi: fx.needsTakeuchi, questions: [], n: 0 }; bs.push(nb); return nb; })();
    b.n++;
    if (!b.causeKeys.includes(main.causeKey)) b.causeKeys.push(main.causeKey);
    if (fx.plan && !b.plans.includes(fx.plan)) b.plans.push(fx.plan);
    if (fx.target && !b.targets.includes(fx.target)) b.targets.push(fx.target);
    for (const id of r.ids) if (!b.ids.includes(id)) b.ids.push(id);
    b.cases.push(r.caseId);
    if (fx.question && !b.questions.includes(fx.question)) b.questions.push(fx.question);
    for (const k of r.kb.slice(0, 3)) { const e = b.kb.find((x) => x.id === k.id); if (e) e.n++; else b.kb.push({ ...k, n: 1 }); }
  }
  for (const b of bs) b.kb.sort((x, y) => y.n - x.n);
  return bs.sort((a, b) => b.n - a.n || b.ids.length - a.ids.length);
}

// ─── ⑤ 見せ方 ────────────────────────────────────────────────────────
export function renderMarkdown(o: { day: string; results: ReadonlyArray<CaseResult>; bundles: ReadonlyArray<Bundle>; usd: number; skipped: ReadonlyArray<string> }): string {
  const L: string[] = [];
  const ask = o.bundles.filter((b) => b.needsTakeuchi), fix = o.bundles.filter((b) => !b.needsTakeuchi);
  L.push(`# ブレインの自己点検（${o.day}）`, "");
  L.push(`説明 ${o.results.length}件・直しの案 ${fix.length}束・竹内さんに聞く ${ask.length}束・費用 約$${o.usd.toFixed(3)}。直しは自動で入れていない（案だけ）。`, "");
  const whereCount = new Map<string, number>();
  for (const r of o.results) { const m = r.exp.findings.find((f) => f.grounded) ?? r.exp.findings[0]; if (m) whereCount.set(m.where, (whereCount.get(m.where) ?? 0) + 1); }
  L.push(`外れの場所: ${[...whereCount].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("・") || "-"}`, "");
  if (ask.length) {
    L.push("## 竹内さんに聞く事", "");
    for (const b of ask) L.push(`- **${b.causeKeys.join("／")}**（${b.n}件・${b.ids.join(",")}）: ${b.questions.join(" ／ ") || b.plans[0] || ""}`);
    L.push("");
  }
  L.push("## 直しの案（数の多い順）", "");
  for (const b of fix) {
    L.push(`### ${b.kind}｜${b.causeKeys.join("／")}（${b.n}件）`);
    L.push(`- 外れの場所: ${b.where}`);
    L.push(`- 効く問題: ${b.ids.join(", ")}`);
    if (b.targets.length) L.push(`- 直す所: ${b.targets.join(" ／ ")}`);
    for (const p of b.plans.slice(0, 3)) L.push(`- 案: ${p}`);
    if (b.kb.length) L.push(`- 関係する設計知見: ${b.kb.slice(0, 3).map((k) => `${k.id.slice(0, 8)}「${[...k.title].slice(0, 40).join("")}」`).join("・")}`);
    L.push("");
  }
  L.push("## 1件ずつの説明", "");
  for (const r of o.results) {
    L.push(`### ${r.title}`);
    for (const f of r.exp.findings) {
      L.push(`- ${f.grounded ? "" : "（根拠なし）"}**${f.where}**（${f.confidence}・${f.causeKey}）: ${f.why}`);
      for (const e of f.evidence.filter((x) => x.ok).slice(0, 3)) L.push(`  - L${e.line}［${e.section}］${e.absent ? "（無い事の確かめ）" : ""}「${e.quote}」`);
    }
    if (r.exp.fix) L.push(`- 直し: ${r.exp.fix.kind}｜${r.exp.fix.target}｜${r.exp.fix.plan}${r.exp.fix.question ? `｜聞く: ${r.exp.fix.question}` : ""}`);
    if (r.exp.invalid.length) L.push(`- 捨てた物: ${r.exp.invalid.join("・")}`);
    L.push("");
  }
  if (o.skipped.length) L.push("## 出さなかった物", "", ...o.skipped.map((s) => `- ${s}`), "");
  return L.join("\n");
}
/** 朝の報告に入れる1行 */
export function morningLine(day: string, results: ReadonlyArray<CaseResult>, bundles: ReadonlyArray<Bundle>): string {
  const top = bundles.filter((b) => !b.needsTakeuchi)[0];
  const ask = bundles.filter((b) => b.needsTakeuchi).length;
  return `🧠 自己点検 ${day}: 説明 ${results.length}件／一番多い原因「${top ? `${top.causeKeys[0]}→${top.kind}（${top.n}件・${top.ids.slice(0, 4).join(",")}）` : "-"}」／竹内さんに聞く ${ask}件`;
}

// ─── 費用 ────────────────────────────────────────────────────────────
/** DeepSeek の $（price: in＝一致しない入力・read＝一致した入力・out＝出力 の 100万あたり）。peak は 2倍 */
export function usdOf(u: { miss: number; hit: number; out: number }, price: { in: number; read: number; out: number }, peak: boolean): number {
  return ((u.miss * price.in + u.hit * price.read + u.out * price.out) / 1e6) * (peak ? 2 : 1);
}
/** 見込み（日本語 1字 ≈ 0.75 トークン・出力 1500 トークン） */
export function estimateUsdOf(chars: number, price: { in: number; read: number; out: number }, peak: boolean): number {
  return usdOf({ miss: Math.ceil(chars * 0.75), hit: 0, out: 1500 }, price, peak);
}

// ─── 説明の LLM への固定の前置き（変えると前置きキャッシュが外れる） ───────────────
export const EXPLAIN_SYSTEM = [
  "あなたは賃貸仲介の LINE 返信 AI の「外れの原因を調べる係」です。この AI は ブレイン（判断する LLM。turn_contract・背景・道＝返信／後でやる約束（2段）／AIX を決める）→ 決まり・出口のコード（rule:… で道や中身を変える）→ 下書きの LLM → 最終チェック の順で返信を作ります。",
  "渡す物: 問題と正解（竹内さんの実送信・伏せた物）／ブレインの最初の出力／決まり・出口の後のブレインと trace／下書きと判定／材料の抜粋（ブレインと下書きに渡した要求の、問題に関係する行。…は省いた行）／関係する設計知見。全部の行に L番号があります。",
  "やる事: 正解とのずれが「どこで」「なぜ」起きたかを説明し、同じ型のミスが二度と出ない直しを1つ出す。1問だけを当てに行く例外の規則・言葉の足しは避ける（原因を直す）。",
  "where（どこで外れたか）は次の語から選ぶ:",
  "  材料に無かった … 正解に要る事実・手がかりが、材料（ブレインと下書きに渡した物）のどこにも無い",
  "  材料にあったのに読めなかった … 材料に要る事がある（行で示せる）のに、ブレインの最初の出力がそれを使っていない・取り違えた（見出しの名前が決まりと違う・離れた所にある 等）",
  "  判断は合っていて下書きで崩れた … ブレインの判断（turn_contract・道・背景）は正解に沿っているのに、下書きの文が外れた（下書きの材料の別の指示＝締め・書くな 等に負けた）",
  "  決まり・出口が上書きした … 決まり（trace の decision_source の rule:…）や出口のコードが、ブレインの最初の出力の道・中身を変えて外れた",
  "  人しか知らない事（AIX の番） … 正解はスタッフしか知らない事（管理会社の回答・空き・検索の結果・見積の金額・内覧の日）を送る物で、材料から作れない",
  "  採点・問題の側 … 答えは正解の意図に合っているのに判定・符号が外れとした／問題の正解が揺れている",
  "  分けられない … 材料の写しが無い等で決められない",
  "根拠（必須）: 各 finding に evidence を1〜4個。line は L番号の数字、quote はその行からそのまま写した40字以内。材料に無い事を言う時は、探して無かった所（見出しの行など）を示し absent: true を付ける。根拠の無い説明は捨てられる。",
  "fix.kind（直しの種類）は次の語から選ぶ: 知識を足す（設計知見・ナレッジ）／材料をつなぐ（ある情報をブレイン・下書きに届ける・見出しをそろえる）／決まりを変える（rule・指示の矛盾を1つにそろえる）／出口を直す（出口のコード・判定）／お手本を足す／竹内さんに聞く。",
  "会社の事実（金額・できる事）・言い方の決まり・営業の方針など、竹内さんの決定が要る物は kind を「竹内さんに聞く」にするか needs_takeuchi: true にし、question に聞く事を書く。",
  "cause_key は原因の短い名前（20字以内・例「締めの指示の矛盾」「見出しの名前違い」「材料が揃うと確認に寄る」）。名前・電話・住所は書かない。",
  '出力は JSON だけ: {"findings":[{"where":"<語>","why":"<200字以内>","brain_ok":<ブレインの判断は正解に沿っていたか true/false>,"cause_key":"<20字>","confidence":"高|中|低","evidence":[{"line":<数字>,"quote":"<40字>","absent":false}]}],"fix":{"kind":"<語>","target":"<直す所＝部品・見出し・決まりの名前 60字>","plan":"<具体案 200字>","needs_takeuchi":false,"question":null}}',
  "findings は主な原因を先頭に最大3つ（同じ番に別の原因が重なる時だけ2つ目以降）。",
  "brain_ok の決め方: ブレインの判断（道・turn_contract の asks/answer・ack_form・must_not・reply_direction）に、正解の要点（依頼の要点・なぜ）が入っているか。入っていなければ false（下書きは指示どおりでも、それは「下書きで崩れた」ではない）。",
  "「材料にあったのに読めなかった」を言う時は、その事がある材料の行と、ブレインがそれを使わなかった所（判断の行）の両方を根拠にする。材料の見出しの名前と、決まり（指示）の中で呼ぶ見出しの名前が違っていないかも見る。",
  "直しは本番で使える物だけ: 本番では正解（竹内さんの実送信）は分からない。「正解が〜の時は〜する」という案は出さない。材料・決まり・出口・知識・お手本のどれをどう変えるかで書く。",
].join("\n");
