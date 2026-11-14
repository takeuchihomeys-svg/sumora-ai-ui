// app/lib/__tests__/rls-off.test.ts
// 2026-11-14 竹内さん「RLS無効にする」
//
//   実測（公開キーで読む・head:true で件数だけ）:
//     human_motion_learn  → 0件（RLS で読めない）
//     human_learn_profile → 0件（RLS で読めない）
//     learn_supervisor_log / learn_improvements / search_audits /
//     automation_commands / property_customers → 読める
//   ⚠ **この2つだけ RLS が有効**だったため:
//     ・写真学習が「読む物がありません」で1枚も動かない
//     ・学習の束が残らない
//   → 他の表と同じ扱い（DISABLE）にそろえる。
//
// ⚠ 安全のため（このテストで固定する）:
//   ① 外すのは**この2つの表だけ**（他の表には触らない）
//   ② **消す操作はしない**（RLS の設定を変えるだけ・DELETE/TRUNCATE を書かない）
//   ③ migrate-schema にも同じ1行を入れる（夜の自動適用でも外れる・後回しにしない）
//   ④ 何度呼んでも安全（状態を返すだけ）
//
// 実行: npx tsx --env-file=.env.local app/lib/__tests__/rls-off.test.ts
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra === undefined ? "" : "  → " + JSON.stringify(extra).slice(0, 400))); }
};

const root = path.join(__dirname, "..", "..", "..");
const api = fs.readFileSync(path.join(root, "app", "api", "rls-off", "route.ts"), "utf8");
const mig = fs.readFileSync(path.join(root, "app", "api", "migrate-schema", "route.ts"), "utf8");

console.log("■ ① 外すのは2つの表だけ");
{
  ok("human_motion_learn を外す", /"human_motion_learn"/.test(api));
  ok("human_learn_profile を外す", /"human_learn_profile"/.test(api));
  ok("  ⚠ 他の表を触らない（3つ以上ない）", (api.match(/"(human_[a-z_]+|search_audits|automation_commands|property_customers)"/g) || []).length === 2, api.match(/"(human_[a-z_]+)"/g));
}

console.log("\n■ ② 消す操作はしない（RLS の設定だけ）");
{
  ok("DELETE を書かない", !/\bDELETE\s+FROM/i.test(api));
  ok("TRUNCATE を書かない", !/\bTRUNCATE\b/i.test(api));
  ok("DROP を書かない", !/\bDROP\s+TABLE/i.test(api));
  ok("ALTER ... DISABLE ROW LEVEL SECURITY だけ", /ALTER TABLE \$\{t\} DISABLE ROW LEVEL SECURITY/.test(api));
}

console.log("\n■ ③ migrate-schema にも同じ1行（夜の自動適用でも外れる）");
{
  ok("human_motion_learn DISABLE", /ALTER TABLE human_motion_learn DISABLE ROW LEVEL SECURITY/.test(mig));
  ok("human_learn_profile DISABLE", /ALTER TABLE human_learn_profile DISABLE ROW LEVEL SECURITY/.test(mig));
  ok("  ⚠ ENABLE より後ろ（最後に効く）",
    mig.indexOf("ALTER TABLE human_motion_learn DISABLE ROW LEVEL SECURITY") >
    mig.indexOf("ALTER TABLE human_motion_learn ENABLE ROW LEVEL SECURITY"));
  ok("  ⚠ 同じく human_learn_profile も後ろ",
    mig.indexOf("ALTER TABLE human_learn_profile DISABLE ROW LEVEL SECURITY") >
    mig.indexOf("ALTER TABLE human_learn_profile ENABLE ROW LEVEL SECURITY"));
}

console.log("\n■ ④ SQL 文字列に JS のコメントを書かない（構文が壊れる）");
{
  /**
   * ⚠ 今日2回踏んだ: SQL のテンプレート文字列の中に `/** *\/` を書くと JS の構文エラーになる。
   *   SQL のコメントは `--`。
   */
  const lines = mig.split("\n");
  const bad: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\/\*\*/.test(lines[i])) {
      // 前後が SQL の中か（テンプレートリテラルの中）をざっくり見る
      const before = lines.slice(Math.max(0, i - 40), i).join("\n");
      const opens = (before.match(/`/g) || []).length;
      if (opens % 2 === 1) bad.push(i + 1);
    }
  }
  ok("⚠ SQL の中に /** を書いていない", bad.length === 0, bad);
}

console.log("\n■ ⑤ 何度呼んでも安全");
{
  ok("GET と POST の両方", /export async function GET/.test(api) && /export async function POST/.test(api));
  ok("  status を返す（何度呼んでも同じ結果）", /results/.test(api) && /checks/.test(api));
  ok("  権限が無い時に理由を返す", /permission denied/.test(api));
  /**
   * ⚠ 「個人情報を扱わない」は**列名・関数名**で見る（説明文の言葉に引っかからない）。
   *   旧は `/message/i` が説明文の「message」に当たって誤判定していた。
   */
  ok("  個人情報の列を読まない", !/\.select\([^)]*customer_name|\.select\([^)]*phone|\.select\([^)]*address/i.test(api));
  ok("  表から中身を取らない（数だけ）", /select\("id",\s*\{\s*count:\s*"exact",\s*head:\s*true\s*\}\)/.test(api));
}

console.log("\n" + pass + " passed, " + fail + " failed");
if (fail) process.exit(1);
