import type { Config } from "@netlify/functions";
import { syncGroceriesToBring } from "./utils/bringSync.mts";

// Sundays at 09:00 Johannesburg time — same schedule as the grocery email.
// The actual push logic lives in utils/bringSync.mts, shared with
// sync-bring.mts (the "Sync to Bring now" button in the app), so both
// the automatic Sunday push and an on-demand sync do exactly the same
// thing.

export default async () => {
  const result = await syncGroceriesToBring();
  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }
};

export const config: Config = {
  schedule: "0 7 * * 0",
};
