import type { Config } from "@netlify/functions";
import { sendReminderEmail } from "./utils/email.mts";

// Fridays at 17:00 Johannesburg time (SAST is UTC+2, no daylight saving).
export default async () => {
  const appUrl = Netlify.env.get("APP_URL");
  const linkLine = appUrl
    ? `<p><a href="${appUrl}">Open Gather</a> and tap <strong>Start next week from usual plan</strong> in the Planner tab, then swap in anything different for the week ahead.</p>`
    : `<p>Open Gather and tap <strong>Start next week from usual plan</strong> in the Planner tab, then swap in anything different for the week ahead.</p>`;

  await sendReminderEmail({
    subject: "Time to plan next week's meals",
    html: `<p>Hi there,</p><p>It's that time of the week — sit down together and plan next week's meals before the weekend shop.</p>${linkLine}`,
  });
};

export const config: Config = {
  schedule: "0 15 * * 5",
};
