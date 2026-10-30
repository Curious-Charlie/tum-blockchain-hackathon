/** npm run dashboard: serves the live demo dashboard. */
import { startDashboard } from "../dashboard/server.ts";

const { url, embedded } = await startDashboard();
console.log(embedded ? `Dashboard: ${url}` : `A dashboard is already running at ${url}`);
if (!embedded) process.exit(0);
