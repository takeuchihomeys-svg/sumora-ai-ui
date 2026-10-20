// scripts/lib/exam-env-fp.ts — 試験の「環境のスイッチの指紋」（どのスイッチを既定と違う値で回したか）
//
// 2026-10-21 試験のブレインの穴: 使い回しの鍵・持ち越しの鍵・録音（LLM カセット）の鍵にスイッチ（DAY_SUBJECT_READER 等）が入っていなかった。
//   DAY_SUBJECT_READER=on で回した後に off（対照）で回すと、off の回が on の答えを使い回し、on/off の比べが無効になっていた。
//
// 指紋の決まり:
//   1. 対象の名前 = app/ の本番コード（__tests__ を除く）が読む env.X / env["X"] の名前 ∪ スイッチの形の名前（FP_SWITCH_RE）。
//      鍵・秘密・URL・試験の道具（LLM_*・EXAM_*・REPLAY_* 等）・モデルの選び（DEEPSEEK_MODEL・CLAUDE_*MODEL＝別に鍵に入る）は外す（FP_EXCLUDE_RE）。
//   2. 既定 = 作業ツリーの .env.local の値（試験は --env-file=.env.local で回す＝本番と同じ構成。.env.local に無い＝付けない）。
//      指紋に入るのは「今の環境の値が既定と違う」名前だけ＝付けていない回（main・既定）の指紋は空（""）＝今までの鍵・置き場はそのまま使える。
//   3. 値の比べは「コードがどう読むか」で: コードの読み方が全部 `(env.X ?? "d").trim().toLowerCase() === "on"`（!== "off" 等）の形で
//      同じ文字と比べているなら、効く値（=on / !=on）で比べる＝付けない と 既定の値を明示（X=off）は同じ指紋。読み方が分からない名前は
//      前後の空白を除いた生の値（付けない＝""）で比べる（安全側＝違えば別の鍵）。
//   4. 文字 = 違う名前を並べた「NAME=値」の列（値は今の生の値・付けない時は (unset)）。hash = その sha256 の先頭 10字（空なら ""）。
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 指紋から外す名前（鍵・秘密・URL・試験の道具・モデルの選び＝別の鍵に入る・端末の物） */
export const FP_EXCLUDE_RE = /KEY|SECRET|TOKEN|PASSWORD|_URL$|^NEXT_PUBLIC_SUPABASE|^(?:LLM_|EXAM_|BRAIN_EXAM_|REPLAY_|NODE_|VERCEL|CRON_|TEST_CLOCK|DEEPSEEK_MODEL$|CLAUDE_\w*MODEL|CLAUDE_SONNET55_ACTIONS$|TZ$|CI$|PATH$|HOME$|TEMP$|TMP$|PWD$|SHELL$|USER|LANG$|TERM)/;
/** コードから見つからなくても（env[`X_${part}`] のような読み方）スイッチとみる名前の形 */
export const FP_SWITCH_RE = /^(?:DAY_SUBJECT_READER|STAFF_ONLY_AIX_|WRITING_BLUEPRINT|APPLY_ROUTE_MAP|SECOND_MSG_MATERIALS|OTHER_VIEWING_INVITE|SCREENING_PII_CLAUDE|ACK_|WRITER_|LINE_WATCH_|COMPANY_FACT_|BRAIN_|AIX_|TWO_STAGE_|SEARCH_|TURN_|CONFIRM_|REPEAT_|FINAL_CHECK_|PICKUP_|VIEWING_|EXHAUSTED_|ROOM_PHOTO_|CONTRACT_|REPLY_)/;

export type EnvReader = { kind: "bool"; lit: string; dflt: string; lower: boolean } | { kind: "raw" };
export type EnvFingerprint = { pairs: Array<[string, string]>; text: string; hash: string };
export const EMPTY_ENV_FP: EnvFingerprint = { pairs: [], text: "", hash: "" };

/** .env.local の読み（KEY=VALUE・# の行・引用符・BOM） */
export function parseDotenv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of src.replace(/^﻿/, "").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

/**
 * ソースの文字から、名前ごとの読み方を集める。1か所でも形が読めない・比べる文字や既定が違う → raw
 *   読める形: `env.X ?? "d")[.trim()][.toLowerCase()] ===|!== "lit"` ／ `env.X ===|!== "lit"`（process.env. も同じ）
 */
export function collectReaders(sources: string[]): Map<string, EnvReader> {
  const seen = new Map<string, Array<EnvReader>>();
  // 2026-10-21 確かめる人: process.env?.X（?. の読み方）が拾えず PII_MASK_KEEP_OWNER・STAFF_RESULT_GATE・RENT_BAND_SCORING 等が指紋から漏れていた → ?. も拾う
  const ref = /\benv(?:\??\.([A-Z][A-Z0-9_]{2,})|(?:\?\.)?\[\s*["'`]([A-Z][A-Z0-9_]{2,})["'`]\s*\])/g;
  const shape = /^\s*(?:\?\?\s*(["'])([^"'\n]*)\1\s*\))?((?:\s*\.\s*(?:trim|toLowerCase|toUpperCase)\(\))*)\s*\)?((?:\s*\.\s*(?:trim|toLowerCase|toUpperCase)\(\))*)\s*(===|!==)\s*(["'])([^"'\n]*)\6/;
  for (const src of sources) {
    let m: RegExpExecArray | null;
    ref.lastIndex = 0;
    while ((m = ref.exec(src))) {
      const name = m[1] ?? m[2];
      const s = shape.exec(src.slice(m.index + m[0].length, m.index + m[0].length + 120));
      // toUpperCase で比べる読み方は効く値の比べ（小文字に揃える）と合わない → raw（安全側）
      const r: EnvReader = s && !/toUpperCase/.test(`${s[3]}${s[4]}`) ? { kind: "bool", lit: /toLowerCase/.test(`${s[3]}${s[4]}`) ? s[7].toLowerCase() : s[7], dflt: s[2] ?? "", lower: /toLowerCase/.test(`${s[3]}${s[4]}`) } : { kind: "raw" };
      const a = seen.get(name) ?? []; a.push(r); seen.set(name, a);
    }
  }
  // 2026-10-21 確かめる人: 名前を文字で渡して中で env[name] を読む手伝いの関数（flag("ITSUDEMO_R13", env)・meetingDayWordOn(env, "MEETING_DAY_WORD")）と、
  //   「戻す X=off」の書き置きだけで読み方が見えない名前も拾う（読み方が分からない＝raw＝安全側）。手伝い経由の名前は bool の読み方があっても raw にする
  const viaHelper = /\b[A-Za-z_$][\w$]*\(\s*(?:["'`]([A-Z][A-Z0-9_]{3,})["'`]\s*,\s*[\w$.?]*\benv\b|[\w$.?]*\benv\s*,\s*["'`]([A-Z][A-Z0-9_]{3,})["'`])/g;
  const docSwitch = /\b([A-Z][A-Z0-9_]{3,})\s*=\s*(?:on|off)\b/g;
  for (const src of sources) {
    let m: RegExpExecArray | null;
    viaHelper.lastIndex = 0;
    while ((m = viaHelper.exec(src))) { const name = m[1] ?? m[2]; const a = seen.get(name) ?? []; a.push({ kind: "raw" }); seen.set(name, a); }
    docSwitch.lastIndex = 0;
    while ((m = docSwitch.exec(src))) { if (!seen.has(m[1])) seen.set(m[1], [{ kind: "raw" }]); }
  }
  const out = new Map<string, EnvReader>();
  for (const [name, rs] of seen) {
    const b = rs.filter((r): r is Extract<EnvReader, { kind: "bool" }> => r.kind === "bool");
    const same = b.length === rs.length && b.every((r) => r.lit === b[0].lit && r.dflt === b[0].dflt && r.lower === b[0].lower);
    out.set(name, same ? b[0] : { kind: "raw" });
  }
  return out;
}

/** 効く値（比べ用）: bool の読み方なら "=lit" / "!=lit"、それ以外は前後の空白を除いた生の値（付けない＝""） */
export function canonValue(v: string | undefined, r: EnvReader | undefined): string {
  if (r?.kind === "bool") {
    let x = (v ?? r.dflt).trim(); if (r.lower) x = x.toLowerCase();
    return x === r.lit ? `=${r.lit}` : `!=${r.lit}`;
  }
  return (v ?? "").trim();
}

function walk(dir: string, out: string[]) {
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n === "node_modules" || n === "__tests__" || n.startsWith(".")) continue;
    const p = join(dir, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(?:ts|tsx|mts|js|mjs)$/.test(n) && !/\.test\.[tj]sx?$/.test(n)) out.push(p);
  }
}
const readerMemo = new Map<string, Map<string, EnvReader>>();
/** root/app（本番コード）の読み方（同じ root は1回だけ読む） */
export function appReaders(root = "."): Map<string, EnvReader> {
  const hit = readerMemo.get(root); if (hit) return hit;
  const files: string[] = []; walk(join(root, "app"), files);
  const m = collectReaders(files.map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }));
  readerMemo.set(root, m);
  return m;
}
export function readDotenvLocal(root = "."): Record<string, string> {
  const f = join(root, ".env.local");
  if (!existsSync(f)) return {};
  try { return parseDotenv(readFileSync(f, "utf8")); } catch { return {}; }
}

/** 対象の名前か（外す名前でない・コードが読むかスイッチの形） */
export function isFpName(name: string, readers: Map<string, EnvReader>): boolean {
  if (FP_EXCLUDE_RE.test(name)) return false;
  return readers.has(name) || FP_SWITCH_RE.test(name);
}

/** 指紋（純粋・テスト用に readers・dotenv を渡せる） */
export function envFingerprintOf(env: Record<string, string | undefined>, dotenv: Record<string, string>, readers: Map<string, EnvReader>): EnvFingerprint {
  const names = [...new Set([...Object.keys(env), ...Object.keys(dotenv)])].filter((k) => isFpName(k, readers)).sort();
  const pairs: Array<[string, string]> = [];
  for (const k of names) {
    const r = readers.get(k);
    if (canonValue(env[k], r) !== canonValue(dotenv[k], r)) pairs.push([k, env[k] === undefined ? "(unset)" : String(env[k]).trim()]);
  }
  const text = pairs.map(([k, v]) => `${k}=${v}`).join(",");
  return { pairs, text, hash: text ? createHash("sha256").update(text).digest("hex").slice(0, 10) : "" };
}

/** 今の作業ツリー（root）の指紋。EXAM_ENV_FP=off で止める（旧＝指紋なし） */
export function examEnvFingerprint(env: Record<string, string | undefined> = process.env, root = "."): EnvFingerprint {
  if (String(env.EXAM_ENV_FP ?? "").trim().toLowerCase() === "off") return EMPTY_ENV_FP;
  return envFingerprintOf(env, readDotenvLocal(root), appReaders(root));
}

/** 既定の環境（main＝本番の構成）: 指紋に入る名前を .env.local の値に戻す（.env.local に無い名前は消す） */
export function defaultEnvOf(env: Record<string, string | undefined>, fp: EnvFingerprint, dotenv: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const [k] of fp.pairs) { if (k in dotenv) out[k] = dotenv[k]; else delete out[k]; }
  return out;
}

/** 見せる形（見出し・結果に残す） */
export function formatEnvFp(fp: EnvFingerprint): string { return fp.hash ? `${fp.hash}（${fp.text}）` : "既定（.env.local のまま・スイッチを替えていない）"; }

/** 2つの回の指紋が違う時の注意（同じなら null）。古い結果（指紋なし）は既定とみる */
export function envFpMismatchNote(cur: { hash?: string; text?: string } | null | undefined, base: { hash?: string; text?: string } | null | undefined, baseName = "前"): string | null {
  const a = cur?.hash ?? "", b = base?.hash ?? "";
  if (a === b) return null;
  return `⚠ スイッチの指紋が違う: 今 ${a ? `${a}（${cur?.text ?? ""}）` : "既定"} ／ ${baseName} ${b ? `${b}（${base?.text ?? ""}）` : "既定"}${a && !b ? "（前＝本番の構成と比べている）" : ""}`;
}
