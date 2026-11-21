// 2026-11-21 作業員H（統括役の頼み・昨夜 COMPOSE_ 抜きの名前で3本積んで効いていなかった）: 試験の依頼の env の名前の突き合わせ。
//   積む時に必ず通す。スイッチの名前（試験の道具の EXAM_・LLM_ 等を除く）が、その作業ツリーの app/ のコードで読まれていなければ積まない。
//   近い名前（同じ尾・頭を足した・引いた）を出して、正しい名前で積み直せるようにする。止める: --allow-unread-env（理由を書く時だけ）
import { NON_SWITCH_ENV } from "./exam-bisect";

export type EnvNameCheck = { unread: Array<{ name: string; near: string[] }>; ok: string[] };

/** 近い名前: 尾が同じ（COMPOSE_X と X）・どちらかを含む・1〜2字違い。多くて3つ */
export function nearNames(name: string, known: Iterable<string>): string[] {
  const out: Array<[string, number]> = [];
  for (const k of known) {
    if (k === name) continue;
    let score = 0;
    if (k.endsWith(`_${name}`) || name.endsWith(`_${k}`)) score = 3;
    else if (k.includes(name) || name.includes(k)) score = 2;
    else if (Math.abs(k.length - name.length) <= 2 && editDistance(k, name) <= 2) score = 1;
    if (score) out.push([k, score]);
  }
  return out.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([k]) => k);
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** 依頼の env の名前を、コードが読む名前（appReaders の鍵）と突き合わせる。試験の道具の名前は見ない */
export function checkEnvNames(env: Record<string, string>, readNames: ReadonlySet<string> | ReadonlyMap<string, unknown>): EnvNameCheck {
  const known = [...readNames.keys()];
  const has = (n: string) => readNames.has(n);
  const unread: EnvNameCheck["unread"] = [], ok: string[] = [];
  for (const name of Object.keys(env)) {
    if (NON_SWITCH_ENV.test(name)) continue;
    if (has(name)) ok.push(name);
    else unread.push({ name, near: nearNames(name, known) });
  }
  return { unread, ok };
}

/**
 * 2026-11-21 作業員H（K2 の突き合わせの表 11/21・統括役）: 前提のスイッチ。左が on でも右が無いと何も変わらない（コードの線を読んで K2 が確かめた物）。
 *   足す時は、読む行（ファイル:行）を why に書く
 */
export const SWITCH_PREREQ: Record<string, { needs: Record<string, string>; why: string }> = {
  COMPOSE_LEAD_JUDGE_FIRST: { needs: { BRAIN_SEVEN_FIELDS: "on" }, why: "compose-sentence-plan.ts:485 は leadTo=seven_read の時だけ（seven_read は brainSevenOn の時だけ）" },
  COMPOSE_DROP_DUPLICATES: { needs: { BRAIN_COMPOSE_BLUEPRINT: "on" }, why: "compose-blueprint.ts:339 composeBlueprintOn(env) && …" },
  COMPOSE_REWRITE: { needs: { BRAIN_COMPOSE_BLUEPRINT: "on" }, why: "compose-blueprint-server.ts:94 は両方 on の時だけ" },
  TWO_MESSAGE_SEND_TEMPLATE: { needs: { TWO_MESSAGE_AFTER_AIX_T_DRAFT: "on" }, why: "ブレインの試験の AIX の後の下書きは T_DRAFT が無いと何も変わらない（作業員M 11/21）" },
};

/** 前提が欠けている物（env にも本番の既定（dotenv）にも右の値が無い） */
export function missingPrereqs(env: Record<string, string>, dotenv: Record<string, string> = {}): Array<{ name: string; need: string; why: string }> {
  const out: Array<{ name: string; need: string; why: string }> = [];
  for (const [name, v] of Object.entries(env)) {
    const p = SWITCH_PREREQ[name];
    if (!p || String(v).trim().toLowerCase() === "off") continue;
    for (const [k, want] of Object.entries(p.needs)) {
      const have = (env[k] ?? dotenv[k] ?? "").trim().toLowerCase();
      if (have !== want) out.push({ name, need: `${k}=${want}`, why: p.why });
    }
  }
  return out;
}

type BoolReaderLike = { kind: string; lit?: string; dflt?: string; lower?: boolean };
/** 既定（本番の .env.local・無ければコードの既定）と同じ値＝積んでも差が出ない名前（bool の読み方が分かる物だけ） */
export function sameAsDefault(env: Record<string, string>, readers: ReadonlyMap<string, BoolReaderLike>, dotenv: Record<string, string> = {}): string[] {
  const on = (v: string | undefined, r: BoolReaderLike) => { let x = (v ?? r.dflt ?? "").trim(); if (r.lower) x = x.toLowerCase(); return x === r.lit; };
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (NON_SWITCH_ENV.test(k)) continue;
    const r = readers.get(k);
    if (!r || r.kind !== "bool") continue;
    if (on(v, r) === on(dotenv[k], r)) out.push(k);
  }
  return out;
}

export function formatUnread(c: EnvNameCheck, cwd: string): string {
  return `コードが読まない env の名前 ${c.unread.length}個（${cwd} の app/）: ` + c.unread.map((u) => `${u.name}${u.near.length ? `（近い名前: ${u.near.join("・")}）` : "（近い名前なし）"}`).join("／") + "。名前を直して積み直す（どうしても積む時は --allow-unread-env）";
}
