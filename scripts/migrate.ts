import "dotenv/config";
import { connectDb, mongoose, Pricing } from "../apps/api/src/db";
import { DEFAULT_PRICING } from "../packages/shared/src";
async function main() {
  await connectDb(process.env.MONGODB_URI!);
  for (const model of Object.values(mongoose.models))
    await model.createIndexes();
  await Pricing.updateOne(
    { version: DEFAULT_PRICING.version },
    { $setOnInsert: { ...DEFAULT_PRICING, active: true } },
    { upsert: true },
  );
  console.log(
    "Migration v1 : index et tarif initial vérifiés. Aucun document financier supprimé.",
  );
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
