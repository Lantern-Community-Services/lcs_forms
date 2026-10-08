import "../src/env.js"; // loads .env / .env.local
import { prisma } from "../src/prisma.js";
import { fileStorageLabel, moveFilesToBlob } from "../src/services/fileStore.js";

/**
 * Move uploaded files kept in the database (from before Blob Storage was set
 * up) into Blob Storage, then clear them from the database:
 *
 *   AZURE_STORAGE_ACCOUNT_URL=https://<account>.blob.core.windows.net npm run files:to-blob
 *
 * Safe to run again; files already in Blob Storage are left alone.
 */
async function main() {
  console.log(`Moving files to ${fileStorageLabel()}…`);
  const n = await moveFilesToBlob();
  console.log(`Done: ${n} file${n === 1 ? "" : "s"} moved.`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
