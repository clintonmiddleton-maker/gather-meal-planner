// Shared helper for the reminder functions. Not a function itself —
// Netlify only treats a file as its own function when it's directly in
// netlify/functions/ or named index.mts / <folder-name>.mts inside a
// subfolder, so this one is just an importable module.

export async function sendReminderEmail({ subject, html }: { subject: string; html: string }) {
  const apiKey = Netlify.env.get("RESEND_API_KEY");
  const from = Netlify.env.get("REMINDER_FROM") || "Gather <onboarding@resend.dev>";
  const toRaw = Netlify.env.get("REMINDER_EMAILS") || "";
  const to = toRaw.split(",").map((s) => s.trim()).filter(Boolean);

  if (!apiKey) {
    console.error("RESEND_API_KEY is not set in Netlify environment variables — skipping email.");
    return;
  }
  if (to.length === 0) {
    console.error("REMINDER_EMAILS is not set in Netlify environment variables — skipping email.");
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, html }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error("Resend send failed:", res.status, errText);
  }
}
