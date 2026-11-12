import "dotenv/config";
import {
  connectDb,
  mongoose,
  User,
  Driver,
  Vehicle,
  Document,
  Wallet,
} from "../apps/api/src/db";

async function main() {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.ALLOW_LOCAL_OTP !== "true"
  ) {
    throw Error("Ce script est réservé aux tests locaux avec OTP local.");
  }
  const uri = process.env.MONGODB_URI!;
  const host = new URL(uri).hostname;
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host))
    throw Error("MongoDB local requis.");
  await connectDb(uri);
  const expiry = new Date(Date.now() + 365 * 86400000);
  for (let i = 1; i <= 5; i++) {
    const phone = `+2267000810${i}`;
    const name = `Taxi TEST ${String(i).padStart(2, "0")}`;
    const existing = await User.findOne({ phone });
    if (existing && (existing.role !== "driver" || existing.name !== name))
      throw Error(`Numéro déjà utilisé : ${phone}`);
    const user = await User.findOneAndUpdate(
      { phone },
      { $setOnInsert: { phone, name, role: "driver" } },
      { upsert: true, returnDocument: "after" },
    );
    await Driver.updateOne(
      { userId: user._id },
      {
        $set: { name, approved: true, documentsApprovedAt: new Date() },
        $setOnInsert: {
          online: false,
          location: {
            type: "Point",
            coordinates: [-1.519 + i * 0.001, 12.371],
          },
        },
      },
      { upsert: true },
    );
    await Vehicle.updateOne(
      { driverId: user._id },
      {
        $set: {
          brand: [
            "Toyota Corolla",
            "Hyundai Accent",
            "Kia Rio",
            "Toyota Yaris",
            "Renault Logan",
          ][i - 1],
          plate: `TEST-OUAGA-00${i}`,
          insuranceExpiresAt: expiry,
          inspectionExpiresAt: expiry,
        },
      },
      { upsert: true },
    );
    for (const kind of [
      "identity",
      "license",
      "insurance",
      "registration",
      "inspection",
    ]) {
      const key = `test-only/${user._id}/${kind}`;
      await Document.updateOne(
        { key },
        {
          $set: {
            driverId: user._id,
            kind,
            mime: "application/pdf",
            status: "approved",
            expiresAt: expiry,
            reason: "Fiche fictive de test local, aucun justificatif réel.",
          },
        },
        { upsert: true },
      );
    }
    await Wallet.updateOne(
      { driverId: user._id },
      { $setOnInsert: { balance: 0 } },
      { upsert: true },
    );
    console.log(
      `${name} | ${phone} | TEST-OUAGA-00${i} | validé, aucun prépaiement requis`,
    );
  }
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
