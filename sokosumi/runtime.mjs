// Coworker-side Task calls the CLI has no command for, with the Coworker's runtime
// key from the OS vault (imported once with `sk --preprod runtime key-import`).
// Runs on Node 24 next to the pinned CLI; the PayOnProof worker calls it.
//
//   node runtime.mjs events TASK_ID            # the Task's events as JSON
//   echo "text" | node runtime.mjs comment TASK_ID
//
// Every call first checks that the Task belongs to COWORKER_ID (and to
// SOKOSUMI_ORGANIZATION_ID when set).
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dist = join(import.meta.dirname, "node_modules/@masumi_network/sokosumi/dist/src");
const load = (file) => import(pathToFileURL(join(dist, file)).href);
const { readRuntimeCredential } = await load("coworker/runtime-credentials.js");
const { createCoworkerHttpClient } = await load("api/http-client.js");
const { fetchTaskEvents, createTaskEvent } = await load("api/services/task-service.js");

const [command, taskId] = process.argv.slice(2);
const coworkerId = process.env.COWORKER_ID?.trim();
const organizationId = process.env.SOKOSUMI_ORGANIZATION_ID?.trim() || null;
if (!coworkerId || !/^[\w-]+$/.test(taskId ?? "")) throw new Error("usage: COWORKER_ID=… node runtime.mjs events|comment TASK_ID");

const runtime = createCoworkerHttpClient({ apiKey: readRuntimeCredential(coworkerId) });
const { data: task } = await runtime.get(`/v1/tasks/${encodeURIComponent(taskId)}`, AbortSignal.timeout(30_000));
if (task?.id !== taskId || (task.coworkerId ?? task.assigneeId) !== coworkerId || (organizationId && task.organizationId !== organizationId)) {
  throw new Error("Task does not belong to this Coworker and Workspace");
}

if (command === "events") {
  const { events } = await fetchTaskEvents(runtime, taskId, AbortSignal.timeout(30_000));
  console.log(JSON.stringify({ events }));
} else if (command === "comment") {
  let comment = "";
  for await (const chunk of process.stdin) comment += chunk;
  if (!comment.trim() || comment.length > 16_000) throw new Error("comment must be 1 to 16000 characters");
  const { event } = await createTaskEvent(runtime, taskId, { comment }, AbortSignal.timeout(30_000));
  console.log(JSON.stringify({ id: event?.id ?? null }));
} else {
  throw new Error(`unknown command ${command}`);
}
