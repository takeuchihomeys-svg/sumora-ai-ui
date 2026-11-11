// scripts/conductor-our-side-replay.ts — 入口の統括に「こちら側の状態」を渡すと、最初の一手（返信か AIX か・AIX の種類）の読みが竹内さん・スタッフに近づくか（作業員4・11/11）
//
// テストの決まり（memory/test_protocol_brain.md）: LLM_TEST_MODE=deepseek-all・入口 setupLlmTest を最初に・会話の id は YUMA（材料は伏せた本番の会話）。
//   材料: line_watch_turns の番（--ids）。会話は申込の書類の手前で切り（loadDeepseekCutoff と APPLY_DOCS_RE）、名前・連絡先を伏せる。書き込みなし。
//   比べる: A＝今まで通り（お客様の今の番・直前のこちらの送信）／B＝A＋ourSideBlock。答えの最初の todo が aix か（＋what の言葉で AIX の種類）を、スタッフの最初の一手と比べる。
// 実行: LLM_TEST_MODE=deepseek-all npx tsx --env-file=<鍵のある env> scripts/conductor-our-side-replay.ts --ids=8771,8782,... [--label=os1]
import { setupLlmTest } from "./lib/llm-test-harness";

const arg = (k: string, d = "") => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;

/** todo の what の言葉から AIX の種類（決まった計算・採点だけに使う） */
export function aixKindOfWhat(w: string): string | null {
  if (/見積/.test(w)) return "estimate_sheet";
  if (/待ち合わせ|集合|場所/.test(w)) return "meeting_place";
  if (/内覧|内見|日程|候補/.test(w)) return "viewing_invite";
  if (/設備|管理会社|規約|鍵|エアコン|駐車|ペット/.test(w)) return "acknowledge_check";
  if (/空き|募集|物件確認|確認の結果|申込(が|の)?(有無|状況)/.test(w)) return "property_check_result";
  if (/オススメ|おすすめ|1件|一件/.test(w)) return "property_recommendation";
  if (/物件(を)?送|ピックアップ|束/.test(w)) return "property_send";
  if (/電話/.test(w)) return "phone_call";
  if (/申込/.test(w)) return "application_push";
  return null;
}
const FAMILY: Record<string, string> = { property_check_result: "check", acknowledge_check: "check", estimate_sheet: "estimate", property_send: "property", property_recommendation: "property", viewing_invite: "viewing", meeting_place: "viewing" };

(async () => {
  const h = await setupLlmTest(`conductor-our-side-replay-${arg("label", "x")}`.slice(0, 60));
  try {
    const { YUMA_CONVERSATION_ID } = await import("../app/lib/test-conversations");
    h.assertYuma(YUMA_CONVERSATION_ID, "こちら側の状態の解き直し");
    const { createClient } = await import("@supabase/supabase-js");
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const { intakePrefix, intakeUser, parseIntake } = await import("../app/lib/conductor-intake");
    const { ourSideBlock } = await import("../app/lib/conductor-our-side");
    const { callDeepSeek } = await import("../app/lib/vision-alt-provider");
    const { loadDeepseekCutoff, NO_CUTOFF } = await import("../app/lib/post-apply");
    const { APPLY_DOCS_RE, maskContactBits } = await import("../app/lib/conductor-turn-vectors");
    const { maskPII } = await import("../app/lib/pii-mask");
    const { customerNameTokens, maskCustomerNames } = await import("../app/lib/compose-name-mask");
    const prefix = intakePrefix([]);
    const ids = arg("ids").split(",").map(Number).filter(Boolean);
    const { data: rows } = await sb.from("line_watch_turns").select("id, conversation_id, customer_turn_at, customer_last_at, staff_texts, staff_aix").in("id", ids);
    const res = { n: 0, skip: 0, A: { route: 0, kind: 0, fam: 0 }, B: { route: 0, kind: 0, fam: 0 }, better: [] as string[], worse: [] as string[] };
    for (const r of ((rows ?? []) as Array<Record<string, any>>).sort((a, b) => a.id - b.id)) {
      const turnAt = r.customer_turn_at as string, lastAt = (r.customer_last_at ?? r.customer_turn_at) as string;
      const cut = await loadDeepseekCutoff(sb as never, r.conversation_id);
      if (cut === null) { res.skip++; continue; } // 申込中・読めない時は渡さない（ISO＝その時刻より後だけ渡す・NO_CUTOFF＝全部）
      const after = (iso: string) => cut === NO_CUTOFF || Date.parse(iso) > Date.parse(String(cut));
      const { data: conv } = await sb.from("conversations").select("customer_name").eq("id", r.conversation_id).maybeSingle();
      const tokens = customerNameTokens([(conv as { customer_name?: string | null } | null)?.customer_name ?? null]);
      const mask = (t: string) => maskContactBits(maskPII(maskCustomerNames(t, tokens)));
      const { data: ms } = await sb.from("messages").select("sender, text, created_at, is_aix_generated").eq("conversation_id", r.conversation_id).lte("created_at", lastAt).order("created_at", { ascending: false }).limit(60);
      const msgs = ((ms ?? []) as Array<{ sender: string; text: string | null; created_at: string; is_aix_generated: boolean | null }>).reverse().filter((m) => after(m.created_at));
      if (msgs.some((m) => APPLY_DOCS_RE.test(m.text ?? ""))) { res.skip++; continue; }
      const { data: ax } = await sb.from("aix_usage_logs").select("aix_type, check_pattern, created_at, sent_at, property_names, estimate_sent").eq("conversation_id", r.conversation_id).lt("created_at", turnAt).order("created_at", { ascending: false }).limit(30);
      const axOk = ((ax ?? []) as Array<{ created_at: string }>).filter((a) => after(a.created_at));
      const before = msgs.filter((m) => m.created_at < turnAt);
      const custTurn = msgs.filter((m) => m.created_at >= turnAt && m.sender === "customer").map((m) => mask(m.text ?? "")).join("\n");
      const lastStaff = [...before].reverse().find((m) => m.sender !== "customer" && (m.text ?? "").trim());
      // スタッフの最初の一手（番の後の最初の文と AIX のうち早い方）
      const st = (r.staff_texts ?? [])[0] as { at: string } | undefined, sa = ((r.staff_aix ?? []) as Array<{ at: string; aix_type: string }>)[0];
      if (!st && !sa) { res.skip++; continue; }
      const staffAix = sa && (!st || Date.parse(sa.at) <= Date.parse(st.at) + 2 * 60_000) ? sa.aix_type : null;
      const base = { customerTurn: custTurn, lastStaff: lastStaff ? mask(lastStaff.text ?? "") : null, carryLine: "", ruleMeta: "" };
      const block = ourSideBlock({ msgs: before.map((m) => ({ ...m, text: mask(m.text ?? "") })), aix: (axOk as unknown as Array<{ aix_type: string; property_names?: string[] | null }>).map((a) => ({ ...a, property_names: (a.property_names ?? []).map((n) => mask(n)) })) as never, nowMs: Date.parse(turnAt) });
      const read = async (ledgerBlock: string) => {
        const out = await callDeepSeek(prefix, intakeUser({ ...base, ledgerBlock }), { maxTokens: 300, thinking: false, temperature: 0, timeoutMs: 20_000 });
        const a = parseIntake(out?.text ?? "");
        const first = a?.todos?.find((x) => x.kind === "aix") ? a!.todos.find((x) => x.kind === "aix")! : a?.todos?.[0];
        const isAix = !!a?.todos?.[0] && a.todos[0].kind === "aix";
        const kind = isAix ? aixKindOfWhat(first?.what ?? "") : null;
        return { isAix, kind, what: a?.todos?.map((x) => `${x.kind}:${x.what}`).join("／") ?? "（読めない）" };
      };
      const [A, B] = [await read(""), await read(block)];
      if (process.argv.includes("--debug")) console.log(`  [debug] ${r.id} A=${A.what.slice(0, 120)} ／ B=${B.what.slice(0, 120)}`);
      res.n++;
      const score = (x: { isAix: boolean; kind: string | null }) => ({ route: x.isAix === !!staffAix, kind: !!staffAix && x.isAix && x.kind === staffAix, fam: !!staffAix && x.isAix && !!x.kind && FAMILY[x.kind] === FAMILY[staffAix] });
      const sA = score(A), sB = score(B);
      for (const [k, s] of [["A", sA], ["B", sB]] as const) { if (s.route) res[k].route++; if (s.kind) res[k].kind++; if (s.fam) res[k].fam++; }
      const line = `  ${r.id}: スタッフ=${staffAix ? `AIX:${staffAix}` : "返信"} ／ A=${A.isAix ? `AIX:${A.kind ?? "?"}` : "返信"}（${A.what.slice(0, 60)}）／ B=${B.isAix ? `AIX:${B.kind ?? "?"}` : "返信"}（${B.what.slice(0, 60)}）`;
      const gain = (sB.route ? 1 : 0) + (sB.kind ? 1 : 0) - (sA.route ? 1 : 0) - (sA.kind ? 1 : 0);
      if (gain > 0) res.better.push(line); else if (gain < 0) res.worse.push(line);
    }
    const p = (x: number) => `${x}/${res.n}`;
    console.log(`番 ${res.n}（飛ばした ${res.skip}）・DeepSeek ${res.n * 2}回`);
    console.log(`  返信か AIX か: A ${p(res.A.route)} → B ${p(res.B.route)}`);
    console.log(`  AIX の種類まで（スタッフが AIX の番）: A ${p(res.A.kind)} → B ${p(res.B.kind)}・系統 A ${p(res.A.fam)} → B ${p(res.B.fam)}`);
    console.log(`良くなった ${res.better.length}:\n${res.better.join("\n")}\n悪くなった ${res.worse.length}:\n${res.worse.join("\n")}`);
  } finally { await h.finish(); }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
