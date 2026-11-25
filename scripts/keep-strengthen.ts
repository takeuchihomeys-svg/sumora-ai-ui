/**
 * F65 強化し続けるループ（無料・仕組み武装）
 *
 *   npx tsx --env-file=.env.local scripts/keep-strengthen.ts
 *
 * ①配線スキャン（_driveKeepStrengthen）
 * ②F58/F64 スタンプを読んで次手を1つに絞る
 * ③memory/keep_strengthen_last.json に残す（統括・F65が読む）
 *
 * ⚠ 再現%を上げる走行（再読込→自動1回）は人。ここは「止まらず次を名指し」まで。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KEEP_STRENGTHEN_STAMP_REL,
  scanKeepStrengthenWiring,
  writeKeepStrengthenStamp,
  type KeepStrengthenStamp,
} from "../app/lib/keep-strengthen-loop";
import { EXT_TEST_LOOP_STAMP_REL } from "../app/lib/ext-test-improve-loop";
import { ROOT_CAUSE_LOOP_STAMP_REL } from "../app/lib/root-cause-improve-loop";

const root = process.cwd();

function readJson(rel: string): Record<string, unknown> | null {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function main() {
  const wire = scanKeepStrengthenWiring(root);
  const f58 = readJson(EXT_TEST_LOOP_STAMP_REL);
  const f64 = readJson(ROOT_CAUSE_LOOP_STAMP_REL);
  const f58Ok = !!(f58 && f58.ok === true);
  const f64Ok = !!(f64 && f64.ok === true);
  const codeVer = wire.pageVer || "";
  const latestAudit = String((f64 && f64.code_ext_version) || (f64 && (f64 as { latest_audit_version?: string }).latest_audit_version) || "");
  // root_cause stamp has code_ext_version and often gaps about latest=
  let auditVer = "";
  try {
    const line = String((f64 && f64.line) || "");
    const m = line.match(/latest=([0-9.]+)/);
    if (m) auditVer = m[1];
  } catch { /* */ }
  if (!auditVer) {
    try {
      const next = String((f64 && f64.next) || "");
      const m2 = next.match(/latest=([0-9.]+)/);
      if (m2) auditVer = m2[1];
    } catch { /* */ }
  }

  const gaps: string[] = [...wire.gaps];
  if (!f58Ok) gaps.push("F58未PASSまたはスタンプ無し → npx tsx scripts/ext-test-improve-loop.ts");
  if (!f64Ok) {
    const g0 = Array.isArray(f64?.gaps) ? String((f64!.gaps as string[])[0] || "") : "";
    gaps.push(g0 || "F64未完了（実証印または版ズレ）");
  }

  let focus = "配線維持";
  let next = "拡張≥2.8.246再読込→自動1回→印 strengthen_loop／foundation_aim_warm";
  if (!wire.ok) {
    focus = "keep_strengthen_wiring";
    next = wire.gaps[0] || "page に _driveKeepStrengthen を足す";
  } else if (!f58Ok) {
    focus = "F58_ext_test";
    next = "npx tsx scripts/ext-test-improve-loop.ts";
  } else if (auditVer && codeVer && auditVer < codeVer) {
    focus = "need_auto_run";
    next = `拡張${codeVer}再読込→自動1回（今の監査=${auditVer}）→strengthen_loop印`;
  } else if (!f64Ok) {
    focus = "F64_field_proof";
    next = String((f64 && f64.next) || "npx tsx --env-file=.env.local scripts/root-cause-improve-loop.ts");
  } else {
    focus = "reproduce_score";
    next = "自動継続→cursor≥70・point≥60 を数字で確認。未達なら aim warm／細分化を沈黙tickで回す";
  }

  /** 仕組み武装＝配線あり＋次手が名指し。点数完了ではない */
  const ok = wire.ok && !!next;
  const stamp: KeepStrengthenStamp = {
    at: new Date().toISOString(),
    ok,
    line: ok
      ? `強化継続武装✓ focus=${focus} F58=${f58Ok ? "✓" : "✗"} F64=${f64Ok ? "✓" : "✗"} code=${codeVer} audit=${auditVer || "?"}`
      : `強化継続未武装 gaps=${gaps.slice(0, 3).join("／")}`,
    next,
    code_ext_version: codeVer,
    latest_audit_version: auditVer || latestAudit || "",
    f58_ok: f58Ok,
    f64_ok: f64Ok,
    gaps: gaps.slice(0, 12),
    focus,
  };
  writeKeepStrengthenStamp(root, stamp);
  console.log("■ F65 強化継続");
  console.log("  " + stamp.line);
  console.log("  次: " + stamp.next);
  if (gaps.length) {
    console.log("  抜け:");
    for (const g of gaps.slice(0, 8)) console.log("   - " + g);
  }
  console.log("  スタンプ: " + KEEP_STRENGTHEN_STAMP_REL);
  process.exit(ok ? 0 : 1);
}

main();
