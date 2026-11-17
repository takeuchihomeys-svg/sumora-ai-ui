/**
 * 統括の Pro 判断を手元で回す（2026-11-16）
 *
 *   `npx tsx --env-file=.env.local scripts/supervisor-pro.ts`
 *     → 最新の決定論束を取り、Pro で判断して**生の言葉**を出す
 *
 *   `--save`  … 判断後に learn_supervisor_log へ保存（DBに残す）
 *   `--scope=realpro`  … サイト別（既定 all）
 *   `--meet=議題1 --meet=議題2`  … Cursor打合せの議題を Pro に渡して協力判断
 *   `--note=事実メモ`  … DB数字など（推測と分けて渡す）
 *   `--fresh`  … 本番で束を作り直す（既定は最新束を読むだけ）
 *                 ⚠ 本番 fresh=1 は shots.learned の x/y が落ちる実測あり。
 *                 打合せのたびにやると弱い強化の成果が消える。必要な時だけ。
 *
 * ⚠ 統括の生の言葉をそのまま出す。私の解釈は「私の要約」と明示する。
 * ⚠ verdict / self_check / learning_tasks.kind は Pro が変えない。
 */
import { enrichSupervisorWithPro } from "../app/lib/learn-supervisor-pro";
import type { SupervisorAdvice } from "../app/lib/learn-supervisor";

const BASE = process.env.AUDIT_BASE || "https://sumora-ai-ui.vercel.app";
const args = process.argv.slice(2);
const scope = (args.find((a) => a.startsWith("--scope=")) || "").replace("--scope=", "") || "all";
const doSave = args.includes("--save");
const forceFresh = args.includes("--fresh");
const meet = args.filter((a) => a.startsWith("--meet=")).map((a) => a.replace("--meet=", "").trim()).filter(Boolean);
const notes = args.filter((a) => a.startsWith("--note=")).map((a) => a.replace("--note=", "").trim()).filter(Boolean);

function line(s = "") { console.log(s); }
function hr() { console.log("─".repeat(66)); }

void (async () => {
  hr();
  line(`【統括Pro】scope=${scope}  save=${doSave ? "yes" : "no"}  meet=${meet.length}  fresh=${forceFresh ? "yes" : "no"}`);
  if (meet.length) {
    line("■ 打合せ議題（Cursor→Pro）");
    for (const m of meet) line("  ・" + m);
  }
  if (notes.length) {
    line("■ 事実メモ");
    for (const n of notes) line("  ・" + n);
  }
  if (forceFresh) {
    line("⚠ --fresh: 本番で束を作り直す（shots.learned の位置が落ちる実測あり）");
  }
  hr();

  // ★ 既定は最新束を読むだけ。打合せのたびに fresh=1 すると弱い強化の画面位置が消える（実測: 96欄→0）
  const q = forceFresh ? "fresh=1&" : "";
  const url = `${BASE}/api/human-learn-profile?${q}scope=${encodeURIComponent(scope)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    line(`束を取れませんでした: http_${r.status}`);
    process.exitCode = 1;
    return;
  }
  const j = (await r.json()) as Record<string, unknown>;
  const bundle = (j.bundle ?? null) as Record<string, unknown> | null;
  if (!bundle) {
    line("束がありません");
    process.exitCode = 1;
    return;
  }

  let adv: SupervisorAdvice | null = null;
  if (scope === "all") {
    adv = (bundle.supervisor as SupervisorAdvice) || null;
  } else {
    const by = (bundle.supervisor_by_site ?? {}) as Record<string, SupervisorAdvice>;
    adv = by[scope] || null;
  }
  if (!adv) {
    line("統括の判断がまだありません");
    process.exitCode = 1;
    return;
  }

  // 本番束に既に Pro が入っていても、手元で**もう一度** Pro を回す（細かい強化の確認用）
  const beforeEv = (adv.meeting?.evidence || []).filter((e) =>
    /統括Pro|足りない土台|土台を作る次手|役割分担/.test(String(e.label || "")),
  );
  line();
  line("■ 束に既にある Pro 根拠（本番）");
  if (!beforeEv.length) line("  （なし → 本番がまだ Pro 未適用、または古いデプロイ）");
  else for (const e of beforeEv) line(`  ・${e.label}: ${e.value}`);

  line();
  line("■ Pro に聞く（手元）…");
  const got = await enrichSupervisorWithPro(
    adv,
    process.env,
    (meet.length || notes.length) ? { meet, notes } : null,
  );
  line(`  usedPro=${got.usedPro}  model=${got.model ?? "-"}  why=${got.why ?? "ok"}`);

  const m = got.advice.meeting || { today: [], agenda: [], evidence: [], questions: [] };
  line();
  line("■ 統括Pro RAG・把握（設計知見の引き）");
  {
    const rag = (m.evidence || []).find((e) => String(e.label) === "統括Pro RAG");
    const grasp = (m.evidence || []).find((e) => String(e.label) === "統括Pro把握");
    const arrange = (m.evidence || []).find((e) => String(e.label) === "統括Pro手配");
    if (rag) line("  RAG: " + rag.value);
    else line("  （RAG根拠なし → 配線前のデプロイ／引き失敗）");
    if (grasp) line("  把握: " + grasp.value);
    else line("  （把握行なし → 要旨が残っていない）");
    if (arrange) line("  手配: " + arrange.value);
  }
  line();
  line("■ 画像学習→統括Pro連携");
  {
    const vision = (m.evidence || []).find((e) => String(e.label) === "画像学習→統括Pro連携");
    const vpl = (got.advice.meeting as { vision_pro_link?: { line?: string; bottleneck?: string | null } } | undefined)?.vision_pro_link;
    if (vision) line("  " + vision.value);
    else if (vpl?.line) line("  " + vpl.line);
    else line("  （連携行なし・本番が古い可能性）");
    if (vpl?.bottleneck) line("  止: " + vpl.bottleneck);
  }

  line();
  line("■ 統括Proの生の言葉");
  line("  【今日】");
  for (const t of (m.today || []).slice(0, 5)) line("    " + t);
  const gaps = (m.evidence || []).find((e) => String(e.label).includes("足りない土台"));
  const build = (m.evidence || []).find((e) => String(e.label).includes("土台を作る次手"));
  const sum = (m.evidence || []).find((e) => String(e.label).includes("統括Proまとめ"));
  if (sum) line("  【まとめ】" + sum.value);
  if (gaps) line("  【足りない土台】" + gaps.value);
  if (build) line("  【土台を作る次手】" + build.value);
  line("  【議題（先頭）】");
  for (const a of (m.agenda || []).slice(0, 4)) {
    line(`    ・${a.topic}`);
    line(`      why: ${a.why}`);
    line(`      decide: ${a.decide}`);
  }

  line();
  line("■ 関所（Proは変えない）");
  line(`  verdict=${got.advice.verdict}  coverage=${got.advice.score?.coverage ?? "-"}  weak=${got.advice.score?.weak ?? "-"}`);
  line(`  self_check.ok=${got.advice.self_check?.ok}  block=${got.advice.block ?? "なし"}`);

  if (doSave && got.usedPro) {
    const { saveSupervisorLog } = await import("../app/lib/learn-supervisor-db");
    const src = (bundle.source ?? {}) as Record<string, unknown>;
    const res = await saveSupervisorLog(scope, got.advice, {
      next_n: Object.keys((bundle.next as object) || {}).length,
      points_n: Object.keys((bundle.points as object) || {}).length,
      opens_n: Object.keys((bundle.opens as object) || {}).length,
      screens_n: Object.keys((bundle.screen_flow as object) || {}).length,
      sequence_n: Array.isArray((bundle.sequence_flow as { sequence?: unknown[] } | undefined)?.sequence)
        ? ((bundle.sequence_flow as { sequence: unknown[] }).sequence.length)
        : 0,
      with_ops: Number(src.with_ops) || 0,
      guessed_opens: 0,
      rows: Number(src.rows) || 0,
      bundle_at: String(bundle.generated_at || ""),
    });
    line();
    line(`■ 保存: ok=${res.ok}${res.error ? "  err=" + res.error : ""}${res.skipped ? "  skipped=" + res.skipped : ""}${res.updated ? "  updated=pro_on_same_bundle" : ""}`);
  } else if (doSave && !got.usedPro) {
    line();
    line("■ 保存スキップ（Pro未使用のため）");
  }

  line();
  line("私の要約: Pro が used=true なら統括の判断層が動いている。why が出たら鍵・上限・parse を直す。");
  hr();
})();
