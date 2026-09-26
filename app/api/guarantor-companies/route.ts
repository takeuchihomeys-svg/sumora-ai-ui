// app/api/guarantor-companies/route.ts
// 保証会社の一覧（マスタはコード・スタッフが登録した会社だけ guarantor_companies テーブル）。
// AIX【保証会社について】の select の選択肢と「その他（登録）」の書き込み先。2026-09-15 竹内（YUYA 事例）
//   静的な一覧（名寄せ・種類）は app/lib/guarantor-companies.ts にハードコード（feedback_static_vs_dynamic_db）。
//   マスタと同じ会社は登録せず duplicate:true でマスタ側を返す（UI はそれを選択状態にする）
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/app/lib/supabase";
import { requireInternalAuth } from "@/app/lib/api-auth";
import { GUARANTOR_COMPANY_MASTER, normalizeGuarantorName, isMasterGuarantor, normalizeGuarantorType, resolveGuarantor, type GuarantorType } from "@/app/lib/guarantor-companies";

type CompanyRow = { name: string; type: GuarantorType; source: "master" | "custom" };

export async function GET(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const { data, error } = await supabase.from("guarantor_companies").select("name, type, created_at").order("created_at", { ascending: true });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const master: CompanyRow[] = GUARANTOR_COMPANY_MASTER.map((c) => ({ name: c.name, type: c.type, source: "master" }));
  const custom: CompanyRow[] = ((data ?? []) as Array<{ name: string; type: string | null }>)
    .filter((r) => r.name && !isMasterGuarantor(r.name))
    .map((r) => ({ name: r.name, type: normalizeGuarantorType(r.type) ?? "unknown", source: "custom" }));
  return NextResponse.json({ ok: true, companies: [...master, ...custom] });
}

export async function POST(req: NextRequest) {
  const authError = requireInternalAuth(req);
  if (authError) return authError;
  const body = await req.json().catch(() => ({})) as { name?: unknown; type?: unknown };
  const name = String(body.name ?? "").trim().slice(0, 60);
  if (!name) return NextResponse.json({ ok: false, error: "保証会社名を入力してください" }, { status: 400 });
  if (isMasterGuarantor(name)) {
    return NextResponse.json({ ok: true, duplicate: true, company: { name: normalizeGuarantorName(name), type: resolveGuarantor(name).type, source: "master" } satisfies CompanyRow });
  }
  const type: GuarantorType = normalizeGuarantorType(body.type) ?? "unknown";   // 旧画面の "licc" は信用系（2026-09-26 種類は3つ）
  const { error } = await supabase.from("guarantor_companies").upsert({ name, type, updated_at: new Date().toISOString() }, { onConflict: "name" });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  console.log(JSON.stringify({ tag: "guarantor-companies:saved", name, type }));
  return NextResponse.json({ ok: true, duplicate: false, company: { name, type, source: "custom" } satisfies CompanyRow });
}
