/**
 * AgentGuard kill switch for every agent on this machine.
 *
 *   npm run freeze          # stop all payments
 *   npm run freeze -- off   # resume
 */
import { freezeAll, frozenReason, unfreezeAll } from "../guard.ts";

if (process.argv.includes("off")) unfreezeAll();
else freezeAll(process.argv.slice(2).join(" ") || "frozen by operator");
console.log(frozenReason() ? `AgentGuard FROZEN: ${frozenReason()}` : "AgentGuard active: payments allowed within policy");
