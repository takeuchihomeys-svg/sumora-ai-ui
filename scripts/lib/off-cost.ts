// scripts/lib/off-cost.ts — off のままの部品を on にした時の費用の種類（純関数・DB/LLM なし）
//
// 2026-11-24 作業員A（竹内さん 11/24「全部 on にしたら費用が上がるか」・統括役の頼み・台帳 #675 の1列）。
//   種類: zero（純関数・記録だけ）／input（プロンプトに材料を足す・前＝指示文の固定部分ならキャッシュが切れる・後ろ＝毎回変わる所）／
//         call（LLM を1回以上足す）／unknown（証拠が取れない）。time＝本番のブレイン・返信の中で待つ呼び出しか
//   証拠はスイッチの入口の関数を呼ぶ所（ファイル:行）とその後の数行の静的な読みだけ（推して埋めない）
export type CostKind = "zero" | "input" | "call" | "unknown";
export const COST_JA: Record<CostKind, string> = { zero: "0（純関数・記録だけ）", input: "入力増", call: "呼び出し増", unknown: "未確認" };
export type CostSite = { file: string; line: number; text: string };
export type CostVerdict = { kind: CostKind; pos?: "前" | "後ろ" | "未確認"; waits?: boolean; module?: string; evidence: string };

/** LLM を呼ぶ印（その後の数行に await と一緒にある時） */
const CALL_RE = /await[^\n]{0,120}\b(?:run[A-Z]\w*|call(?:Llm|Claude|Deepseek|Brain)\w*|analyzeConversation|generateText|chatComplet\w*|messages\.create|llm[A-Z]\w*)\s*\(/;
const SERVER_IMPORT_RE = /import\(\s*["']@\/app\/lib\/([\w-]+-server)["']\s*\)/;
/** プロンプトに足す印 */
const INPUT_BACK_RE = /customerStateBlockText\s*\+=|(?:lines|notes|parts|blocks)\.push\(|\+=\s*`\\n|Note\s*\+=|Block\s*\+=|Section\b/;
const INPUT_FRONT_RE = /\$\{\s*[A-Z][A-Z0-9_]*_ON\s*\?|_RULES\b|_FIELD\b|SYSTEM|systemPrompt|PREFIX/;
/** 本番で待つ所（ブレイン・返信・AIX の文） */
const WAIT_FILE_RE = /brain-core\.ts|generate-reply\/route\.ts|aix-template-generate\/route\.ts|aix\/action\/route\.ts/;

/** スイッチの入口の関数を呼ぶ所ごとの窓（呼ぶ行から下 n 行）から、費用の種類を決める（呼ぶ所が多ければ重い方） */
export function costOfSites(sites: readonly CostSite[], windowOf: (s: CostSite) => string, isLlmModule: (mod: string) => boolean = () => true): CostVerdict {
  if (!sites.length) return { kind: "unknown", evidence: "スイッチの入口を呼ぶ所が見つからない" };
  let best: CostVerdict | null = null;
  const rank = (k: CostKind) => ({ call: 3, input: 2, zero: 1, unknown: 0 })[k];
  for (const s of sites) {
    const w = windowOf(s);
    const at = `${s.file}:${s.line}`;
    let v: CostVerdict;
    if (CALL_RE.test(w) || (SERVER_IMPORT_RE.test(w) && /await/.test(w))) {
      const mod = w.match(SERVER_IMPORT_RE)?.[1];
      // 2026-11-24: 呼ぶ先の -server が LLM を呼ばない（DB の読みだけ）なら、材料を足す入力増＋本番で待つ DB の読み
      if (mod && !CALL_RE.test(w) && !isLlmModule(mod)) v = { kind: "input", pos: "後ろ", waits: WAIT_FILE_RE.test(s.file), module: mod, evidence: `${at}（${mod} は LLM を呼ばない＝DB の読みで材料を足す${WAIT_FILE_RE.test(s.file) ? "・本番で待つ" : ""}）` };
      else v = { kind: "call", waits: WAIT_FILE_RE.test(s.file), module: mod, evidence: `${at}（LLM の呼び出し${mod ? `・${mod}` : ""}）` };
    } else if (INPUT_FRONT_RE.test(s.text)) v = { kind: "input", pos: "前", evidence: `${at}（指示文の固定部分に入る＝キャッシュの前）` };
    else if (INPUT_BACK_RE.test(w)) v = { kind: "input", pos: "後ろ", evidence: `${at}（毎回変わる材料に足す）` };
    else v = { kind: "zero", evidence: `${at}（LLM・プロンプトへの足しが窓に無い）` };
    if (!best || rank(v.kind) > rank(best.kind)) best = v;
  }
  return best!;
}

/**
 * 入力増の字数の上限の見込み（静的）: 呼ぶ所の窓で使う関数（〜Line／Note／Block／Text／Section／RULES）の定義の中の文字列の字数の和。
 * 実際に足されるのは条件が合う番だけ・文字列の一部だけのこともある＝上限。定数（RULES 等）はそのままの字数
 */
export function inputCharsUpper(windowText: string, defOf: (name: string) => string | null): { chars: number; names: string[] } {
  const names = [...new Set([...windowText.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:Line|Note|Block|Text|Section|RULES|FIELD|Lines|Notes))\b/g)].map((m) => m[1]))].slice(0, 6);
  let chars = 0; const used: string[] = [];
  for (const n of names) {
    const d = defOf(n); if (!d) continue;
    const lits = [...d.matchAll(/`([^`]*)`|"([^"\n]*)"/g)].map((m) => (m[1] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, ""));
    const c = lits.reduce((s, x) => s + Array.from(x).length, 0);
    if (c > 0) { chars += c; used.push(`${n}≈${c}字`); }
  }
  return { chars, names: used };
}

/** モデルの1回あたりの $（llm_usage_logs の平均トークン × app/lib/llm-price.ts の単価・ピークは見ない） */
export function usdPerCall(u: { inu: number; cr: number; cw: number; out: number }, price: { in: number; read: number; out: number }): number {
  return (u.inu * price.in + u.cr * price.read + u.cw * price.in * 1.25 + u.out * price.out) / 1e6;
}
