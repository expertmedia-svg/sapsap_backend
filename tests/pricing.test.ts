import { test } from "node:test";
import assert from "node:assert/strict";
import { fare, eligible } from "../packages/shared/src";
test("5 km et 4 minutes = 1100, commission 77, chauffeur 1023", () =>
  assert.deepEqual(fare(5000, 240), {
    total: 1100,
    commission: 77,
    driver: 1023,
    currency: "XOF",
    meters: 5000,
    stationarySeconds: 240,
  }));
test("secondes cumulées, arrondi final, conservation des montants", () => {
  for (let m = 0; m < 10000; m += 137)
    for (let s = 0; s < 500; s += 17) {
      const f = fare(m, s);
      assert.equal(f.total, f.commission + f.driver);
      assert.ok(Number.isInteger(f.total));
    }
  assert.equal(fare(5000, 60).total, 1025);
  assert.equal(fare(5000, 30 + 30).total, 1025);
});
test("limite exacte du tiers sans arrondi permissif", () => {
  assert.equal(eligible(1666, 5000), true);
  assert.equal(eligible(1667, 5000), false);
  assert.equal(eligible(2000, 6000), true);
  assert.equal(eligible(2001, 6000), false);
});
test("rejet valeurs invalides", () => {
  assert.throws(() => fare(-1, 0));
  assert.throws(() => fare(0, NaN));
  assert.throws(() => eligible(0.5, 300));
});
