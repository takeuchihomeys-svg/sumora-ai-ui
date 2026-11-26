// scripts/attach-playbook.ts — 最新の学習の束（scope ごと1行）に「名前の除去」と「手順書」を付ける（2026-11-20）
//
// ★ 背景: 写真学習の後の作り直し・毎日の cron は、名前の除去と手順書を通していなかった。
//   そのため最新行に「今の客:〈名前〉」が戻り、playbook が無かった（実測 2026-11-20 12:1x）。
//   → 書く経路は prepareBundleForWrite（app/lib/bundle-write-prepare.ts）を通すように直した。
//      この script は、今ある**最新の行だけ**を同じ処理で整える（過去の行は scrub-bundle-names で済み）。
//
// 実行:
//   npx tsx --env-file=.env.local scripts/attach-playbook.ts                              （確かめるだけ・書かない）
//   npx tsx --env-file=.env.local scripts/attach-playbook.ts --apply --backup-dir=<控えの場所>
//   戻す: scripts/attach-playbook.ts --restore=<控えの場所>
// ⚠ 控えには名前が入る。控えはリポジトリの外に置く（コミットしない）。
// ⚠ 行は1つずつ・PATCH（新しい行は作らない）。読むのは scope ごとの最新1行だけ。

import * as fs from "fs";
import * as path from "path";
import { prepareBundleForWrite } from "../app/lib/bundle-write-prepare";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const SCOPES = ["all", "realpro", "itandi"];
const NAME_RE = /今の客:[A-Za-z_]+ [^"\\]+/g;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const backupDir = args.find((a) => a.startsWith("--backup-dir="))?.slice(13) ?? "";
const restoreDir = args.find((a) => a.startsWith("--restore="))?.slice(10);

type Row = { id: number; scope: string; created_at: string; bundle: Record<string, unknown> };

async function latest(scope: string): Promise<Row | null> {
  const r = await fetch(`${URL_}/rest/v1/human_learn_profile?select=id,scope,created_at,bundle&scope=eq.${scope}&order=created_at.desc&limit=1`, { headers: H, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`読めません scope=${scope} (${r.status})`);
  const [row] = (await r.json()) as Row[];
  return row ?? null;
}

async function main() {
  if (!URL_ || !KEY) { console.error("環境変数が足りません（NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）"); process.exit(1); }

  if (restoreDir) {
    for (const f of fs.readdirSync(restoreDir).filter((x) => x.endsWith(".json"))) {
      const id = Number(f.replace(".json", ""));
      const bundle = JSON.parse(fs.readFileSync(path.join(restoreDir, f), "utf8"));
      const r = await fetch(`${URL_}/rest/v1/human_learn_profile?id=eq.${id}`, { method: "PATCH", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify({ bundle }) });
      if (!r.ok) throw new Error(`戻せません id=${id} (${r.status})`);
      console.log(`戻しました id=${id}`);
    }
    return;
  }

  if (apply) {
    if (!backupDir) { console.error("--apply には --backup-dir=<リポジトリの外の場所> が要ります"); process.exit(1); }
    if (path.resolve(backupDir).toLowerCase().startsWith(path.resolve(process.cwd()).toLowerCase())) {
      console.error("控えはリポジトリの中に置けません（名前が入るため）"); process.exit(1);
    }
    fs.mkdirSync(backupDir, { recursive: true });
  }

  for (const scope of SCOPES) {
    const row = await latest(scope);
    if (!row) { console.log(`■ ${scope}: 行が無い`); continue; }
    const before = JSON.stringify(row.bundle);
    const namesBefore = (before.match(NAME_RE) || []).length;
    const hadPlaybook = !!row.bundle.playbook;

    const clone = JSON.parse(before) as Record<string, unknown>;
    const prep = prepareBundleForWrite(clone, scope); // 2026-11-26: サイトを渡す（itandi にリアプロの手を載せない）
    const after = JSON.stringify(clone);
    const namesAfter = (after.match(NAME_RE) || []).length;
    const pb = clone.playbook as { version?: unknown; scenes?: unknown[]; positions?: unknown[] } | undefined;

    console.log(`■ ${scope}: 行 id=${row.id} 作成=${row.created_at}`);
    console.log(`  名前: 前 ${namesBefore}か所 → 後 ${namesAfter}か所（名前そのものは表示しない）`);
    console.log(`  手順書: 前 ${hadPlaybook ? "あり" : "なし"} → 後 ${pb ? `あり（version=${String(pb.version ?? "?")} 場面=${pb.scenes?.length ?? 0} 押す位置=${pb.positions?.length ?? 0}）` : "なし"}`);

    if (!apply) continue;
    if (!prep.playbook_ok) { console.log("  手順書を作れないので書きません"); continue; }
    /**
     * ★ 2026-11-23 竹内さん「拡張が新束を読んでいない／手順書抜けを仕組み化」:
     *   実測: 手順書だけ PATCH すると generated_at が据え置き → 拡張が same_version で取り直しをスキップ。
     *   → 書く時は必ず generated_at を今にし、read_count を 0 に戻す（新手順書の反映は未実証と明示）。
     */
    clone.generated_at = new Date().toISOString();
    const pbAfter = clone.playbook as { rules_v?: string; rules?: unknown[] } | undefined;
    console.log(`  版上げ: generated_at を更新／決まり版=${pbAfter?.rules_v ?? "-"}／件数=${pbAfter?.rules?.length ?? 0}${prep.playbook_ver_bumped ? "（rules_v変化）" : "（attach強制）"}`);
    console.log(`  ⚠ 関所: 拡張再読込→自動1回まで「反映済み」と言わない（read は 0 に戻す）`);
    fs.writeFileSync(path.join(backupDir, `${row.id}.json`), before);
    const r = await fetch(`${URL_}/rest/v1/human_learn_profile?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { ...H, Prefer: "return=minimal" },
      body: JSON.stringify({ bundle: clone, read_count: 0, read_at: null }),
    });
    if (!r.ok) throw new Error(`書けません id=${row.id} (${r.status})`);
    console.log(`  書きました（控え: ${backupDir}）`);
    try {
      const stampDir = path.join(process.cwd(), "memory");
      fs.mkdirSync(stampDir, { recursive: true });
      fs.writeFileSync(path.join(stampDir, "playbook_reflect_pending.json"), JSON.stringify({
        at: new Date().toISOString(),
        scope,
        row_id: row.id,
        rules_v: pbAfter?.rules_v ?? null,
        rules_n: pbAfter?.rules?.length ?? 0,
        generated_at: clone.generated_at,
        next: "拡張≥2.8.206再読込→自動1回→check-playbook-reflect（rv一致・read≥1）",
      }, null, 2));
    } catch { /* スタンプ失敗でも本体は書けた */ }
  }
  if (!apply) console.log("（dry-run: 何も書いていません。--apply --backup-dir=<場所> で書きます）");
}

main().catch((e) => { console.error("失敗:", e instanceof Error ? e.message : String(e)); process.exit(1); });
