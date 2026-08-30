import type { Context, Config } from "@netlify/functions";

// Reads a photo of a recipe card and turns it into Gather's recipe
// format, using the Anthropic API — the same Claude models this app was
// built with. Needs ANTHROPIC_API_KEY set in Netlify's environment
// variables (get one at console.anthropic.com — a separate account/key
// from a claude.ai login, billed per use, but this is a tiny amount of
// usage per recipe).
//
// This only ever returns extracted data for the client to show in the
// review form — nothing is saved until the person confirms it there.

const EXTRACTION_PROMPT = `You are extracting a recipe from a photo of a printed recipe card into a strict JSON schema for a meal-planning app. Output ONLY valid JSON — no markdown code fences, no commentary before or after.

Match this exact shape:
{
  "name": string,
  "mealType": one of "breakfast" | "lunch" | "dinner" | "snack" | "treat",
  "dietType": one of "vegan" | "vegetarian" | "pescatarian" | "omnivore" (choose the strictest that applies — e.g. no meat/fish/dairy/egg = vegan),
  "contains": array drawn only from "dairy" | "gluten" | "nuts" | "egg" | "fish" | "spicy" — include any that visibly apply, omit ones that don't,
  "kidFriendly": boolean, your best judgement of whether this is a mild, kid-typical dish,
  "servings": number (if the card gives macros for a single portion, use 1),
  "prepMin": number (minutes),
  "cookMin": number (minutes),
  "nutrition": { "cal": number, "protein": number, "carbs": number, "fat": number, "fiber": number },
  "ingredients": array of { "name": string, "qty": string, "unit": string, "cat": one of "produce" | "protein" | "dairy" | "pantry" },
  "steps": array of strings, each one method step, rewritten in your own words rather than copied verbatim from the card
}

If a field isn't visible on the card (e.g. fiber isn't listed), give your best reasonable estimate rather than leaving it blank or zero. Keep ingredient names and quantities as close to the card as you can read them.`;

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "ANTHROPIC_API_KEY is not set in Netlify environment variables." }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  let body: { imageBase64?: string; mediaType?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!body.imageBase64 || !body.mediaType) {
    return new Response(JSON.stringify({ error: "Missing image data." }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: body.mediaType, data: body.imageBase64 } },
              { type: "text", text: EXTRACTION_PROMPT },
            ],
          },
        ],
      }),
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: `Could not reach the Anthropic API: ${e?.message || e}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(JSON.stringify({ error: `Anthropic API error (${anthropicRes.status}): ${errText}` }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  const data = await anthropicRes.json();
  const textBlock = (data?.content || []).find((b: any) => b.type === "text");
  const rawText: string = textBlock?.text || "";

  let parsed: any;
  try {
    const cleaned = rawText
      .trim()
      .replace(/^```(json)?/i, "")
      .replace(/```$/, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return new Response(
      JSON.stringify({ error: "Couldn't read a valid recipe from that photo. Try a clearer image, or enter it manually." }),
      { status: 422, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(JSON.stringify(parsed), {
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/extract-recipe",
};
