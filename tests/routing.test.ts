import { test } from "node:test";
import assert from "node:assert/strict";
import { OsrmRouter } from "../apps/api/src/routing";
const a = { longitude: -1.516, latitude: 12.315 },
  b = { longitude: -1.519, latitude: 12.371 };
const route = {
  code: "Ok",
  routes: [
    {
      distance: 1000.2,
      duration: 60.1,
      geometry: {
        type: "LineString",
        coordinates: [
          [-1.516, 12.315],
          [-1.519, 12.371],
        ],
      },
    },
  ],
};
async function configured(run: () => Promise<void>) {
  const original = globalThis.fetch;
  const env = {
    primary: process.env.ROUTING_URL,
    fallback: process.env.ROUTING_FALLBACK_URL,
    node: process.env.NODE_ENV,
  };
  process.env.NODE_ENV = "test";
  process.env.ROUTING_URL = "https://primary.example/base/";
  process.env.ROUTING_FALLBACK_URL = "https://fallback.example/routed-car/";
  try {
    await run();
  } finally {
    globalThis.fetch = original;
    for (const [key, value] of [
      ["ROUTING_URL", env.primary],
      ["ROUTING_FALLBACK_URL", env.fallback],
      ["NODE_ENV", env.node],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
}
test("Repli routier réel compatible avec un préfixe de chemin et cache borné", () =>
  configured(async () => {
    const urls: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      urls.push(url);
      return url.includes("primary")
        ? new Response("", { status: 503 })
        : Response.json(route);
    };
    const router = new OsrmRouter();
    const result = await router.route(a, b);
    assert.equal(result.meters, 1001);
    assert.equal(result.seconds, 61);
    assert.match(urls[1], /fallback.example\/routed-car\/route\/v1\/driving/);
    assert.deepEqual(await router.route(a, b), result);
    assert.equal(urls.length, 2);
  }));
test("Pas de géométrie inventée si tous les services échouent", () =>
  configured(async () => {
    globalThis.fetch = async () => new Response("", { status: 503 });
    await assert.rejects(
      () => new OsrmRouter().route(a, b),
      /Calcul routier indisponible/,
    );
  }));
test("Deux points identiques ne deviennent pas une erreur réseau", () =>
  configured(async () => {
    globalThis.fetch = async () =>
      Response.json({
        ...route,
        routes: [{ ...route.routes[0], distance: 0 }],
      });
    await assert.rejects(
      () => new OsrmRouter().route(a, a),
      /deux points distincts/,
    );
  }));
test("Les serveurs publics de démonstration sont refusés en production", () =>
  configured(async () => {
    process.env.NODE_ENV = "production";
    process.env.ROUTING_FALLBACK_URL =
      "https://routing.openstreetmap.de/routed-car/";
    await assert.rejects(
      () => new OsrmRouter().route(a, b),
      /production requis/,
    );
  }));

test("Récupération au même point routier autorisée, course nulle toujours refusée", () =>
  configured(async () => {
    globalThis.fetch = async () =>
      Response.json({
        ...route,
        routes: [{ ...route.routes[0], distance: 0, duration: 0 }],
      });
    const router = new OsrmRouter();
    assert.equal((await router.route(a, a, { allowZero: true })).meters, 0);
    await assert.rejects(() => router.route(a, a), /deux points distincts/);
  }));
