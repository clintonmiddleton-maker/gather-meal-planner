import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendReminderEmail } from "./utils/email.mts";
import { buildGroceryList, formatQty, CATS, CAT_LABEL } from "./utils/groceryList.mts";

// Sundays at 09:00 Johannesburg time (SAST is UTC+2, no daylight saving).
// Reads the same saved state the app itself uses. The aggregation logic
// lives in utils/groceryList.mts, shared with reminder-grocery-bring.mts.

export default async () => {
  const store = getStore("gather-meal-planner");
  const state: any = await store.get("state", { type: "json" });

  if (!state || !state.plan || !state.recipes) {
    console.error("No saved plan found — skipping grocery email.");
    return;
  }

  const { byCat, anyItems } = buildGroceryList(state);

  let html = "<p>Hi there,</p><p>Here's this week's grocery list, straight from Gather:</p>";

  if (!anyItems) {
    html += "<p>Nothing's planned for this week yet — open Gather and plan the week first.</p>";
  } else {
    CATS.forEach((cat) => {
      if (byCat[cat].length === 0) return;
      html += `<h3 style="margin-bottom:4px;">${CAT_LABEL[cat]}</h3><ul style="margin-top:0;">`;
      byCat[cat]
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((it) => {
          html += `<li>${it.name} — ${formatQty(it)}</li>`;
        });
      html += "</ul>";
    });
  }

  await sendReminderEmail({
    subject: "This week's grocery list",
    html,
  });
};

export const config: Config = {
  schedule: "0 7 * * 0",
};
