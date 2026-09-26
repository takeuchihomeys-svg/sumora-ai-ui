// app/api/test/customer-sim/route.ts
// お客様役（テスト・YUMA 専用）の入口。2026-09-27 竹内「YUMA で自動的に YUMA から自動返信が来て、返信を繰り返せたら理想」。
//
// お客様の発言は本来 LINE の署名つきの /api/line-webhook からしか入らない（署名の鍵は Vercel の見えない設定で、外から作れない）。
// ここはサーバーの中から、webhook と**同じ関数**（line-webhook-text.handleTextMessage）でテスト用の会話にお客様の発言を入れる。
// LINE には何も送らない（お客様の発言は LINE を通らない＝YUMA の LINE には出ず、画面の会話にだけ入る）。
//
// 鍵は三重（customer-sim-guard.checkCustomerSimAccess）: ①内部認証 ②CUSTOMER_SIM_ENABLED ③テスト用の会話の一覧。
//   それ以外の会話は必ず 403。本物のお客様には一切動かない（app/lib/__tests__/customer-sim.test.ts で固定）。
//
// POST { conversation_id, mode: "generate" | "inject" | "generate_and_inject", scenario_id?, step_index?, turns_on_step?, text? }
//   generate            … 筋書きの段からお客様の次の返事を作るだけ（入れない・確かめながら進める時）
//   inject              … text をそのままお客様の発言として入れる
//   generate_and_inject … 作って入れる
// GET … 筋書きの一覧（同じ鍵）
import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { checkCustomerSimAccess, customerSimEnabled } from "@/app/lib/customer-sim-guard";
import { getScenario, listScenarios } from "@/app/lib/customer-sim";
import { YUMA_CONVERSATION_ID } from "@/app/lib/test-conversations";
import { generateCustomerReply, injectCustomerMessage } from "@/app/lib/customer-sim-server";

// webhook と同じ（after() の下書き起動・条件の読み取りを待つ）
export const maxDuration = 300;

function gate(req: NextRequest, conversationId: string | null | undefined, skipConversation = false) {
  const authOk = requireInternalAuth(req) === null;
  const access = checkCustomerSimAccess({
    authOk, enabled: customerSimEnabled(),
    // GET（一覧）は会話を持たないので、YUMA の id で会話の鍵だけ通す（一覧を返すだけ）
    conversationId: skipConversation ? YUMA_CONVERSATION_ID : conversationId,
  });
  return access.ok ? null : NextResponse.json({ ok: false, error: access.reason }, { status: access.status });
}

export async function GET(req: NextRequest) {
  const denied = gate(req, null, true);
  if (denied) return denied;
  return NextResponse.json({
    ok: true,
    scenarios: listScenarios().map((s) => ({ id: s.id, title: s.title, steps: s.steps.map((st) => ({ goal: st.goal, fixed: st.fixed ?? null, max_turns: st.max_turns ?? 1, expect_stage: st.expect_stage ?? null })) })),
  });
}

export async function POST(req: NextRequest) {
  let body: { conversation_id?: string; mode?: string; scenario_id?: string; step_index?: number; turns_on_step?: number; text?: string };
  try { body = await req.json(); } catch { body = {}; }
  const denied = gate(req, body.conversation_id);
  if (denied) return denied;
  const conversationId = String(body.conversation_id).trim();
  const mode = body.mode ?? "generate_and_inject";
  if (!["generate", "inject", "generate_and_inject"].includes(mode)) {
    return NextResponse.json({ ok: false, error: "mode は generate / inject / generate_and_inject" }, { status: 400 });
  }

  try {
    let text = typeof body.text === "string" ? body.text.trim() : "";
    let generated: Awaited<ReturnType<typeof generateCustomerReply>> | null = null;
    if (mode !== "inject") {
      const scenario = getScenario(body.scenario_id);
      if (!scenario) return NextResponse.json({ ok: false, error: "scenario_id が分かりません" }, { status: 400 });
      const cursor = { stepIndex: Math.max(0, Number(body.step_index ?? 0) | 0), turnsOnStep: Math.max(0, Number(body.turns_on_step ?? 0) | 0) };
      generated = await generateCustomerReply(conversationId, scenario, cursor);
      text = generated.text;
    }
    if (!text) return NextResponse.json({ ok: false, error: "text が空です" }, { status: 400 });

    const injected = mode === "generate" ? null : await injectCustomerMessage(conversationId, text);
    console.log(JSON.stringify({ tag: "customer-sim", conversationId, mode, scenario: body.scenario_id ?? null, step: body.step_index ?? null, source: generated?.source ?? "given", injected: !!injected?.ok }));
    return NextResponse.json({
      ok: injected ? injected.ok : true,
      text,
      goal_reached: generated?.goalReached ?? null,
      source: generated?.source ?? "given",
      usage: generated?.usage ?? null,
      injected,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[customer-sim]", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
