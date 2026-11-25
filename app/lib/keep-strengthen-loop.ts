/**
 * F65 強化し続けるループ（2026-11-24 竹内さん「強化していくようにする」）
 *
 * 完了線（仕組みが武装されている）:
 *   ① page に _driveKeepStrengthen（沈黙中も aim再warm＋細分化）
 *   ② F58 スタンプ鮮度あり
 *   ③ keep_strengthen スタンプが next を名指し（止まらず次手がある）
 *   ④ 実証は ≥2.8.246 の自動1回で strengthen_loop 印
 *
 * ⚠ 再現%が上がった＝完了、ではない。上がるまで次手を出し続けるのが完了線。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const KEEP_STRENGTHEN_STAMP_REL = "memory/keep_strengthen_last.json";

export type KeepStrengthenStamp = {
  at: string;
  ok: boolean;
  line: string;
  next: string;
  code_ext_version: string;
  latest_audit_version: string;
  f58_ok: boolean;
  f64_ok: boolean;
  gaps: string[];
  /** 次に強化する原子（1つ） */
  focus: string;
};

export function evaluateKeepStrengthenStamp(stamp: KeepStrengthenStamp | null | undefined): {
  ok: boolean;
  line: string;
  next: string;
} {
  if (!stamp || !stamp.at) {
    return {
      ok: false,
      line: "F65 強化継続スタンプ無し（scripts/keep-strengthen.ts）",
      next: "npx tsx --env-file=.env.local scripts/keep-strengthen.ts",
    };
  }
  const ageH = (Date.now() - new Date(stamp.at).getTime()) / 3600_000;
  if (ageH > 36) {
    return {
      ok: false,
      line: `F65 スタンプ古い（${Math.round(ageH)}h） ${String(stamp.line || "").slice(0, 100)}`,
      next: "npx tsx --env-file=.env.local scripts/keep-strengthen.ts（鮮度）",
    };
  }
  const hasNext = !!String(stamp.next || "").trim();
  const armed = stamp.ok === true && hasNext;
  return {
    ok: armed,
    line: `F65 ${String(stamp.line || "").slice(0, 160)}`,
    next: String(stamp.next || "強化次手を名指し"),
  };
}

export function auditKeepStrengthenLoop(cwd = process.cwd()): {
  ok: boolean;
  line: string;
  next: string;
} {
  const p = join(cwd, KEEP_STRENGTHEN_STAMP_REL);
  if (!existsSync(p)) return evaluateKeepStrengthenStamp(null);
  try {
    const stamp = JSON.parse(readFileSync(p, "utf8")) as KeepStrengthenStamp;
    return evaluateKeepStrengthenStamp(stamp);
  } catch {
    return {
      ok: false,
      line: "F65 スタンプが読めない",
      next: "npx tsx --env-file=.env.local scripts/keep-strengthen.ts",
    };
  }
}

export function writeKeepStrengthenStamp(cwd: string, stamp: KeepStrengthenStamp): void {
  writeFileSync(join(cwd, KEEP_STRENGTHEN_STAMP_REL), JSON.stringify(stamp, null, 2), "utf8");
}

/** page-script に強化継続の配線があるか（無料点検） */
export function scanKeepStrengthenWiring(cwd = process.cwd()): {
  ok: boolean;
  gaps: string[];
  pageVer: string;
} {
  const gaps: string[] = [];
  let pageVer = "";
  try {
    const ps = readFileSync(join(cwd, "chrome-extension/page-script.js"), "utf8");
    const m = ps.match(/_AXLX_PAGE_VER = "([^"]+)"/);
    pageVer = m ? m[1] : "";
    if (!/function _driveKeepStrengthen\(/.test(ps)) gaps.push("_driveKeepStrengthen 無し");
    if (!/strengthen_loop/.test(ps)) gaps.push("strengthen_loop 印無し");
    if (!/_driveKeepStrengthen\("silence/.test(ps) && !/_driveKeepStrengthen\("silence_tick"\)/.test(ps)) {
      gaps.push("沈黙tickで強化継続が呼ばれていない");
    }
    if (pageVer && pageVer < "2.8.246") gaps.push(`page版が古い（要≥2.8.246・今=${pageVer}）`);
  } catch {
    gaps.push("page-script 読めない");
  }
  try {
    const mf = JSON.parse(readFileSync(join(cwd, "chrome-extension/manifest.json"), "utf8"));
    if (String(mf.version || "") < "2.8.246") gaps.push(`manifest < 2.8.246（今=${mf.version}）`);
  } catch {
    gaps.push("manifest 読めない");
  }
  return { ok: gaps.length === 0, gaps, pageVer };
}
