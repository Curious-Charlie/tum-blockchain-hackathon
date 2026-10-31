// Vercel Node function: POST /api/run streams one campaign cycle as NDJSON. Bundled by `pnpm creator:web:build`.
import { timingSafeEqual } from 'node:crypto';
import { runCampaign, type TeamEvent } from './team.ts';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const samePasscode = (given: string, expected: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export async function POST(request: Request): Promise<Response> {
  let body: { passcode?: unknown; dryRun?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json(400, { error: 'Send a JSON body' });
  }
  const expected = process.env.DEMO_PASSCODE;
  if (!expected || typeof body.passcode !== 'string' || !samePasscode(body.passcode, expected))
    return json(401, { error: 'Wrong passcode' });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: TeamEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
      try {
        await runCampaign(emit, { dryRun: body.dryRun === true });
      } catch (error) {
        emit({ agent: 'system', kind: 'error', text: (error as Error).message.split('\n')[0] ?? 'failed' });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  });
}
