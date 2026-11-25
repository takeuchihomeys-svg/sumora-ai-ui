/**
 * 一連・連携の旧経路点検（統括Pro協力・読むだけ）
 *   1) 最新監査に禁則印が残っていないか
 *   2) コードに実行可能な旧経路が残っていないか
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_STEP = [
  "sort_legacy",
  "claude_path",
  "legacy_claude",
  "flow_atom_ok_sort_legacy",
  "ungrasped_but_list",
  "legacy_after_search",
];
/** 新版で出てほしくない（出たら旧経路が生きている） */
const FORBIDDEN_ON_NEW = [
  /sort_legacy/,
  /claude_path/,
  /ungrasped_but_list/,
  /legacy_after_search/,
  /finishGate:armed_rows/,
  /finishGate:list_visible/,
];

const CODE_ACTIVE_BAD = [
  { id: "stamp_sort_legacy", re: /_stampSortFlowAtom\(\s*["']sort_legacy["']/ },
  { id: "finish_legacy_claude", re: /finishGate\(\s*true\s*,\s*["']legacy_claude/ },
  { id: "finish_armed_rows", re: /finishGate\(\s*true\s*,\s*["']armed_rows["']/ },
  { id: "finish_list_visible", re: /finishGate\(\s*true\s*,\s*["']list_visible["']/ },
  { id: "finish_sync_pending", re: /finishGate\(\s*true\s*,\s*["']sync_pending["']/ },
  { id: "finish_pending_armed", re: /finishGate\(\s*true\s*,\s*["']pending_armed["']/ },
  { id: "markGrasp_armed", re: /markGrasp\(\s*["']armed_rows["']/ },
  { id: "press_sortHead", re: /press\(\s*sortHead\b/ },
  { id: "location_ad_assign", re: /location\.href\s*=\s*[^;]*ad=odr_desc/ },
  { id: "location_adLink", re: /location\.href\s*=\s*_adLink/ },
  { id: "search_grasp_legacy_start", re: /search_grasp_gate["']\s*,\s*["']legacy_claude/ },
];

const CODE_MUST_HAVE = [
  { id: "sort_screen_ok", re: /_stampSortFlowAtom\(\s*["']sort_screen_ok["']/ },
  { id: "legacy_blocked", re: /legacy_blocked_no_screen/ },
  { id: "hover_sortHead", re: /hover\(\s*sortHead\b/ },
  { id: "all_sent_no_press", re: /all_sent_no_press/ },
  { id: "sendBatchDone", re: /function _sendBatchDone\(/ },
  { id: "adSortInFlight", re: /_adSortInFlight/ },
  { id: "armed_wait_screen", re: /armed_wait_screen/ },
  { id: "list_wait_screen", re: /list_wait_screen/ },
];

async function main() {
  const root = process.cwd();
  const bd = readFileSync(join(root, "chrome-extension/bulk-dl.js"), "utf8");
  const ps = readFileSync(join(root, "chrome-extension/page-script.js"), "utf8");
  const mf = JSON.parse(readFileSync(join(root, "chrome-extension/manifest.json"), "utf8"));
  const pageVer = (ps.match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] || "";

  console.log("■ コード版 manifest=" + mf.version + " page=" + pageVer);

  console.log("\n■ コード：禁則の実行経路（残っていたら✗）");
  let codeBad = 0;
  for (const c of CODE_ACTIVE_BAD) {
    const hit = c.re.test(bd) || c.re.test(ps);
    console.log((hit ? "  ✗ " : "  ✓ ") + c.id + (hit ? " が残っている" : " 無し"));
    if (hit) codeBad++;
  }

  console.log("\n■ コード：正本経路（必須）");
  let codeMiss = 0;
  for (const c of CODE_MUST_HAVE) {
    const hit = c.re.test(bd) || c.re.test(ps);
    console.log((hit ? "  ✓ " : "  ✗ ") + c.id + (hit ? "" : " が無い"));
    if (!hit) codeMiss++;
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
  const { data, error } = await sb
    .from("search_audits")
    .select("id,created_at,ext_version,mode,steps")
    .in("mode", ["brain_aix", "aix", "auto"])
    .order("created_at", { ascending: false })
    .limit(40);
  if (error) {
    console.error("DB ERR", error.message);
    process.exit(1);
  }

  console.log("\n■ DB：直近40自動の旧経路印");
  let newVerN = 0;
  let newVerBad = 0;
  let oldStampExamples: string[] = [];
  const verCounts: Record<string, number> = {};
  const badByVer: Record<string, string[]> = {};

  for (const a of data || []) {
    const ver = String(a.ext_version || "?");
    verCounts[ver] = (verCounts[ver] || 0) + 1;
    const steps = Array.isArray(a.steps) ? a.steps : [];
    const keys = steps.map((s: unknown) => {
      if (typeof s === "string") return s;
      const o = s as { k?: string; d?: string };
      return `${o.k || ""}${o.d ? ":" + String(o.d).slice(0, 36) : ""}`;
    });
    const badHits = keys.filter((k) => FORBIDDEN_ON_NEW.some((re) => re.test(k)));
    if (badHits.length) {
      badByVer[ver] = (badByVer[ver] || []).concat(badHits.slice(0, 3));
      if (ver >= "2.8.240") {
        newVerBad++;
        oldStampExamples.push(ver + " " + badHits.slice(0, 2).join("|"));
      }
    }
    if (ver >= "2.8.240") newVerN++;
  }

  console.log("  版分布:", Object.entries(verCounts).slice(0, 12).map(([v, n]) => v + "×" + n).join(" / "));
  console.log("  ≥2.8.240 件数=" + newVerN + " うち禁則印=" + newVerBad);
  if (oldStampExamples.length) {
    console.log("  ⚠ 新版なのに旧印:");
    for (const e of oldStampExamples.slice(0, 8)) console.log("   - " + e);
  } else {
    console.log("  ✓ ≥2.8.240 の監査に禁則印なし（または該当監査なし）");
  }
  console.log("  旧版に残る禁則印（参考・当時の物）:");
  for (const [v, hits] of Object.entries(badByVer)) {
    if (v >= "2.8.240") continue;
    console.log("   " + v + ": " + [...new Set(hits)].slice(0, 4).join(" | "));
  }

  // 連携一連の印（新束後）
  console.log("\n■ DB：連携・一連の印（直近≥2.8.240）");
  const want = [
    "learn_reflect",
    "learn_warm",
    "foundation_gate",
    "sort_screen_ok",
    "sort_flow_grasp",
    "all_sent",
    "loop_advance",
    "handoff",
    "legacy_blocked",
  ];
  const tally: Record<string, number> = {};
  for (const w of want) tally[w] = 0;
  let steps0 = 0;
  let withSteps = 0;
  for (const a of data || []) {
    const ver = String(a.ext_version || "");
    if (ver < "2.8.240") continue;
    const steps = Array.isArray(a.steps) ? a.steps : [];
    if (!steps.length) {
      steps0++;
      continue;
    }
    withSteps++;
    const blob = steps
      .map((s: unknown) => {
        if (typeof s === "string") return s;
        const o = s as { k?: string; d?: string };
        return (o.k || "") + " " + (o.d || "");
      })
      .join("|");
    for (const w of want) {
      if (blob.includes(w)) tally[w]++;
    }
  }
  console.log("  steps有=" + withSteps + " steps0=" + steps0);
  for (const w of want) console.log("  " + w + "=" + tally[w]);

  console.log("\n■ まとめ");
  console.log(
    "  コード禁則残=" +
      codeBad +
      " 正本欠=" +
      codeMiss +
      " 新版旧印=" +
      newVerBad +
      " 最新版コード=" +
      pageVer,
  );
  const ok = codeBad === 0 && codeMiss === 0;
  console.log(ok ? "  → コード上の実行可能旧経路は無し（現場反映は再読込が関所）" : "  → コードに要修正あり");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
