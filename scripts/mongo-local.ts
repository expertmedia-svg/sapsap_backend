import { MongoMemoryReplSet } from "mongodb-memory-server";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
async function main() {
  await mkdir(resolve(".local/mongo"), { recursive: true });
  const repl = await MongoMemoryReplSet.create({
    binary: { version: "8.0.17" },
    replSet: { count: 1, storageEngine: "wiredTiger" },
    instanceOpts: [{ port: 27017, dbPath: resolve(".local/mongo") }],
  });
  const uri = repl.getUri("ouagaride");
  await writeFile(".local/mongo-uri.txt", uri);
  console.log("MongoDB réel disponible : " + uri);
  console.log(
    "Conservez cette fenêtre ouverte. URI également dans .local/mongo-uri.txt",
  );
  process.on("SIGINT", async () => {
    await repl.stop({ doCleanup: false });
    process.exit(0);
  });
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
