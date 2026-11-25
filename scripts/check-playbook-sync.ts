// scripts/check-playbook-sync.ts — 手順書が「コード・DB・本番・拡張」で揃っているかを読むだけで確かめる（2.8.297）
//
// 竹内さん「なんで手順書ちゃんと反映されないこと多いのか／連動して反映されるように」（2026-11-25）。
//   反映が抜ける道は4つ: ①コード（手元）②DB の束の手順書 ③本番のコード（古いと作り直しのたび古い手順書へ戻す）④拡張が実際に読んだ印。
//   これを1回で並べて、どこで切れているかを名指しする。DB は読むだけ（書かない）。軽い読み（各 scope 最新数行・監査 6件）。
//
// 実行:  npx tsx --env-file=.env.local scripts/check-playbook-sync.ts [--no-prod] [--prod=<URL>]
// 終了コード: 0 = 全部揃っている／2 = どこかが切れている（❌）
//
// ⚠ 本番の確認は GET（?touch=0）1回だけ。読んだ印（read_count）は付けない。
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { autoRulesVersion, AUTO_RULES_REVIEWED_UP_TO, AUTO_RULES } from "../app/lib/auto-procedure-rules";
import { PLAYBOOK_BUILD_V } from "../app/lib/action-playbook";
import { cmpVer } from "../app/lib/playbook-freshness";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const argv = process.argv.slice(2);
const noProd = argv.includes("--no-prod");
const prodArg = argv.find((a) => a.startsWith("--prod="))?.slice(7);
const PROD = prodArg || process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";

const bad: string[] = [];
const warn: string[] = [];
const say = (s: string) => console.log(s);
const OK = "✅", NG = "❌", WA = "⚠";

function readText(p: string): string { return fs.readFileSync(path.join(process.cwd(), p), "utf8"); }

async function main() {
  say("■ ① コード（手元）");
  const code = { rv: autoRulesVersion(), upTo: AUTO_RULES_REVIEWED_UP_TO, build: PLAYBOOK_BUILD_V, rules: AUTO_RULES.length };
  const manifestV = String(JSON.parse(readText("chrome-extension/manifest.json")).version);
  const pageV = (readText("chrome-extension/page-script.js").match(/_AXLX_PAGE_VER = "([^"]+)"/) || [])[1] || "?";
  say(`  決まり ${code.rules}件 rules_v=${code.rv} build_v=${code.build} 見直し上限=${code.upTo}`);
  say(`  manifest=${manifestV} page-script=${pageV}`);
  if (manifestV === pageV && pageV === code.upTo) say(`  ${OK} 版の結び（manifest == page-script == 見直し上限）`);
  else { say(`  ${NG} 版の結びが切れている`); bad.push("コード内の版が揃っていない（manifest / page-script / AUTO_RULES_REVIEWED_UP_TO）"); }

  say("\n■ ② DB の束の手順書（各 scope の最新行・戻りの履歴）");
  if (!URL_ || !KEY) { say(`  ${NG} 環境変数が無く DB を読めない`); bad.push("DB を読めない"); }
  else {
    const sb = createClient(URL_, KEY);
    for (const scope of ["all", "realpro", "itandi"]) {
      const { data, error } = await sb
        .from("human_learn_profile")
        .select("id, created_at, ext_version, rules_v:bundle->playbook->>rules_v, build_v:bundle->playbook->>build_v, up_to:bundle->playbook->>rules_up_to")
        .eq("scope", scope).order("created_at", { ascending: false }).limit(6);
      if (error) { say(`  ${NG} ${scope}: 読めない（${error.message}）`); bad.push(`${scope} の束が読めない`); continue; }
      const rows = (data ?? []) as unknown as Array<{ id: number; created_at: string; ext_version: string | null; rules_v: string | null; build_v: string | null; up_to: string | null }>;
      if (!rows.length) { say(`  ${WA} ${scope}: 行なし`); continue; }
      const top = rows[0];
      const topOk = top.rules_v === code.rv && Number(top.build_v) === code.build;
      say(`  ${topOk ? OK : NG} ${scope} 最新 id=${top.id} ${top.created_at.slice(0, 16)} build_v=${top.build_v ?? "-"} rules_v=${(top.rules_v ?? "-").slice(0, 8)} 見直し=${top.up_to ?? "なし"}${topOk ? "" : "  ← コードと違う（attach が必要／本番が古い）"}`);
      if (!topOk) bad.push(`${scope}: DB の手順書がコードと違う（id=${top.id}・build_v=${top.build_v}・rules_v=${(top.rules_v ?? "-").slice(0, 8)}→コード ${code.build}/${code.rv.slice(0, 8)}）`);
      // 戻り: 新しい行が1つ前（古い行）より古い手順書になっていないか
      for (let i = 0; i < rows.length - 1; i++) {
        const nw = rows[i], ol = rows[i + 1];
        const nwUp = nw.up_to ?? "", olUp = ol.up_to ?? "";
        const regress = (Number(nw.build_v) || 0) < (Number(ol.build_v) || 0) || (!!olUp && cmpVer(nwUp, olUp) < 0);
        if (regress) {
          say(`    ${NG} 戻り: id=${nw.id}（${nw.created_at.slice(11, 16)}・build_v=${nw.build_v}）が id=${ol.id}（build_v=${ol.build_v}）より古い手順書`);
          warn.push(`${scope}: 手順書の戻り（id=${nw.id} が id=${ol.id} より古い）＝古いコードが作り直した`);
        }
      }
    }
  }

  say("\n■ ③ 本番のコード（軽い版確認 1回・読んだ印は付けない）");
  if (noProd) say("  （--no-prod で飛ばした）");
  else {
    try {
      const r = await fetch(`${PROD}/api/human-learn-profile?touch=0&scope=realpro`, { cache: "no-store", signal: AbortSignal.timeout(25000) });
      const j = (await r.json()) as Record<string, unknown>;
      const srvUp = j.server_rules_up_to != null ? String(j.server_rules_up_to) : "";
      const srvRv = j.server_rules_v != null ? String(j.server_rules_v) : "";
      const pbUp = j.playbook_rules_up_to != null ? String(j.playbook_rules_up_to) : "";
      say(`  HTTP ${r.status} 本番コードの見直し=${srvUp || "（返さない＝2.8.297 より前のコード）"} rules_v=${srvRv ? srvRv.slice(0, 8) : "-"} 返した手順書の rules_v=${String(j.playbook_rules_v ?? "-").slice(0, 8)} 手順書の見直し=${pbUp || "なし"}`);
      if (!srvUp) { say(`  ${NG} 本番に最新のコードが載っていない（作り直しのたび古い手順書へ戻る）`); bad.push("本番のコードが古い（server_rules_up_to を返さない）＝デプロイが必要"); }
      else if (cmpVer(srvUp, code.upTo) < 0) { say(`  ${NG} 本番コード ${srvUp} < 手元 ${code.upTo}`); bad.push(`本番のコードが手元より古い（${srvUp}→${code.upTo}）＝デプロイが必要`); }
      else say(`  ${OK} 本番のコードは手元と同じ以上`);
    } catch (e) {
      say(`  ${WA} 本番を読めない（${e instanceof Error ? e.message : String(e)}）`);
      warn.push("本番を読めなかった");
    }
  }

  say("\n■ ④ 拡張が実際に読んだ印（最新の点検記録 6件）");
  if (URL_ && KEY) {
    const sb = createClient(URL_, KEY);
    let res = await sb.from("search_audits").select("id, created_at, steps").order("id", { ascending: false }).limit(6);
    if (res.error) res = (await sb.from("search_audits").select("id, steps").order("id", { ascending: false }).limit(6)) as typeof res;
    if (res.error) { say(`  ${WA} 読めない（${res.error.message}）`); warn.push("点検記録を読めなかった"); }
    else {
      for (const a of (res.data ?? []) as unknown as Array<{ id: number; created_at?: string; steps?: Array<{ k: string; d: string | null; n?: number }> }>) {
        const st = Array.isArray(a.steps) ? a.steps : [];
        const find = (k: string) => st.filter((x) => x.k === k);
        const ver = find("page:page_ver")[0]?.d ?? "-";
        const seen = find("page:playbook_seen")[0]?.d ?? null;
        const behind = find("page:playbook_behind")[0]?.d ?? null;
        const srvBehind = find("server_behind")[0]?.d ?? null;
        const none = find("page:playbook_none").length > 0;
        const rbf = find("reset_before_fill").length;
        const collapsed = st.filter((x) => (x.n || 0) > 1).length;
        const flag = behind || srvBehind || none ? NG : seen ? OK : WA;
        say(`  ${flag} #${a.id} ${a.created_at ? a.created_at.slice(5, 16) + " " : ""}ver=${String(ver).slice(0, 12)} 段=${st.length}${collapsed ? `(まとめ${collapsed})` : ""} playbook_seen=${seen ? "あり " + String(seen).slice(0, 40) : "なし"}${behind ? `\n      ${NG} playbook_behind: ${behind}` : ""}${srvBehind ? `\n      ${NG} server_behind: ${srvBehind}` : ""}${none ? `\n      ${NG} playbook_none（手順書が届いていない）` : ""} reset_before_fill=${rbf}`);
      }
      say("  ※ playbook_seen が「なし」＝入力前に手順書を読んだ印が無い（古い拡張・上限で落ちた・自動入力を通っていない）");
    }
  }

  say("\n■ 結論");
  if (!bad.length) { say(`  ${OK} コード・DB・本番が揃っている${warn.length ? "（注意あり）" : ""}`); }
  else { say(`  ${NG} 切れている所 ${bad.length}件:`); bad.forEach((b, i) => say(`   ${i + 1}. ${b}`)); }
  if (warn.length) { say(`  ${WA} 注意:`); warn.forEach((w) => say(`   - ${w}`)); }
  if (bad.length) {
    say("\n  直す順番: (a) 本番が古い → コミット・main へ入れて本番へ出す（竹内さんの「上げて」） (b) その後 attach-playbook を --apply で1回 (c) 拡張を再読み込み＋リアプロのタブを開き直す");
  }
  process.exit(bad.length ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
