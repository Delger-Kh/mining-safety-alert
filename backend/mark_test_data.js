// Run this ONCE to mark old anonymous reports as test data:
// node mark_test_data.js
//
// It finds all reports where reporterEmployeeId is empty/missing
// and sets isTestData: true on them so they can be filtered out.

const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/mine_safety";

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log("[DB] Connected:", MONGO_URI);

  // Add isTestData field to all reports that have no reporterEmployeeId
  const result = await mongoose.connection.collection("reports").updateMany(
    {
      $or: [
        { reporterEmployeeId: { $exists: false } },
        { reporterEmployeeId: "" },
        { reporterEmployeeId: null },
      ],
    },
    {
      $set: { isTestData: true },
    }
  );

  console.log(`[Done] Marked ${result.modifiedCount} reports as test data.`);
  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });