// app/api/exam-cloud/route.ts — 試験をクラウド（Vercel Sandbox）で流す口（作業員1・2026-11-04・既定 off＝EXAM_CLOUD=on の時だけ）
//   呼ぶのは PC の係 scripts/exam-cloud.ts だけ（合言葉 EXAM_CLOUD_SECRET）。?action=
//     create（VM を作る・鍵は通信の口へ）／chunk&name=&file=code|mat&i=（4MB までの欠片を VM に書く）／run&name=（展開→npm ci→brain-exam を後ろで流す）／
//     status&name=（終わりの印と試験の出力の最後）／fetch&name=&path=（結果のファイル 1つ・4MB まで）／stop&name=
//   鍵は返さない・記録しない。VM の中に鍵は入らない（app/lib/exam-cloud.ts の brokeredPolicy）
import { NextRequest, NextResponse } from "next/server";
import { examCloudGate, createExamSandbox, getExamSandbox } from "@/app/lib/exam-cloud-server";
import { CHUNK_MAX, RUN_DIR, runScript, labelOk } from "@/app/lib/exam-cloud";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const NAME_RE = /^[a-zA-Z0-9_-]{1,80}$/;

export async function POST(req: NextRequest) {
  const g = examCloudGate(req);
  if (g) return g;
  const p = req.nextUrl.searchParams;
  const action = p.get("action") ?? "";
  const name = p.get("name") ?? "";
  try {
    if (action === "create") {
      const body = (await req.json().catch(() => ({}))) as { env?: Record<string, string> };
      const r = await createExamSandbox(body.env ?? {});
      return NextResponse.json({ ok: true, ...r });
    }
    if (!NAME_RE.test(name)) return NextResponse.json({ ok: false, error: "name が無い" }, { status: 400 });
    const sb = await getExamSandbox(name);
    if (action === "chunk") {
      const file = p.get("file"), i = Number(p.get("i"));
      if ((file !== "code" && file !== "mat") || !Number.isInteger(i) || i < 0 || i > 999) return NextResponse.json({ ok: false, error: "file・i が違う" }, { status: 400 });
      const buf = Buffer.from(await req.arrayBuffer());
      if (buf.length === 0 || buf.length > CHUNK_MAX) return NextResponse.json({ ok: false, error: `欠片の大きさ ${buf.length}` }, { status: 400 });
      await sb.writeFiles([{ path: `${RUN_DIR}/up/${file}.${String(i).padStart(3, "0")}`, content: buf }]);
      return NextResponse.json({ ok: true, bytes: buf.length });
    }
    if (action === "run") {
      const body = (await req.json()) as { label: string; argv: string[] };
      if (!labelOk(body.label) || !Array.isArray(body.argv) || body.argv.some((a) => typeof a !== "string" || !a.startsWith("--"))) return NextResponse.json({ ok: false, error: "label・argv が違う" }, { status: 400 });
      const cmd = await sb.runCommand({ cmd: "bash", args: ["-c", runScript({ label: body.label, argv: body.argv })], detached: true });
      return NextResponse.json({ ok: true, cmdId: cmd.cmdId });
    }
    if (action === "status") {
      const done = (await sb.readFileToBuffer({ path: `${RUN_DIR}/out/done` }))?.toString("utf8").trim() ?? null;
      const log = (await sb.readFileToBuffer({ path: `${RUN_DIR}/out/exam.log` }))?.toString("utf8") ?? "";
      const npm = done === "npm-failed" ? ((await sb.readFileToBuffer({ path: `${RUN_DIR}/out/npm.log` }))?.toString("utf8") ?? "").slice(-3000) : "";
      return NextResponse.json({ ok: true, done, tail: log.slice(-4000), npm });
    }
    if (action === "fetch") {
      const path = p.get("path") ?? "";
      // 結果の置き場（app/scripts/brain-exam/results/ と out/）だけ・.. は断る
      if (!/^(app\/scripts\/brain-exam\/results\/|out\/)[\w.@-]+$/.test(path)) return NextResponse.json({ ok: false, error: "path が違う" }, { status: 400 });
      const b = await sb.readFileToBuffer({ path: `${RUN_DIR}/${path}` });
      if (!b) return NextResponse.json({ ok: false, error: "無い" }, { status: 404 });
      if (b.length > CHUNK_MAX) return new NextResponse(new Uint8Array(b.subarray(0, CHUNK_MAX)), { headers: { "content-type": "application/octet-stream", "x-truncated": "1" } });
      return new NextResponse(new Uint8Array(b), { headers: { "content-type": "application/octet-stream" } });
    }
    if (action === "stop") {
      await sb.stop();
      return NextResponse.json({ ok: true, stopped: name });
    }
    return NextResponse.json({ ok: false, error: "action が違う" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }, { status: 500 });
  }
}
