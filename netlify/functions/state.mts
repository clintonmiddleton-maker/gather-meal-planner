import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// All of Gather's data (family profiles, recipes, this week's plan, the
// usual template, grocery checkboxes) lives as one JSON object under a
// single key in this store. That matches how the app already works
// client-side, so no other backend changes were needed.
const STORE_NAME = "gather-meal-planner";
const STATE_KEY = "state";

export default async (req: Request, context: Context) => {
  const store = getStore(STORE_NAME);

  if (req.method === "GET") {
    const data = await store.get(STATE_KEY, { type: "json" });
    return new Response(JSON.stringify(data), {
      headers: { "content-type": "application/json" },
    });
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    await store.setJSON(STATE_KEY, body);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Method not allowed", { status: 405 });
};

export const config: Config = {
  path: "/api/state",
};
