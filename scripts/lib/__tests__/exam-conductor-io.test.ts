// 試験のブレインの司令塔の読み書き（scripts/lib/exam-conductor-io.ts）の「直した中身」の範囲・--range の確かめの単体テスト（LLM も DB も使わない・git だけ）
// 実行: npx tsx scripts/lib/__tests__/exam-conductor-io.test.ts（全 PASS で exit 0）
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyRange, resolveRev, diffMaterial, mainAnsweredIds, autoBaseCandidates } from "../exam-conductor-io";

let fail = 0, pass = 0;
function ok(name: string, cond: boolean, detail = "") { if (cond) pass++; else { fail++; console.error(`✗ ${name}${detail ? `\n   ${detail}` : ""}`); } }
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();

const root = mkdtempSync(join(tmpdir(), "exam-cond-io-"));
try {
  // 小さな倉庫: main に A → B → C（C で app/lib/x.ts を変える）
  const repo = join(root, "repo");
  mkdirSync(join(repo, "app", "lib"), { recursive: true });
  g(root, "init", "-q", "-b", "main", "repo");
  g(repo, "config", "user.email", "t@example.invalid"); g(repo, "config", "user.name", "t"); g(repo, "config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "README.md"), "a\n"); g(repo, "add", "README.md"); g(repo, "commit", "-q", "-m", "A");
  const A = g(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "README.md"), "b\n"); g(repo, "add", "README.md"); g(repo, "commit", "-q", "-m", "B");
  const B = g(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "app", "lib", "x.ts"), "export const x = 1;\n"); g(repo, "add", "app/lib/x.ts"); g(repo, "commit", "-q", "-m", "C q175 を足した");
  const C = g(repo, "rev-parse", "HEAD");

  // ① --range の確かめ（お金を使う前）
  ok("resolveRev: ある版", resolveRev("HEAD", repo) === C);
  ok("resolveRev: 無い版は null", resolveRev("deadbeefdeadbeef", repo) === null);
  ok("verifyRange: 正しい範囲", verifyRange(`${A.slice(0, 8)}..main`, repo).toSha === C);
  let e1 = ""; try { verifyRange("deadbeef1234..main", repo); } catch (e) { e1 = String(e); }
  ok("verifyRange: この倉庫に無い commit → 分かる言葉で止める", /この倉庫に無い版 deadbeef1234/.test(e1), e1);
  let e2 = ""; try { verifyRange("main", repo); } catch (e) { e2 = String(e); }
  ok("verifyRange: 形が違う → 止める", /<a>\.\.<b>/.test(e2), e2);

  // ② --range の時は範囲の変わったファイルを見る（"none"・ファイル 0 にしない）
  (async () => {
    const m = await diffMaterial(null, repo, { range: `${A}..${C}`, baseDir: join(root, "nobase") });
    ok("diffMaterial --range: 範囲の変わったファイル", m.files.some((f) => f.file === "app/lib/x.ts") && m.files.some((f) => f.file === "README.md"), JSON.stringify(m.files));
    ok("diffMaterial --range: コミットは範囲の分", m.commits.length === 2, JSON.stringify(m.commits));
    ok("diffMaterial --range: 範囲を返す", m.range === `${A}..${C}` && /--range/.test(m.rangeWhy));
    ok("diffMaterial --range: ファイル 0 の言葉を出さない", !/変わったファイルが無い/.test(m.note), m.note);
    let e3 = ""; try { await diffMaterial(null, repo, { range: `deadbeef1234..${C}` }); } catch (e) { e3 = String(e); }
    ok("diffMaterial: 無い版の --range は止める（安全側で全部に化けない）", /この倉庫に無い版/.test(e3), e3);

    // ③ main の作業ツリー（main との分かれ目＝HEAD・差 0）: 保存した main の答案（warm-main）の後に入った変更を見る
    const base = join(root, "baseline");
    mkdirSync(join(base, "v-key1-cfg"), { recursive: true });
    writeFileSync(join(base, "v-key1-cfg", "config.json"), JSON.stringify({ commit: B }));
    writeFileSync(join(base, "v-key1-cfg", "q001.json"), JSON.stringify({ savedAt: "2026-10-20T00:00:00Z", rows: [{ id: "q001", rep: 1 }] }));
    writeFileSync(join(base, "v-key1-cfg", "q175.json"), JSON.stringify({ savedAt: "2026-10-20T00:00:00Z", rows: [] }));
    const mm = await diffMaterial(null, repo, { baseDir: base });
    ok("main の作業ツリー: warm-main の commit からの変更を見る", mm.range === `${B}..${C}` && /保存した main の答案/.test(mm.rangeWhy), `${mm.range} ${mm.rangeWhy}`);
    ok("main の作業ツリー: その後に入ったファイル", mm.files.length === 1 && mm.files[0].file === "app/lib/x.ts", JSON.stringify(mm.files));
    ok("main の作業ツリー: コミットはその後の分", mm.commits.length === 1);
    // warm-main の情報が無い（＋前の司令塔の結果がこの倉庫に無い）→ 今まで通り（範囲なし）
    const none = await diffMaterial(null, repo, { baseDir: join(root, "nobase") });
    const fromConductor = autoBaseCandidates(join(root, "nobase")).some((c) => c.group === "conductor" && resolveRev(c.commit, repo));
    if (!fromConductor) ok("起点が無い → 今まで通り（範囲なし・ファイル 0）", none.range === null && none.files.length === 0, JSON.stringify(none));
    // 普通の作業ツリー（main から分かれた枝で直した）→ 今まで通り作業ツリーの差
    g(repo, "checkout", "-q", "-b", "fix");
    writeFileSync(join(repo, "app", "lib", "y.ts"), "export const y = 1;\n");
    const wt = await diffMaterial(null, repo, { baseDir: base });
    // （この小さな倉庫にはブレインの入口が無い＝作業ツリーの差の分け方は今まで通り「安全側（両方）」。ここでは自動の起点に化けない事だけ見る）
    ok("普通の作業ツリー（作業中の変更あり）: 自動の起点を使わない＝今まで通り作業ツリーの差", wt.range === null && wt.rangeWhy === "" && wt.base === C, JSON.stringify(wt));

    // ④ 新しい問題の見分け: main の答案（rows がある物）だけ数える
    const ans = mainAnsweredIds(base);
    ok("main の答案がある問題（rows が空の物は数えない）", ans.has("q001") && !ans.has("q175"));
    ok("置き場が無い → 空", mainAnsweredIds(join(root, "nobase")).size === 0);
  })().catch((e) => { fail++; console.error(e); }).finally(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    console.log(`exam-conductor-io: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
  });
} catch (e) { console.error(e); try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } process.exit(1); }
