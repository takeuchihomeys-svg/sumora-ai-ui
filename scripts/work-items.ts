// scripts/work-items.ts — 仕事の台帳（work_items・仕事1件＝1行で今の段）を見る・足す・段を進める（作業員M・2026-11-18）
//   竹内さん 11/18「その作業を全部把握するために必要な事は保管するようにデータベースを強化する」（統括役の頼み）。
//   work_log は経過を書き足す日誌、work_items は「何が終わっていないか」を1行で持つ台帳。段の変わりは work_item_events に1行ずつ。
//   段: todo → building → built_off → testing → passed → on → done（ほかに blocked・waiting_owner・dropped）
//   使い方（鍵のある .env で）:
//     --list [--stage=built_off] [--area=2通] [--owner=作業員M]      段ごとの残りの件数と上位
//     --add --title=... [--area= --origin= --stage= --owner= --switch= --switch-default= --priority= --quote= --next= --work-log-task= --kb=a,b]
//     --stage=<id> <新しい段> [--note=...] [--actor=作業員M] [--exam=<label> --result=<要約>] [--commit=<hash>]
//     --done-check                                                  見張り（on なのに READY の印が無い・built_off のまま7日・testing のまま3日・passed のまま3日）
//     --import=<json> [--dry]                                        scripts/unfinished-inventory.ts --json-out の行を一括で（switch_name か work_log_task が同じ行は更新）
//     --forecast=<id> --metric= --low= --high= ／ --map ／ --forecast-check ／ --forecast-cause ／ --no-forecast  見込み・数ごとの地図（台帳 #610・下の cmdForecast の上に説明）
//   お客様の文・名前は入れない。費用 0（LLM なし）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "node:fs";

export const STAGES = ["todo", "building", "built_off", "testing", "passed", "on", "done", "blocked", "waiting_owner", "dropped"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_JA: Record<Stage, string> = {
  todo: "まだ", building: "作っている", built_off: "作った（off）", testing: "試験中", passed: "悪化0", on: "既定 on", done: "本番 READY",
  blocked: "止まっている", waiting_owner: "竹内さん待ち", dropped: "やめた",
};
const ORDER: Stage[] = ["todo", "building", "built_off", "testing", "passed", "on"];
export const isStage = (s: string): s is Stage => (STAGES as readonly string[]).includes(s);
/** 段の進み方の確かめ（純関数）: 前に戻る・飛ばすのは note が要る（戻った・止まった理由を残す） */
export function stageMoveNeedsNote(from: string | null, to: Stage): boolean {
  if (!from || !isStage(from)) return false;
  if (to === "blocked" || to === "dropped" || to === "waiting_owner") return true;
  const a = ORDER.indexOf(from as Stage), b = ORDER.indexOf(to);
  if (a < 0 || b < 0) return false;
  return b < a || b > a + 2;
}
/** 見張り（純関数）: 段と日付から気づく事 */
export function doneCheckOf(r: { id: number; title: string; stage: string; updated_at: string; commits?: string[] | null; next_step?: string | null }, nowMs = Date.now()): string | null {
  const days = (nowMs - Date.parse(r.updated_at)) / 86_400_000;
  if (r.stage === "on" && !(r.commits ?? []).length) return "既定 on なのにコミットの記録が無い（本番 READY を確かめて done に）";
  if (r.stage === "on" && days >= 2) return `既定 on のまま ${Math.floor(days)}日（本番 READY を確かめて done に）`;
  if (r.stage === "built_off" && days >= 7) return `作った（off）のまま ${Math.floor(days)}日（試験を積む・要らなければ dropped の案）`;
  if (r.stage === "testing" && days >= 3) return `試験中のまま ${Math.floor(days)}日（試験の結果を読む）`;
  if (r.stage === "passed" && days >= 3) return `悪化0 のまま ${Math.floor(days)}日（既定 on のコミット）`;
  if (r.stage === "building" && days >= 10) return `作っているまま ${Math.floor(days)}日（持ち主が居るか）`;
  return null;
}

const argv = process.argv.slice(2);
const arg = (k: string, d = "") => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const flag = (k: string) => argv.includes(`--${k}`);
const sb = (): SupabaseClient => createClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", process.env.SUPABASE_SERVICE_ROLE_KEY ?? "");
const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

async function cmdList() {
  let q = sb().from("work_items").select("id,title,area,stage,owner,priority,switch_name,next_step,updated_at").order("priority", { ascending: true, nullsFirst: false }).limit(2000);
  if (arg("stage")) q = q.eq("stage", arg("stage"));
  if (arg("area")) q = q.eq("area", arg("area"));
  if (arg("owner")) q = q.eq("owner", arg("owner"));
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.stage, (by.get(r.stage) ?? 0) + 1);
  console.log(`仕事の台帳 ${rows.length}行: ${STAGES.filter((s) => by.get(s)).map((s) => `${STAGE_JA[s]} ${by.get(s)}`).join("・")}`);
  const left = rows.filter((r) => !["done", "dropped"].includes(r.stage));
  console.log(`残り ${left.length}（done・dropped を除く）`);
  for (const r of left.slice(0, Number(arg("top", "30")) || 30)) console.log(`- #${r.id} [${STAGE_JA[r.stage as Stage] ?? r.stage}] p${r.priority ?? "-"} ${r.area ?? ""} ${r.owner ?? ""}: ${String(r.title).slice(0, 80)}${r.next_step ? ` → ${String(r.next_step).slice(0, 60)}` : ""}`);
}

async function cmdAdd() {
  const title = arg("title");
  if (!title) throw new Error("--title= が要る");
  const stage = arg("stage", "todo");
  if (!isStage(stage)) throw new Error(`段が違う: ${stage}`);
  const row = {
    title, area: arg("area") || null, origin: arg("origin") || null, stage, owner: arg("owner") || null, switch_name: arg("switch") || null, switch_default: arg("switch-default") || null,
    priority: arg("priority") ? Number(arg("priority")) : null, requested_quote: arg("quote") || null, requested_at: arg("requested-at") || new Date().toISOString(),
    next_step: arg("next") || null, work_log_task: arg("work-log-task") || null, kb_ids: list(arg("kb")), quality_target: arg("quality") || null,
  };
  if (flag("dry")) { console.log(JSON.stringify(row)); return; }
  const { data, error } = await sb().from("work_items").insert(row).select("id").single();
  if (error) throw new Error(error.message);
  await sb().from("work_item_events").insert({ item_id: data.id, from_stage: null, to_stage: stage, actor: arg("actor", "session"), note: arg("note") || "足した" });
  console.log(`足した #${data.id}`);
  // 2026-11-21 作業員N（竹内さん「次の朝ではなく、そのまま連携することはできないのか」・台帳 #472 #473）: 竹内さんの指示を入れた時は、その場で
  //   指摘の帳面（owner_pointers）に1行足し、その型の点検（owner-feedback-check --from）と自己改善の統括の方針（self-improve --only=policy）を1回流す。
  //   止める: --no-pointer（点検だけ止めるのは --no-check）。どちらも LLM なし・軽い読み
  if (row.origin === "owner_request" && !flag("no-pointer")) {
    try {
      const { addPointerForWorkItem } = await import("../app/lib/owner-pointers-server");
      const pid = await addPointerForWorkItem(sb(), data.id);
      console.log(pid ? `指摘の帳面に足した P${pid}` : "指摘の帳面には足せなかった");
      if (pid && !flag("no-check")) {
        const { runTsx } = await import("./lib/self-improve-growth");
        for (const args of [["scripts/owner-feedback-check.ts", `--from=${pid}`, "--days=1", "--write"], ["scripts/self-improve.ts", "--only=policy", "--write"]]) {
          try { console.log(runTsx(args, 240_000).split("\n").slice(0, 12).join("\n")); } catch (e) { console.log(`流せなかった（${args[0]}）: ${e instanceof Error ? e.message.slice(0, 120) : e}`); }
        }
      }
    } catch (e) { console.log(`指摘の帳面の口で止まった: ${e instanceof Error ? e.message : e}`); }
  }
}

async function cmdStage() {
  const id = Number(arg("stage"));
  const to = argv.find((a) => !a.startsWith("--")) ?? "";
  if (!id || !isStage(to)) throw new Error("--stage=<id> <新しい段>（段: " + STAGES.join("/") + "）");
  const db = sb();
  const { data: cur, error } = await db.from("work_items").select("id,stage,commits,exam_labels").eq("id", id).single();
  if (error || !cur) throw new Error(error?.message ?? "無い");
  const note = arg("note");
  if (stageMoveNeedsNote(cur.stage, to) && !note) throw new Error(`段が戻る・飛ぶ・止まる時は --note= に理由を書く（${cur.stage} → ${to}）`);
  const patch: Record<string, unknown> = { stage: to, updated_at: new Date().toISOString() };
  if (to === "done") patch.done_at = new Date().toISOString();
  if (arg("exam")) patch.exam_labels = [...new Set([...(cur.exam_labels ?? []), arg("exam")])];
  if (arg("result")) patch.exam_result = arg("result");
  if (arg("commit")) patch.commits = [...new Set([...(cur.commits ?? []), arg("commit")])];
  if (arg("next")) patch.next_step = arg("next");
  if (arg("blocker")) patch.blocker = arg("blocker");
  if (flag("dry")) { console.log(JSON.stringify({ id, from: cur.stage, ...patch, note })); return; }
  const { error: e2 } = await db.from("work_items").update(patch).eq("id", id);
  if (e2) throw new Error(e2.message);
  await db.from("work_item_events").insert({ item_id: id, from_stage: cur.stage, to_stage: to, actor: arg("actor", "session"), note: note || null });
  console.log(`#${id}: ${cur.stage} → ${to}`);
}

async function cmdDoneCheck() {
  const { data, error } = await sb().from("work_items").select("id,title,stage,updated_at,commits,next_step").not("stage", "in", "(done,dropped)").limit(3000);
  if (error) throw new Error(error.message);
  let n = 0;
  for (const r of data ?? []) { const w = doneCheckOf(r); if (w) { n++; console.log(`- #${r.id} [${r.stage}] ${String(r.title).slice(0, 70)}: ${w}`); } }
  console.log(`見張り: ${n}件`);
}

async function cmdImport() {
  // 2026-11-18 統括役: 片割れのサロゲート（絵文字を UTF-16 の単位で切った物）で「Empty or invalid json」になり 111行で止まった → 入れる前に落とす
  const wf = (v: unknown): unknown => (typeof v === "string" ? v.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "") : Array.isArray(v) ? v.map(wf) : v);
  const rows = (JSON.parse(readFileSync(arg("import"), "utf8")) as Array<Record<string, unknown>>).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, wf(v)])));
  const dry = flag("dry");
  const db = dry ? (null as unknown as SupabaseClient) : sb();
  const keyOf = (r: Record<string, unknown>) => (r.switch_name ? `sw:${r.switch_name}` : r.work_log_task ? `wl:${r.work_log_task}` : `t:${r.title}`);
  // 今ある行（同じ鍵は更新）
  const have = new Map<string, { id: number; stage: string }>();
  if (!dry) {
    const { data, error } = await db.from("work_items").select("id,stage,switch_name,work_log_task,title").limit(5000);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) have.set(keyOf(r as Record<string, unknown>), { id: r.id, stage: r.stage });
  }
  let ins = 0, upd = 0;
  const byStage = new Map<string, number>();
  for (const r of rows) {
    if (!isStage(String(r.stage))) throw new Error(`段が違う: ${r.stage}（${r.title}）`);
    byStage.set(String(r.stage), (byStage.get(String(r.stage)) ?? 0) + 1);
    if (dry) continue;
    const h = have.get(keyOf(r));
    if (h) {
      // 段は人が進めた物を上書きしない（台帳の段が棚卸しより進んでいる時は残す）
      const { stage: _s, owner: _o, ...rest } = r; void _o; // 段と持ち主は人が決めた物を上書きしない（11/18 統括役の割り振りで書き換えた owner を残す）
      void _s;
      const { error } = await db.from("work_items").update({ ...rest, updated_at: new Date().toISOString() }).eq("id", h.id);
      if (error) throw new Error(error.message);
      upd++;
    } else {
      const { data, error } = await db.from("work_items").insert(r).select("id").single();
      if (error) throw new Error(`${error.message}（${r.title}）`);
      await db.from("work_item_events").insert({ item_id: data.id, from_stage: null, to_stage: r.stage, actor: arg("actor", "作業員M"), note: "棚卸し 11/18 から入れた" });
      ins++;
    }
  }
  console.log(`${dry ? "（見るだけ）" : ""}${rows.length}行: ${[...byStage].map(([s, n]) => `${STAGE_JA[s as Stage] ?? s} ${n}`).join("・")}${dry ? "" : `・足した ${ins}・更新 ${upd}`}`);
  if (dry) for (const r of rows.slice(0, Number(arg("top", "10")) || 10)) console.log(`  p${r.priority} [${r.stage}] ${r.area} ${r.owner ?? ""}: ${String(r.title).slice(0, 80)}`);
}

// ── 見込み（2026-11-23 作業員P・台帳 #610・竹内さん「この予測と今の部分と次の部分を把握するように連携するように」）──
//   --forecast=<id> --metric=<quality_daily の metric> --low= --high= [--before= --before-n= --basis= --leaf=<地図の葉の鍵> --writer=style|device|all --window=<日> --start-at=<本番に入った時>]
//   --map [--metric=<根>] [--top=8] [--live]     数ごとの地図（今の値・動かす作業・見込み・次の一手の順位・穴・止まり）。--live は木を今作る（重い読み・夜だけ）
//   --forecast-check [--write]                   本番に入って 7日・14日経った作業の実測と見込みの突き合わせ（自己改善の芯も毎日回す）
//   --forecast-cause=<id> <material|misread|aix_turn_as_reply|counting> --note=...   外れの原因を4つのどれかに記録
//   --no-forecast                                 見込みの無い P0/P1 の作業
async function cmdForecast() {
  const id = Number(arg("forecast"));
  const metric = arg("metric");
  if (!id || !metric) throw new Error("--forecast=<id> --metric=<quality_daily の metric> --low= --high= が要る");
  const { rootOf } = await import("../app/lib/metric-map");
  const def = rootOf(metric);
  const n = (k: string) => (arg(k) === "" ? null : Number(arg(k)));
  const patch: Record<string, unknown> = {
    forecast_metric: metric, forecast_low: n("low"), forecast_high: n("high"), forecast_before: n("before"), forecast_before_n: n("before-n"), forecast_basis: arg("basis") || null,
    forecast_leaf: arg("leaf") || metric, forecast_writer_select: arg("writer") || def?.writerSelect || "style", forecast_window_days: n("window") ?? def?.windowDays ?? null,
    forecast_at: new Date().toISOString(), forecast_verdict: "pending", updated_at: new Date().toISOString(),
  };
  if (arg("start-at")) patch.forecast_start_at = arg("start-at");
  if (patch.forecast_low != null && patch.forecast_high != null && Number(patch.forecast_low) > Number(patch.forecast_high)) throw new Error("--low は --high 以下");
  if (!def) console.log(`注意: ${metric} は地図の根の表（app/lib/metric-map.ts MAP_ROOTS）に無い＝数え方の出所を basis に書く`);
  if (flag("dry")) { console.log(JSON.stringify({ id, ...patch })); return; }
  const db = sb();
  const { error } = await db.from("work_items").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
  await db.from("work_item_events").insert({ item_id: id, kind: "note", actor: arg("actor", "session"), note: `見込み: ${metric} ${patch.forecast_before ?? "—"} → ${patch.forecast_low}〜${patch.forecast_high}（${patch.forecast_writer_select}）` });
  console.log(`#${id}: 見込みを付けた（${metric}・${patch.forecast_before ?? "—"} → ${patch.forecast_low}〜${patch.forecast_high}・葉 ${patch.forecast_leaf}）`);
}

async function cmdMap() {
  const m = await import("./lib/metric-map-server");
  const { MAP_CAUSE_JA } = await import("../app/lib/metric-map");
  const db = sb();
  if (flag("write")) {
    // 毎朝の芯 ⑤ と同じ物を今流す（夜だけ木を作る・metric_map_nodes と quality_daily の map:* / forecast:* を書く）
    const r = await m.mapDaily(db, { write: true, night: m.isNightJst() });
    for (const l of r.lines) console.log(l);
    for (const f of r.fix) console.log(`要確認: ${f}`);
    if (r.qd.length) { const { error } = await db.from("quality_daily").upsert(r.qd.map((x) => ({ ...x, source: "scripts/work-items.ts --map --write（#610）" })), { onConflict: "day,metric,scope" }); if (error) throw new Error(error.message); }
    console.log(`書いた: quality_daily ${r.qd.length}行`);
    return;
  }
  const top = Number(arg("top", "8")) || 8;
  const items = await m.loadForecastItems(db);
  const { itemsForRoot } = await import("../app/lib/metric-map");
  const roots = m.rootsInOrder().filter((r) => !arg("metric") || r.metric === arg("metric"));
  for (const def of roots) {
    const its = def.dims.length ? itemsForRoot(items, def) : items.filter((it) => it.forecast_metric === def.metric || (it.forecast_leaf ?? "").split("/")[0] === def.metric);
    if (def.prefix) {
      const qs = await m.latestQdPrefix(db, def.metric, def.qdScope);
      console.log(`\n■ ${def.label}（${def.metric}* の束・scope ${def.qdScope}・出所 ${def.source}）`);
      for (const q of qs) console.log(`   - ${q.metric}: ${q.value ?? "—"}（n ${q.n ?? "—"}・${q.day}）`);
      if (!qs.length) console.log("   数がまだ無い（入り始めは持ち主のコミットが main に入ってから）");
      continue;
    }
    const q = await m.latestQd(db, def.metric, def.qdScope);
    console.log(`\n■ ${def.label}${def.primary ? "【主】" : def.compare ? `【並べて見る・主は ${def.compare}】` : ""}`);
    console.log(`  数の名前 ${def.metric}・書き手の選び方 ${def.writerSelect}・窓 ${def.windowDays}日・出所 ${def.source}・持ち主 ${def.owner}`);
    console.log(`  今の値（quality_daily の最新）: ${q ? `${q.value ?? "—"}（n ${q.n ?? "—"}・${q.day}）` : "まだ書かれていない"}`);
    console.log(`  動かす作業 ${its.length}:`);
    for (const it of its) console.log(`   - #${it.id} [${STAGE_JA[it.stage as Stage] ?? it.stage}] ${it.switch_name ?? ""} ${String(it.title).slice(0, 50)}｜見込み ${it.forecast_before ?? "—"} → ${it.forecast_low ?? "—"}〜${it.forecast_high ?? "—"}${it.forecast_leaf && it.forecast_leaf !== def.metric ? `｜葉 ${it.forecast_leaf.split("/").slice(1).join(" › ")}` : ""}${it.forecast_verdict && it.forecast_verdict !== "pending" ? `｜突き合わせ ${it.forecast_verdict}` : ""}${it.forecast_gap_cause ? `（${MAP_CAUSE_JA[it.forecast_gap_cause as keyof typeof MAP_CAUSE_JA]}）` : ""}${(it.forecast_exam as { phase?: string } | null)?.phase ? `［${(it.forecast_exam as { phase?: string }).phase}］` : ""}${it.blocker ? `｜止まり: ${it.blocker}` : ""}`);
    for (const it of its) for (const p of ((it.forecast_exam as { parts?: Array<{ leaf: string; fixes: number; switches?: string[]; exam?: { before_ok: number; after_ok: number; n: number; worse: number } }> } | null)?.parts ?? [])) console.log(`       部品 ${p.leaf.split("/").slice(1).join(" › ")}: 直る見込み ${p.fixes}番${p.switches?.length ? `（${p.switches.join("・")}）` : ""}${p.exam ? `・試験 ${p.exam.before_ok}→${p.exam.after_ok}/${p.exam.n}${p.exam.worse ? `・悪化 ${p.exam.worse}` : ""}` : "・試験まだ"}`);
    if (!def.builder) { console.log("  子の割り方: まだ（MAP_ROOTS に builder を足すと木になる）"); continue; }
    let nodes;
    let note: string;
    if (flag("live") && def.builder === "conductor_aix") {
      if (!m.isNightJst() && !flag("force")) throw new Error("--live は重い読み（60日）＝夜（JST 22〜9時）だけ。昼は前の木を読む（--live を外す）");
      const t = await m.buildRootTree(def); nodes = t?.nodes ?? []; note = "今作った";
    } else { const p = await m.readLatestTree(db, def.metric, def.writerSelect); nodes = m.nodesFromRows(p.rows); note = p.day ? `${p.day} に作った木` : "木がまだ無い（夜に self-improve か --live）"; }
    if (!nodes.length) { console.log(`  木: ${note}`); continue; }
    const examByLeaf = await m.examCountByLeaf(db, def.metric);
    const ranked = m.rankLeaves(nodes, its, { examByLeaf, writerSelect: def.writerSelect });
    const bad = m.sumMismatches(nodes);
    console.log(`  木（${note}）: 根 ${nodes[0].value}%（n ${nodes[0].n}・外れ ${nodes[0].misses}）・子の合計の食い違い ${bad.length}${bad.length ? `（${bad.slice(0, 3).map((b) => b.key).join("・")}）` : "（全部の親で子の合計が戻る）"}`);
    for (const x of nodes.filter((x) => x.depth === 1)) {
      console.log(`   ├ ${x.label}: ${x.value}%（n ${x.n}・外れ ${x.misses}）${examByLeaf.size ? `・試験の問題 ${[...examByLeaf].filter(([k]) => k === x.key || k.startsWith(`${x.key}/`)).reduce((s, [, c]) => s + c, 0)}` : ""}`);
      for (const y of nodes.filter((y) => y.parent === x.key && y.misses > 0).slice(0, 3)) console.log(`   │   └ ${y.label}: ${y.value}%（n ${y.n}・外れ ${y.misses}）`);
    }
    console.log(`  次の一手（伸びしろ＝外れ × 直る見込み ÷ 費用・n<5 は判断保留で 0.3倍・止まりは 0.5倍）:`);
    for (const r of ranked.slice(0, top)) console.log(`   ${m.leafLine(r)}`);
    const hs = m.holesOf(ranked, nodes).filter((h) => !h.hold);
    console.log(`  穴（作業も見込みも無い・外れ ${3} 以上）${hs.length}: ${hs.slice(0, 8).map((h) => `${h.key.split("/").slice(1).join(" › ")}（${h.misses}）`).join("・") || "なし"}`);
  }
}

// --map-build=<根> --json=<出所の台本の json> [--write]   出所の台本（夜の重い読み）の json から木を作る（端末の版＝作業員A の audit-aix-turn-judgment.ts・
//   申込までの地図＝作業員R の audit-route-progress-takeuchi.ts）。読むのは json と、端末の版の場面の見張りの scene_key（番の id で引く・軽い）だけ＝昼でも回せる
async function cmdMapBuild() {
  const m = await import("./lib/metric-map-server");
  const { itemsForRoot } = await import("../app/lib/metric-map");
  const def = m.MAP_ROOTS.find((r) => r.metric === arg("map-build"));
  if (!def || !(def.builder && m.JSON_SOURCES[def.builder])) throw new Error(`--map-build=<根>（json から作る根: ${m.MAP_ROOTS.filter((r) => r.builder && m.JSON_SOURCES[r.builder]).map((r) => r.metric).join("・")}）`);
  if (!arg("json")) throw new Error("--json=<出所の台本の json> が要る");
  const db = sb();
  const rows = JSON.parse(readFileSync(arg("json"), "utf8")) as unknown[];
  // 竹内さんの決定で正解を改めた番（作業員A の案）: 試験の問題（scripts/brain-exam/spec.json の why・tags）と会話・時刻 ±2分で突き合わせ、外れと別に数える
  const specPath = arg("spec", "scripts/brain-exam/spec.json");
  const spec = existsSync(specPath) ? (JSON.parse(readFileSync(specPath, "utf8")) as Array<{ id: string; conv?: string; at?: string; why?: string; tags?: unknown }>) : undefined;
  const t = await m.buildTreeFromJson(db, def, rows, { spec });
  if (!t || !t.nodes.length) throw new Error("木が作れない（行が無い）");
  const items = itemsForRoot(await m.loadForecastItems(db), def);
  const examByLeaf = await m.examCountByLeaf(db, def.metric);
  const ranked = m.rankLeaves(t.nodes, items, { examByLeaf, writerSelect: def.writerSelect });
  const bad = m.sumMismatches(t.nodes);
  console.log(`■ ${def.label}: 根 ${t.value}%（n ${t.n}・外れ ${t.nodes[0].misses}）・葉 ${m.leavesOf(t.nodes).length}・外れのある葉 ${ranked.length}・穴 ${m.holesOf(ranked, t.nodes).filter((h) => !h.hold).length}・判断保留 ${ranked.filter((r) => r.hold).length}・子の合計の食い違い ${bad.length}`);
  const decN = t.nodes.filter((x) => x.dim === "miss" && x.val === "decided").reduce((s, x) => s + x.n, 0);
  const minN = t.nodes.filter((x) => x.dim === "miss" && x.val === "minority").reduce((s, x) => s + x.n, 0);
  const timedN = t.nodes.filter((x) => x.dim === "miss" && x.val === "timed").reduce((s, x) => s + x.n, 0);
  const fixedN = t.nodes.filter((x) => x.dim === "miss" && x.val === "fixed_since").reduce((s, x) => s + x.n, 0);
  const splitN = t.nodes.filter((x) => x.dim === "miss" && x.val === "split").reduce((s, x) => s + x.n, 0);
  // 2026-11-25 作業員A（統括役の頼み）: ブレインも2段の約束を書いていた番（先後に数えていた）。今の数（根の value）は変えず、合うに数えた一致を並べる
  const tsdN = t.nodes.filter((x) => x.dim === "miss" && x.val === "two_stage_draft").reduce((s, x) => s + x.n, 0);
  const soN = t.nodes.filter((x) => x.dim === "miss" && x.val === "staff_only").reduce((s, x) => s + x.n, 0); // ④スタッフだけが知る結果（11/25 統括役の決め）
  const nShort = [...t.sides].filter(([, v]) => v.side === "n_short");
  if (spec) console.log(`  竹内さんの決定で正解を改めた番: 外れに数えていた ${decN}（${[...t.decided].map(([id, q]) => `${id}=${q}`).join("・") || "なし"}）`);
  if (def.builder === "aix_turn_device") {
    console.log(`  竹内さんの少数側（同じ形で竹内さん本人の別の一手が過半数・n ${10} 以上・ブレインは多い方）: ${minN}（${[...t.minority].map(([id, x]) => `${id}＝${x.shape} で ${x.majority} ${Math.round(x.share * 100)}%/${x.n}`).join("・") || "なし"}）`);
    console.log(`  直しが入った日より前の番: ${fixedN}（${[...t.fixed].map(([id, f]) => `${id}＝${f}`).join("・") || "なし"}）`);
    console.log(`  割れ（どちらにも決めない）: ${splitN}（${[...t.sides].filter(([, v]) => v.side === "split").map(([id, v]) => `${id}＝${v.shape} で ${v.majority}/${v.n}`).join("・") || "なし"}）`);
    console.log(`  n 不足（外れのまま・見張りで数え続ける）: ${nShort.length}（${nShort.map(([id, v]) => `${id}＝n ${v.n}`).join("・") || "なし"}）`);
    console.log(`  数の分け: 実送信で一致 ${t.nodes[0].ok}・外れ ${t.nodes[0].misses - decN - minN - timedN - fixedN - splitN - tsdN - soN}（うち n 不足 ${nShort.length}）・決定で改めた ${decN}・竹内さんの少数側 ${minN}・割れ ${splitN}・時刻で送る物 ${timedN}・直しが入る前の番 ${fixedN}・ブレインも2段の約束を書いていた ${tsdN}・スタッフだけが知る結果 ${soN}（n ${t.n}）`);
    console.log(`  並べて見る（2段を合うに・スタッフだけが知る結果を数えない）: ${t.n > soN ? Math.round(((t.nodes[0].ok + tsdN) / (t.n - soN)) * 1000) / 10 : "—"}%（${t.n - soN}番中 ${t.nodes[0].ok + tsdN}番）`);
    console.log(`  並べて見る（ブレインも2段の約束を書いていた番を合うに数える）: ${t.n ? Math.round(((t.nodes[0].ok + tsdN) / t.n) * 1000) / 10 : "—"}%（${t.n}番中 ${t.nodes[0].ok + tsdN}番・今の数え方 ${t.value}%）`);
  }
  if (def.builder === "route_next" || def.builder === "route_progress") {
    const { stationTableOf, leafJa } = await import("../app/lib/metric-map");
    const tb = stationTableOf(t.nodes);
    const sum = tb.reduce((a, x) => ({ n: a.n + x.n, ok: a.ok + x.ok, aside: a.aside + x.aside, real: a.real + x.real }), { n: 0, ok: 0, aside: 0, real: 0 });
    console.log(`  駅ごとの本当の一致（一致／分けて外した番を除いた数）: 全体 ${sum.ok}/${sum.n - sum.aside}（分けて外した ${sum.aside}・本当の外れ ${sum.real}）`);
    for (const x of tb) console.log(`   ${leafJa(x.key)}: ${x.ok}/${x.n - x.aside}${x.aside ? `（分けて外した ${x.aside}）` : ""}・本当の外れ ${x.real}`);
  }
  for (const x of t.nodes.filter((x) => x.depth === 1)) console.log(`   ├ ${x.label}: ${x.value}%（n ${x.n}・外れ ${x.misses}）`);
  for (const r of ranked.slice(0, Number(arg("top", "10")) || 10)) console.log(`   ${m.leafLine(r)}`);
  const hl = m.holesOf(ranked, t.nodes);
  console.log(`  穴（作業も見込みも無い・葉か場面の段で外れ 3 以上）${hl.length}: ${hl.map((h) => `${h.key.split("/").slice(1).join(" › ")}（外れ ${h.misses}/${h.n}${h.hold ? "・判断保留" : ""}）`).join("・") || "なし"}`);
  const scenes = t.nodes.filter((x) => x.dim === "scene" || (x.dim === "station" && x.depth === 1));
  const noP = scenes.filter((x) => x.misses > 0 && ![...examByLeaf].some(([k]) => m.covers(x.key, k)));
  console.log(`  試験の問題: ${scenes[0]?.dim === "station" ? "駅" : "種類×場面"}の段 ${scenes.length} のうち 外れがあって問題0 ${noP.length}: ${noP.sort((a, b) => b.misses - a.misses).map((x) => `${x.key.split("/").slice(1).join(" › ")}（${x.misses}）`).join("・") || "なし"}`);
  if (flag("write") && def.builder === "aix_turn_device") {
    // 11/23 作業員A（#624 組の物差しの本当の一致）: 割れ・少数側・n 不足の番ごとの印をファイルに（会話の頭8字・時刻・印）。読み先は COMBO_NET_SIDES_FILE か既定の scripts/.replay-out/aix-turn-sides.json
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const out = arg("sides-out") || process.env.COMBO_NET_SIDES_FILE || "scripts/.replay-out/aix-turn-sides.json";
    const byId = new Map((rows as Array<{ id: number; conv: string; at: string }>).map((r) => [r.id, r]));
    const sides = [...t.sides].map(([id, v]) => ({ conv: byId.get(id)?.conv ?? "", at: byId.get(id)?.at ?? "", side: v.side, shape: v.shape, id })).filter((x) => x.conv && x.at);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(sides, null, 1));
    console.log(`書いた: 番ごとの印 ${sides.length}行（割れ ${sides.filter((x) => x.side === "split").length}・少数側 ${sides.filter((x) => x.side === "minority").length}・n 不足 ${sides.filter((x) => x.side === "n_short").length}）→ ${out}`);
  }
  if (flag("write")) {
    const day = m.jstDay(Date.now());
    const w = await m.writeTree(db, day, def, t.nodes, ranked);
    const qd = [
      { day, metric: `map:${def.metric}:value`, scope: "all", value: t.value, n: t.n, detail: { writer_select: def.writerSelect, built: true, from_json: arg("json").split(/[\\/]/).pop() } },
      { day, metric: `map:${def.metric}:sum_mismatch`, scope: "all", value: bad.length, n: t.nodes.length },
      { day, metric: `map:${def.metric}:decided`, scope: "all", value: decN, n: t.n, detail: { turns: Object.fromEntries(t.decided) } },
      { day, metric: `map:${def.metric}:minority`, scope: "all", value: minN, n: t.n, detail: { turns: Object.fromEntries(t.minority) } },
      { day, metric: `map:${def.metric}:timed`, scope: "all", value: timedN, n: t.n },
      { day, metric: `map:${def.metric}:fixed_since`, scope: "all", value: fixedN, n: t.n, detail: { turns: Object.fromEntries(t.fixed) } },
      { day, metric: `map:${def.metric}:split`, scope: "all", value: splitN, n: t.n },
      { day, metric: `map:${def.metric}:staff_only`, scope: "all", value: soN, n: t.n, detail: { ok_two_stage_net: t.nodes[0].ok + tsdN, rate_two_stage_net: t.n > soN ? Math.round(((t.nodes[0].ok + tsdN) / (t.n - soN)) * 1000) / 10 : null } },
      { day, metric: `map:${def.metric}:two_stage_draft`, scope: "all", value: tsdN, n: t.n, detail: { ok_with_two_stage: t.nodes[0].ok + tsdN, rate_with_two_stage: t.n ? Math.round(((t.nodes[0].ok + tsdN) / t.n) * 1000) / 10 : null } },
      { day, metric: `map:${def.metric}:n_short`, scope: "all", value: nShort.length, n: t.n, detail: { turns: Object.fromEntries(nShort.map(([id, v]) => [id, v.n])) } },
      { day, metric: `map:${def.metric}:misses_net`, scope: "all", value: t.nodes[0].misses - decN - minN - timedN - fixedN - splitN - tsdN - soN, n: t.n, detail: { ok: t.nodes[0].ok, two_stage_draft: tsdN, staff_only: soN, decided: decN, minority: minN, split: splitN, timed: timedN, fixed_since: fixedN, n_short: nShort.length } },
      { day, metric: `map:${def.metric}:holes`, scope: "all", value: m.holesOf(ranked, t.nodes).filter((h) => !h.hold).length, n: ranked.length },
      { day, metric: `map:${def.metric}:hold`, scope: "all", value: ranked.filter((r) => r.hold).length, n: ranked.length },
      ...ranked.slice(0, 5).map((r) => ({ day, metric: `map:${def.metric}:rank${r.rank}`, scope: "all", value: r.score, n: r.n, detail: { leaf: r.key, misses: r.misses, gain: r.gain, items: r.items, next: r.nextStep, hold: r.hold, hole: r.hole, writer_select: def.writerSelect } })),
    ];
    const { error } = await db.from("quality_daily").upsert(qd.map((x) => ({ ...x, source: "scripts/work-items.ts --map-build（#610）" })), { onConflict: "day,metric,scope" });
    if (error) throw new Error(error.message);
    console.log(`書いた: metric_map_nodes ${w}行・quality_daily ${qd.length}行（${day}）`);
  }
}

async function cmdForecastCheck() {
  const m = await import("./lib/metric-map-server");
  const db = sb();
  const items = await m.loadForecastItems(db);
  const r = await m.forecastCheck(db, items, { write: flag("write"), night: m.isNightJst() || flag("force") });
  console.log(`見込みの突き合わせ: 見込みあり ${items.filter((i) => i.forecast_metric).length}・7/14日の頃 ${r.due}・突き合わせ済み ${r.checked}・幅の中 ${r.inBand}`);
  for (const l of r.lines) console.log(l);
  for (const f of r.fix) console.log(`要確認: ${f}`);
}

async function cmdForecastCause() {
  const id = Number(arg("forecast-cause"));
  const cause = argv.find((a) => !a.startsWith("--")) ?? "";
  if (!id || !["material", "misread", "aix_turn_as_reply", "counting"].includes(cause)) throw new Error("--forecast-cause=<id> <material|misread|aix_turn_as_reply|counting> --note=...");
  if (!arg("note")) throw new Error("--note= に、なぜその原因かを書く（実物の番の id など）");
  const db = sb();
  const { error } = await db.from("work_items").update({ forecast_gap_cause: cause, forecast_gap_note: arg("note"), updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw new Error(error.message);
  await db.from("work_item_events").insert({ item_id: id, kind: "note", actor: arg("actor", "session"), note: `見込みの外れの原因: ${cause}・${arg("note")}` });
  console.log(`#${id}: 外れの原因 ${cause}`);
}

async function cmdNoForecast() {
  const m = await import("./lib/metric-map-server");
  const rows = await m.loadUnforecastTop(sb());
  console.log(`見込みの無い P0/P1 の作業 ${rows.length}`);
  for (const r of rows) console.log(`- #${r.id} p${r.priority} [${STAGE_JA[r.stage as Stage] ?? r.stage}] ${r.owner ?? ""}: ${String(r.title).slice(0, 80)}`);
}

async function main() {
  if (arg("forecast") && /^\d+$/.test(arg("forecast"))) return cmdForecast();
  if (arg("map-build")) return cmdMapBuild();
  if (flag("map")) return cmdMap();
  if (flag("forecast-check")) return cmdForecastCheck();
  if (arg("forecast-cause")) return cmdForecastCause();
  if (flag("no-forecast")) return cmdNoForecast();
  if (flag("list")) return cmdList();
  if (flag("add")) return cmdAdd();
  if (arg("stage") && /^\d+$/.test(arg("stage"))) return cmdStage();
  if (flag("done-check")) return cmdDoneCheck();
  if (arg("import")) return cmdImport();
  console.log("使い方: --list ／ --add --title=... ／ --stage=<id> <新しい段> --note=... ／ --done-check ／ --import=<json> [--dry] ／ --forecast=<id> --metric= --low= --high= ／ --map [--metric=] ／ --forecast-check [--write] ／ --forecast-cause=<id> <原因> --note= ／ --no-forecast");
}
if (require.main === module) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
