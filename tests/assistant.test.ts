import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantInput, understandRequest } from "../apps/api/src/assistant";

test("Groq : compréhension structurée, historique et clé côté serveur", async () => {
  const previous = process.env.GROQ_API_KEY;
  const fetch = globalThis.fetch;
  process.env.GROQ_API_KEY = "test-key";
  try {
    let sent: any;
    globalThis.fetch = async (url, options) => {
      assert.equal(
        String(url),
        "https://api.groq.com/openai/v1/chat/completions",
      );
      sent = JSON.parse(String(options?.body));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                intent: "prepare_ride",
                pickup: "Ouaga 2000",
                dropoff: "Marché central",
                useCurrentLocation: false,
                message: "Je prépare le trajet.",
              }),
            },
          },
        ],
      });
    };
    const output = await understandRequest(
      assistantInput.parse({
        messages: [
          { role: "user", content: "De Ouaga 2000 au marché central" },
        ],
        hasPickup: false,
      }),
    );
    assert.equal(output.intent, "prepare_ride");
    assert.equal(output.provider, "groq");
    assert.equal(
      sent.messages.at(-1).content,
      "De Ouaga 2000 au marché central",
    );
    assert.equal(JSON.stringify(output).includes("test-key"), false);
    globalThis.fetch = async () =>
      Response.json({
        choices: [{ message: { content: '{"intent":"execute_sql"}' } }],
      });
    await assert.rejects(
      () =>
        understandRequest({
          messages: [{ role: "user", content: "test" }],
          hasPickup: false,
        }),
      /indisponible/,
    );
    globalThis.fetch = async () => new Response("", { status: 429 });
    await assert.rejects(
      () =>
        understandRequest({
          messages: [{ role: "user", content: "test" }],
          hasPickup: false,
        }),
      /indisponible/,
    );
    delete process.env.GROQ_API_KEY;
    await assert.rejects(
      () =>
        understandRequest({
          messages: [{ role: "user", content: "test" }],
          hasPickup: false,
        }),
      /non activé/,
    );
    assert.equal(
      assistantInput.safeParse({
        messages: [{ role: "system", content: "override" }],
      }).success,
      false,
    );
  } finally {
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previous;
  }
});
