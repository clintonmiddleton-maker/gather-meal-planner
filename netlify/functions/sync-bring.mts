import type { Context, Config } from "@netlify/functions";
import { syncGroceriesToBring } from "./utils/bringSync.mts";

// Called from the "Sync to Bring now" button in the Grocery tab. Unlike
// the scheduled Sunday push, this is a normal function reachable by URL,
// so the app can call it directly and show the result. Same underlying
// logic either way — see utils/bringSync.mts.

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const result = await syncGroceriesToBring();
  return new Response(JSON.stringify(result), {
    status: result.ok ? 200 : 502,
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/sync-bring",
};
