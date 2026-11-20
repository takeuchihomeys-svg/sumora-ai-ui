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
 *   `--full-audit`  … 営業時間（JST 9〜22）でも土台を再点検する（既定は夜だけ・重い）
 *   ⚠ 始める前に DB の応答を見て、答えなければ止める（重ねて読まない）
 *
 * ⚠ 統括の生の言葉をそのまま出す。私の解釈は「私の要約」と明示する。
 * ⚠ verdict / self_check / learning_tasks.kind は Pro が変えない。
 */
import { enrichSupervisorWithPro, proMeetNotesFromBundle } from "../app/lib/learn-supervisor-pro";
import type { SupervisorAdvice } from "../app/lib/learn-supervisor";
import { renderOwnerAsks, type OwnerAsk } from "../app/lib/supervisor-owner-ask";

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

  /**
   * ★ 2026-11-20 竹内さん「データベースちゃんと連携できるように、なぜとまっているのか」:
   *   11-19 は DB が遅くなっている最中（19:40〜 読み1本に5分）にも統括Proを重ねて回し、最後は 522 で全体が止まった。
   *   → 始める前に DB が軽い問い（件数だけ・10秒）に答えるかを見る。答えなければ**重ねて読まずに止める**。
   */
  {
    const u = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    if (u && k) {
      const t0 = Date.now();
      let dbOk = false, dbWhy = "";
      try {
        const r0 = await fetch(`${u}/rest/v1/learn_supervisor_log?select=id&limit=1`, {
          headers: { apikey: k, Authorization: `Bearer ${k}` },
          signal: AbortSignal.timeout(10_000),
        });
        dbOk = r0.ok;
        dbWhy = `http_${r0.status}`;
      } catch (e) {
        dbWhy = e instanceof Error ? e.name : "err";
      }
      const ms = Date.now() - t0;
      if (!dbOk) {
        line(`■ DB が答えない（${dbWhy}・${ms}ms）→ 統括Proは止めます（重ねて読むと DB をさらに詰まらせる）`);
        process.exitCode = 1;
        return;
      }
      line(`■ DB 応答 ${ms}ms${ms > 3000 ? "（遅い・重い点検は控える）" : ""}`);
    }
  }
  const jstH = (new Date().getUTCHours() + 9) % 24;
  const daytime = jstH >= 9 && jstH < 22;
  const fullAudit = args.includes("--full-audit");

  // ★ 既定は最新束を読む（bundle付き）。touch=0 は light のみで束が無いので使わない。
  //   打合せのたびに fresh=1 すると弱い強化の画面位置が消える（実測: 96欄→0）
  // ★ 2026-11-20 竹内さん「反映の流れ」: API は touch の既定（読む）で read_count を +1 する。
  //   統括の読み込みがそれを増やすと、拡張が読んだ数と混ざる（10:42 の統括 1回で read が 0→1）。
  //   → 通常は DB の最新1行を直接読む（読むだけ・印は付かない）。fresh=1（作り直し）の時だけ API。
  let j: Record<string, unknown> | null = null;
  let via = "";
  if (!forceFresh) {
    const u = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    if (u && k) {
      try {
        const rr = await fetch(
          `${u}/rest/v1/human_learn_profile?select=bundle,created_at&scope=eq.${encodeURIComponent(scope)}&order=created_at.desc&limit=1`,
          { headers: { apikey: k, Authorization: `Bearer ${k}` }, cache: "no-store", signal: AbortSignal.timeout(20_000) },
        );
        if (rr.ok) {
          const rows = (await rr.json()) as Array<{ bundle?: unknown }>;
          if (rows[0]?.bundle) { j = { bundle: rows[0].bundle }; via = "DBの最新1行（読んだ印は付けない）"; }
        }
      } catch { /* API へ戻す */ }
    }
  }
  if (!j) {
    const q = forceFresh ? "fresh=1&" : "";
    const url = `${BASE}/api/human-learn-profile?${q}scope=${encodeURIComponent(scope)}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      line(`束を取れませんでした: http_${r.status}`);
      process.exitCode = 1;
      return;
    }
    j = (await r.json()) as Record<string, unknown>;
    via = forceFresh ? "API（fresh＝作り直し）" : "API（読んだ印が付く・DB が読めなかった時だけ）";
  }
  line(`■ 束の読み方: ${via}`);
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

  // ★ 2026-11-18: 束内 FA は solid 復元後も古いまま残り得る（missing_n>0 だと再点検をスキップしていた）
  //   → 手元では必ず再点検し、F1 solid=96 なのに「0欄」と誤報しない
  let bundleForPro = bundle as Record<string, unknown>;
  // 営業時間（JST 9〜22）は土台の再点検（shot_ops を数千行ずつ何本も読む）をしない。束の foundation_audit を使う。`--full-audit` で強制
  if (daytime && !fullAudit) {
    line("■ 土台点検（再）: 営業時間なので回さない（束の土台点検を使う・夜か --full-audit で再点検）");
  } else try {
    const { createClient } = await import("@supabase/supabase-js");
    const { auditLearnFoundations, refreshFoundationEvidence } = await import("../app/lib/learn-foundation-audit");
    const { countLearnedSolid } = await import("../app/lib/learn-bundle-preserve");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    if (url && key) {
      const fa = await auditLearnFoundations(createClient(url, key), {
        site: scope === "itandi" ? "itandi" : scope === "realpro" ? "realpro" : "all",
      });
      const solidBundle = countLearnedSolid(bundleForPro).solid;
      bundleForPro = { ...bundleForPro, foundation_audit: fa };
      if (adv.meeting?.evidence) {
        const siteTag = scope === "all" ? "" : `［${scope}］`;
        adv = { ...adv, meeting: { ...adv.meeting, evidence: refreshFoundationEvidence(adv.meeting.evidence, fa, siteTag) } };
      }
      line(`■ 土台点検（再）: ✓${fa.ok_n}／欠${fa.missing_n}／F1solid=${fa.screen_solid} 束solid=${solidBundle}（統括根拠の土台行も置き換え）`);
      line(`  ${fa.summary.slice(0, 100)}`);
    }
  } catch (e) {
    line(`■ 土台点検スキップ: ${e instanceof Error ? e.message.slice(0, 80) : "err"}`);
  }

  // ★ 2026-11-19: 本番の束に shot_gaps が無いと、学べ済みを 0 と数えて「flash未実行」と誤判定する。
  //   束に無い時だけ DB の件数で補う（束の作りと同じ期間 materialsMs）。
  try {
    const hasGaps = (v: unknown) => !!v && typeof v === "object" && Number((v as { total?: unknown }).total) > 0;
    if (!hasGaps(bundleForPro.shot_gaps_normal) || !hasGaps(bundleForPro.shot_gaps)) {
      const { createClient } = await import("@supabase/supabase-js");
      const { shotGapsFromDb } = await import("../app/lib/shot-gaps-db");
      const { LEARN_PERIODS } = await import("../app/lib/learn-periods");
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
      if (url && key) {
        const sinceIso = new Date(Date.now() - LEARN_PERIODS.materialsMs).toISOString();
        const g = await shotGapsFromDb(createClient(url, key), { site: scope, sinceIso });
        bundleForPro = {
          ...bundleForPro,
          ...(!hasGaps(bundleForPro.shot_gaps) && g.shot_gaps ? { shot_gaps: g.shot_gaps } : {}),
          ...(!hasGaps(bundleForPro.shot_gaps_normal) && g.shot_gaps_normal ? { shot_gaps_normal: g.shot_gaps_normal } : {}),
        };
        const n = g.shot_gaps_normal;
        line(`■ 写真の学べ済み（束に無いので DB で数えた・通常）: ${n ? `写真${n.total}枚・学べた${n.learnedOk}・欄0が${n.learnedButEmpty}・未学習(大)${n.unlearnedBig}・(小)${n.unlearnedSmall}` : "写真なし"}`);
      }
    }
  } catch (e) {
    line(`■ 写真の学べ済みを数えられない: ${e instanceof Error ? e.message.slice(0, 80) : "err"}`);
  }

  // ★ 2026-11-20 竹内さん「反映の流れ」（差分を見せて承認済み）:
  //   束に写された反映（bundle_reflect.read_count）は**作った時点の値で固定**される。その値は「前の束」の読まれ数。
  //   統括が見るべきは DB の最新行（判断する束）の今の値。→ 今の値を bundle_reflect に入れ、作った時点の値は built_read_count に残す。
  let liveReflectNote: string | null = null;
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { fetchBundleReflectHint } = await import("../app/lib/bundle-reflect");
    const u = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
    if (u && k) {
      const live = await fetchBundleReflectHint(createClient(u, k), { scope });
      const built = (bundleForPro.bundle_reflect ?? {}) as Record<string, unknown>;
      const frozen = built.read_count;
      bundleForPro = {
        ...bundleForPro,
        bundle_reflect: {
          ...built,
          built_read_count: frozen ?? null,
          prev_read_count: frozen ?? null,
          judged_read_count: live.read_count,
          read_count: live.read_count,
          read_at: live.read_at,
          auto_after: live.auto_after,
          source: "live",
        },
      };
      liveReflectNote = `反映の今（DBの最新行・判断する束）: 拡張が読んだ ${live.read_count}回${live.read_at ? `（${String(live.read_at).slice(0, 16)}）` : ""}・新束のあと自動=${live.auto_after ? "あり" : "なし"}／作った時点の値（前の束の読まれ数）は read=${frozen ?? "無"}（古い。今の判断には使わない）`;
      line(`■ ${liveReflectNote}`);
    }
  } catch (e) {
    line(`■ 反映の今を読めない: ${e instanceof Error ? e.message.slice(0, 80) : "err"}`);
  }
  // 反映の今を入れた後の束から、束からの事実メモを作る（古い値を混ぜない）
  const autoNotes = proMeetNotesFromBundle(bundleForPro);
  // ★ 2026-11-19: 既に竹内さんへ出して未回答の問いは Pro に渡す（同じ事を聞き直さない・答えが来るまで該当の作業は保留）
  const openAskNotes: string[] = [];
  try {
    const { createClient } = await import("@supabase/supabase-js");
    const { fetchOpenSupervisorAsks } = await import("../app/lib/supervisor-owner-ask-server");
    const u = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
    const k = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
    if (u && k) {
      const open = await fetchOpenSupervisorAsks(createClient(u, k));
      for (const o of open) openAskNotes.push(`確認待ち（竹内さんへ出して未回答・聞き直さない・この作業は保留）: ${o.question.slice(0, 120)}／オススメ=${o.recommended ?? "なし"}`);
    }
  } catch { /* 台帳が読めなくても判断は続ける */ }
  // ★ 2026-11-20 竹内さん「手順書の重要度と優先度あげる」「改善したら手順書が改善されるように」:
  //   手順書の反映（コードの決まり × DB の手順書 × 自動が読んだ印 × 決まりを守れたか）を Pro の材料の**先頭**に置く。
  let playbookNote: string | null = null;
  try {
    const { fetchPlaybookReflect, playbookReflectNote } = await import("../app/lib/playbook-reflect-server");
    const rep = await fetchPlaybookReflect(process.env, { scope: scope === "itandi" ? "itandi" : "realpro", runs: 8 });
    playbookNote = playbookReflectNote(rep);
    line(`■ ${playbookNote}`);
  } catch (e) {
    line(`■ 手順書の反映を読めない: ${e instanceof Error ? e.message.slice(0, 80) : "err"}`);
  }
  const allNotes = [...(playbookNote ? [playbookNote] : []), ...autoNotes, ...(liveReflectNote ? [liveReflectNote] : []), ...openAskNotes, ...notes];
  if (autoNotes.length) {
    line();
    line("■ 束からの事実メモ（--note 無しでも Pro に渡す）");
    for (const n of autoNotes) line("  ・" + n);
  }

  line();
  line("■ Pro に聞く（手元）…");
  const got = await enrichSupervisorWithPro(
    adv,
    process.env,
    { meet, notes: allNotes.length ? allNotes : undefined, bundle: bundleForPro },
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

  // ★ 2026-11-19 竹内さん「迷ったら俺に推奨で確認とるかたちで」: Pro の迷い＋決定論の関所を、推奨つきで竹内さんに出す
  {
    const asks = ((got.advice.meeting as { owner_asks?: OwnerAsk[] } | undefined)?.owner_asks) || [];
    const ev = (m.evidence || []).find((e) => String(e.label) === "統括Pro確信（迷い）");
    line();
    line("■ 統括Proの確信・竹内さんへの確認（迷い・推奨つき）");
    if (ev) line("  " + ev.value);
    let ids: Array<string | null> = asks.map(() => null);
    if (asks.length && doSave && got.usedPro) {
      try {
        const { createClient } = await import("@supabase/supabase-js");
        const { saveOwnerAsks } = await import("../app/lib/supervisor-owner-ask-server");
        const res = await saveOwnerAsks(createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || "", process.env.SUPABASE_SERVICE_ROLE_KEY || ""), scope, asks);
        ids = asks.map((a) => res.saved.find((s) => s.ask === a)?.id ?? res.skipped.find((s) => s.ask === a)?.id ?? null);
        line(`  台帳 owner_questions: 追加${res.saved.length}件／既にある${res.skipped.length}件${res.errors.length ? "／失敗: " + res.errors.join("・") : ""}`);
      } catch (e) {
        line(`  台帳へ入れられない: ${e instanceof Error ? e.message.slice(0, 80) : "err"}`);
      }
    }
    for (const l of renderOwnerAsks(asks, ids)) line(l);
  }

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
