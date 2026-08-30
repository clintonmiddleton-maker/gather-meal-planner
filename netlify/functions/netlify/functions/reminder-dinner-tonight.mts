import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { sendReminderEmail } from "./utils/email.mts";

// Runs daily at 13:00 UTC (15:00 Johannesburg time) and skips weekends,
// since the planner itself only covers Monday to Friday.

const PLANNED_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

function todaySAST(): string {
  const now = new Date();
  const sast = new Date(now.getTime() + 2 * 60 * 60 * 1000); // SAST is UTC+2, no daylight saving
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return days[sast.getUTCDay()];
}

export default async () => {
  const today = todaySAST();
  if (!PLANNED_DAYS.includes(today)) {
    console.log(`${today} isn't a planned day — skipping the dinner reminder.`);
    return;
  }

  const store = getStore("gather-meal-planner");
  const state: any = await store.get("state", { type: "json" });
  if (!state || !state.plan || !state.recipes || !state.family) {
    console.error("No saved plan found — skipping dinner reminder.");
    return;
  }

  const findRecipe = (id: string) => state.recipes.find((r: any) => r.id === id);
  const key = `${today}-dinner`;
  const entry = state.plan[key] || {};

  let html = `<p>Hi there,</p><p><strong>Tonight's dinner (${today}):</strong></p><ul>`;
  state.family.forEach((m: any) => {
    const pe = entry[m.id];
    let label = "not planned yet";
    if (pe) {
      if (pe.type === "recipe") {
        const r = findRecipe(pe.recipeId);
        label = r ? r.name : "(recipe removed)";
      } else {
        label = pe.title;
      }
    }
    html += `<li><strong>${m.name}:</strong> ${label}</li>`;
  });
  html += "</ul>";

  await sendReminderEmail({
    subject: `Tonight's dinner — ${today}`,
    html,
  });
};

export const config: Config = {
  schedule: "0 13 * * *",
};
