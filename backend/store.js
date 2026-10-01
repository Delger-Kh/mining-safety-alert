// ─── Өгөгдлийн давхарга (Storage layer) ─────────────────────────────────────
// MongoDB холбогдсон үед MongoDB-г ашиглана. Холбогдоогүй / тасарсан үед
// backend/data/ хавтас дахь локал JSON файл руу автоматаар шилжинэ.
// MongoDB дахин холбогдоход локалд хадгалсан бүх зүйлийг (хэрэглэгч, тайлан,
// мэдэгдэл, зураг, дуу) MongoDB руу автоматаар илгээнэ (sync).
//
// Uses MongoDB when it is reachable. When it is not (never connected, or the
// connection drops), every read/write goes to a local JSON store in
// backend/data/. When MongoDB comes back, everything saved locally is pushed
// to MongoDB automatically. The server never crashes because of MongoDB.

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { GridFSBucket, ObjectId } = require("mongodb");
const { Readable } = require("stream");

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/mine_safety";
const MONGO_DISABLED = ["off", "none", "false", "disabled"].includes(MONGO_URI.trim().toLowerCase());
const RETRY_MS = Number(process.env.MONGO_RETRY_MS || 30000);
const DATA_DIR = process.env.LOCAL_DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "local-db.json");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const MAX_CACHED_SYNCED = 2000; // локал кэшэд хадгалах синк хийгдсэн бичлэгийн дээд тоо

// ─── Схемүүд (Schemas & Indexes) ─────────────────────────────────────────────
mongoose.set("strictQuery", true);
// MongoDB холбогдоогүй үед хүсэлт 10 секунд хүлээлгүй шууд алдаа өгнө → локал руу шилжинэ.
mongoose.set("bufferCommands", false);

const reportSchema = new mongoose.Schema({
  photoMediaId: { type: mongoose.Schema.Types.ObjectId, default: null, ref: "photos.files" },
  audioMediaId: { type: mongoose.Schema.Types.ObjectId, default: null, ref: "audio.files" },
  filename:   { type: String },
  mimeType:   { type: String },
  sizeBytes:  { type: Number },
  is_hazard:  { type: Boolean, required: true },
  type: {
    type: String,
    enum: ["structural","electrical","fire_explosion","chemical_gas","equipment","fall_slip","ppe_violation","vehicle_traffic","other",""],
    default: "",
  },
  severity: {
    type: String,
    enum: ["low","medium","high","critical",""],
    default: "",
    index: true,
  },
  reasoning:  { type: String },
  confidence: { type: Number },
  transcript: { type: String, default: "" },
  tsekh:      { type: String, default: "", index: true },
  alerted:    { type: Boolean, default: false, index: true },
  smsNumbers: [{ type: String }],
  smsFailed:  [{ type: String }],
  wasEdited:  { type: Boolean, default: false },
  isTestData: { type: Boolean, default: false },
  sourcesConflicted: { type: Boolean, default: false },
  aiOriginal: {
    type:     { type: String },
    severity: { type: String },
  },
  reporterPhone:      { type: String, default: "" },
  reporterName:       { type: String, default: "" },
  reporterEmployeeId: { type: String, default: "", index: true },
  createdAt:  { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  versionKey: false,
  collection: "reports",
});
reportSchema.index({ tsekh: 1, createdAt: -1 });
reportSchema.index({ reporterEmployeeId: 1, createdAt: -1 });
reportSchema.index({ alerted: 1, tsekh: 1, createdAt: -1 });
reportSchema.index({ isTestData: 1, createdAt: -1 });
const Report = mongoose.model("Report", reportSchema);

const userSchema = new mongoose.Schema({
  name:       { type: String, default: "" },
  employeeId: {
    type: String,
    required: true,
    unique: true,
    match: [/^\d{5}$/, "Бүртгэлийн дугаар 5 оронтой тоо байх ёстой."],
  },
  phone:      { type: String, required: true },
  role:       { type: String, enum: ["ажилтан", "tsekh_darga", "hub_darga"], default: "ажилтан", index: true },
  tsekh:      { type: String, default: "", index: true },
  createdAt:  { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  versionKey: false,
  collection: "users",
});
userSchema.index({ role: 1, tsekh: 1 });
const User = mongoose.model("User", userSchema);

const notificationSchema = new mongoose.Schema({
  recipientPhone: { type: String, required: true, index: true },
  reportId:       { type: mongoose.Schema.Types.ObjectId, ref: "Report" },
  tsekh:          { type: String, default: "" },
  severity:       { type: String, default: "" },
  message:        { type: String, default: "" },
  read:           { type: Boolean, default: false },
  createdAt:      { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  versionKey: false,
  collection: "notifications",
});
notificationSchema.index({ recipientPhone: 1, createdAt: -1 });
notificationSchema.index({ recipientPhone: 1, read: 1 });
const Notification = mongoose.model("Notification", notificationSchema);

const MODELS = { users: User, reports: Report, notifications: Notification };

// ─── Туслах функцууд ─────────────────────────────────────────────────────────
// Mongoose баримтыг JSON-д ойр энгийн объект болгоно (ObjectId → string, Date → ISO).
function plain(doc) {
  if (!doc) return doc;
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return JSON.parse(JSON.stringify(obj));
}

function stripMeta(doc) {
  if (!doc) return doc;
  const { _synced, ...rest } = doc;
  return rest;
}

function isConnectionError(err) {
  if (!err) return false;
  const names = [
    "MongoNetworkError", "MongoNetworkTimeoutError", "MongoServerSelectionError",
    "MongoNotConnectedError", "MongoTopologyClosedError", "MongoPoolClearedError",
  ];
  if (names.includes(err.name)) return true;
  const msg = String(err.message || "");
  return /before initial connection|buffering timed out|not connected|connection .* closed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|topology/i.test(msg);
}

// ─── MongoDB холболт ─────────────────────────────────────────────────────────
let photoBucket = null;
let audioBucket = null;
let syncing = false;
let retryTimer = null;
let everConnected = false;

function mongoReady() {
  return !MONGO_DISABLED && mongoose.connection.readyState === 1 && !!photoBucket;
}

function scheduleRetry() {
  // Нэг удаа холбогдсон бол MongoDB драйвер өөрөө дахин холбогдоно.
  if (MONGO_DISABLED || retryTimer || everConnected) return;
  retryTimer = setTimeout(() => { retryTimer = null; connectMongo(); }, RETRY_MS);
  retryTimer.unref?.();
}

async function connectMongo() {
  if (MONGO_DISABLED) {
    console.log("[DB] MONGO_URI is disabled — using local storage only:", DATA_DIR);
    return;
  }
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
  } catch (err) {
    console.warn(`[DB] MongoDB unavailable (${err.message}). Using local storage; retrying in ${RETRY_MS / 1000}s.`);
    scheduleRetry();
  }
}

mongoose.connection.on("connected", async () => {
  const db = mongoose.connection.db;
  photoBucket = new GridFSBucket(db, { bucketName: "photos" });
  audioBucket = new GridFSBucket(db, { bucketName: "audio" });
  everConnected = true;
  console.log("[DB] Connected to MongoDB.");
  await syncLocalToMongo();
});
mongoose.connection.on("disconnected", () => {
  if (!everConnected) return;
  console.warn("[DB] MongoDB disconnected — switching to local storage until it reconnects.");
  photoBucket = null;
  audioBucket = null;
});
mongoose.connection.on("error", (err) => {
  if (everConnected) console.warn("[DB] MongoDB error:", err.message);
});

// MongoDB бэлэн бол mongoFn-г, үгүй бол (эсвэл холболтын алдаа гарвал) localFn-г ажиллуулна.
async function run(mongoFn, localFn) {
  if (mongoReady()) {
    try {
      return await mongoFn();
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      console.warn("[DB] MongoDB call failed, falling back to local storage:", err.message);
    }
  }
  return localFn();
}

// ─── Локал JSON сан ──────────────────────────────────────────────────────────
fs.mkdirSync(path.join(MEDIA_DIR, "photos"), { recursive: true });
fs.mkdirSync(path.join(MEDIA_DIR, "audio"), { recursive: true });

let local = { users: [], reports: [], notifications: [] };
try {
  if (fs.existsSync(DB_FILE)) {
    local = { ...local, ...JSON.parse(fs.readFileSync(DB_FILE, "utf8")) };
  }
} catch (err) {
  console.error("[Local] Could not read local-db.json, starting empty:", err.message);
  try { fs.renameSync(DB_FILE, `${DB_FILE}.broken-${Date.now()}`); } catch {}
}

function persist() {
  // Хуучин синк хийгдсэн бичлэгүүдийг тайрч, файл хэт томрохоос сэргийлнэ.
  for (const key of ["reports", "notifications"]) {
    const synced = local[key].filter((d) => d._synced);
    if (synced.length > MAX_CACHED_SYNCED) {
      synced.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      const keep = new Set(synced.slice(0, MAX_CACHED_SYNCED).map((d) => d._id));
      local[key] = local[key].filter((d) => !d._synced || keep.has(d._id));
    }
  }
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(local));
  fs.renameSync(tmp, DB_FILE);
}

// Локал кэшэд нэг баримт оруулах/шинэчлэх (synced = MongoDB-д аль хэдийн байгаа эсэх).
function upsertLocal(collection, doc, synced) {
  const list = local[collection];
  const i = list.findIndex((d) => d._id === doc._id);
  const entry = { ...stripMeta(doc), _synced: synced };
  if (i >= 0) list[i] = entry; else list.push(entry);
}

function cacheSafe(fn) {
  try { fn(); persist(); } catch (err) { console.warn("[Local] cache write failed:", err.message); }
}

// Энгийн шүүлтүүр: тэнцүү утга болон { $ne: x }.
function matches(doc, filter) {
  return Object.entries(filter || {}).every(([k, v]) => {
    if (v && typeof v === "object" && "$ne" in v) return doc[k] !== v.$ne;
    return doc[k] === v;
  });
}

function byNewest(a, b) {
  return new Date(b.createdAt) - new Date(a.createdAt);
}

// MongoDB-ийн үр дүн дээр хараахан синк хийгдээгүй локал бичлэгүүдийг нэмнэ.
function withUnsynced(collection, docs, filter, limit) {
  const ids = new Set(docs.map((d) => d._id));
  const extra = local[collection].filter((d) => !d._synced && !ids.has(d._id) && matches(d, filter)).map(stripMeta);
  if (!extra.length) return docs;
  const all = [...docs, ...extra].sort(byNewest);
  return limit ? all.slice(0, limit) : all;
}

// Mongoose схемээр баталгаажуулж, default утгуудыг онооно (MongoDB хэрэггүй).
async function buildLocalDoc(Model, data) {
  const doc = new Model(data);
  await doc.validate();
  const obj = plain(doc);
  const now = new Date().toISOString();
  obj.createdAt = obj.createdAt || now;
  obj.updatedAt = now;
  return obj;
}

// ─── Хэрэглэгчид (Users) ─────────────────────────────────────────────────────
async function findUserByEmployeeId(employeeId) {
  return run(
    async () => {
      const u = plain(await User.findOne({ employeeId }).lean());
      if (u) cacheSafe(() => upsertLocal("users", u, true));
      // Офлайн үед бүртгүүлж, хараахан синк хийгдээгүй хэрэглэгч
      return u || stripMeta(local.users.find((x) => x.employeeId === employeeId && !x._synced)) || null;
    },
    () => stripMeta(local.users.find((u) => u.employeeId === employeeId)) || null,
  );
}

async function createUser(data) {
  return run(
    async () => {
      const u = plain(await User.create(data));
      cacheSafe(() => upsertLocal("users", u, true));
      return u;
    },
    async () => {
      if (local.users.some((u) => u.employeeId === data.employeeId)) {
        const err = new Error("duplicate employeeId");
        err.code = 11000;
        throw err;
      }
      const u = await buildLocalDoc(User, data);
      upsertLocal("users", u, false);
      persist();
      return u;
    },
  );
}

async function findUsers(filter) {
  return run(
    async () => withUnsynced("users", plain(await User.find(filter).lean()), filter),
    () => local.users.filter((u) => matches(u, filter)).map(stripMeta),
  );
}

// ─── Тайлангууд (Reports) ────────────────────────────────────────────────────
async function createReport(data) {
  return run(
    async () => {
      const r = plain(await Report.create(data));
      cacheSafe(() => upsertLocal("reports", r, true));
      return r;
    },
    async () => {
      const r = await buildLocalDoc(Report, data);
      upsertLocal("reports", r, false);
      persist();
      return r;
    },
  );
}

async function updateReport(id, set) {
  return run(
    async () => {
      const r = plain(await Report.findByIdAndUpdate(id, { $set: set }, { new: true }).lean());
      if (r) cacheSafe(() => upsertLocal("reports", r, true));
      return r;
    },
    () => {
      const r = local.reports.find((d) => d._id === String(id));
      if (!r) return null;
      Object.assign(r, set, { updatedAt: new Date().toISOString(), _synced: false });
      persist();
      return stripMeta(r);
    },
  );
}

async function findReports(filter, limit = 100) {
  return run(
    async () => withUnsynced("reports", plain(await Report.find(filter).sort({ createdAt: -1 }).limit(limit).lean()), filter, limit),
    () => local.reports.filter((r) => matches(r, filter)).sort(byNewest).slice(0, limit).map(stripMeta),
  );
}

async function findReportByMedia(field, mediaId) {
  return run(
    async () => {
      if (!ObjectId.isValid(mediaId)) return null;
      return plain(await Report.findOne({ [field]: mediaId }).lean());
    },
    () => stripMeta(local.reports.find((r) => r[field] === String(mediaId))) || null,
  );
}

async function reportStats(filter) {
  const empty = { totalReports: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
  return run(
    async () => {
      const stats = await Report.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalReports: { $sum: 1 },
            criticalCount: { $sum: { $cond: [{ $eq: ["$severity", "critical"] }, 1, 0] } },
            highCount: { $sum: { $cond: [{ $eq: ["$severity", "high"] }, 1, 0] } },
            mediumCount: { $sum: { $cond: [{ $eq: ["$severity", "medium"] }, 1, 0] } },
            lowCount: { $sum: { $cond: [{ $eq: ["$severity", "low"] }, 1, 0] } },
          },
        },
      ]);
      return stats[0] || empty;
    },
    () => {
      const out = { _id: null, ...empty };
      for (const r of local.reports.filter((d) => matches(d, filter))) {
        out.totalReports++;
        if (r.severity === "critical") out.criticalCount++;
        else if (r.severity === "high") out.highCount++;
        else if (r.severity === "medium") out.mediumCount++;
        else if (r.severity === "low") out.lowCount++;
      }
      return out;
    },
  );
}

// ─── Мэдэгдлүүд (Notifications) ──────────────────────────────────────────────
async function insertNotifications(docs) {
  if (!docs.length) return [];
  return run(
    async () => {
      const saved = plain(await Notification.insertMany(docs));
      cacheSafe(() => saved.forEach((n) => upsertLocal("notifications", n, true)));
      return saved;
    },
    async () => {
      const saved = await Promise.all(docs.map((d) => buildLocalDoc(Notification, d)));
      saved.forEach((n) => upsertLocal("notifications", n, false));
      persist();
      return saved;
    },
  );
}

async function findNotifications(recipientPhone, limit = 100) {
  return run(
    async () => withUnsynced("notifications", plain(await Notification.find({ recipientPhone }).sort({ createdAt: -1 }).limit(limit).lean()), { recipientPhone }, limit),
    () => local.notifications.filter((n) => n.recipientPhone === recipientPhone).sort(byNewest).slice(0, limit).map(stripMeta),
  );
}

async function markNotificationRead(id) {
  return run(
    async () => {
      if (!ObjectId.isValid(id)) return;
      await Notification.findByIdAndUpdate(id, { read: true });
      cacheSafe(() => {
        const n = local.notifications.find((d) => d._id === String(id));
        if (n) n.read = true;
      });
    },
    () => {
      const n = local.notifications.find((d) => d._id === String(id));
      if (n) {
        n.read = true;
        n.updatedAt = new Date().toISOString();
        n._synced = false;
        persist();
      }
    },
  );
}

// ─── Зураг / Дуу (Media) ─────────────────────────────────────────────────────
// kind: "photos" | "audio"
function bucketFor(kind) {
  return kind === "photos" ? photoBucket : audioBucket;
}
function localMediaPaths(kind, id) {
  const base = path.join(MEDIA_DIR, kind, String(id));
  return { bin: `${base}.bin`, meta: `${base}.json` };
}

function uploadToBucket(bucket, id, buffer, filename, contentType, metadata) {
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStreamWithId(id, filename || "file", {
      contentType: contentType || "application/octet-stream",
      metadata: metadata || {},
    });
    Readable.from(buffer).pipe(stream)
      .on("error", reject)
      .on("finish", () => resolve(id));
  });
}

async function saveMedia(kind, buffer, filename, contentType, metadata) {
  const id = new ObjectId();
  return run(
    async () => {
      await uploadToBucket(bucketFor(kind), id, buffer, filename, contentType, metadata);
      return id.toHexString();
    },
    () => {
      const p = localMediaPaths(kind, id.toHexString());
      fs.writeFileSync(p.bin, buffer);
      fs.writeFileSync(p.meta, JSON.stringify({
        filename: filename || "file",
        contentType: contentType || "application/octet-stream",
        length: buffer.length,
        metadata: metadata || {},
        uploadDate: new Date().toISOString(),
      }));
      return id.toHexString();
    },
  );
}

async function linkMediaToReport(kind, mediaId, reportId) {
  if (!mediaId) return;
  const p = localMediaPaths(kind, mediaId);
  if (fs.existsSync(p.meta)) {
    const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
    meta.metadata = { ...(meta.metadata || {}), reportId: String(reportId) };
    fs.writeFileSync(p.meta, JSON.stringify(meta));
    return;
  }
  await run(
    () => mongoose.connection.db.collection(`${kind}.files`).updateOne(
      { _id: new ObjectId(mediaId) },
      { $set: { "metadata.reportId": new ObjectId(reportId) } },
    ),
    () => {},
  );
}

// Файлыг олж { contentType, length, stream } буцаана; олдохгүй бол null.
async function getMedia(kind, id) {
  if (!ObjectId.isValid(id)) return null;
  const p = localMediaPaths(kind, id);
  if (fs.existsSync(p.bin) && fs.existsSync(p.meta)) {
    const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
    return { contentType: meta.contentType, length: meta.length, stream: fs.createReadStream(p.bin) };
  }
  return run(
    async () => {
      const bucket = bucketFor(kind);
      const _id = new ObjectId(id);
      const files = await bucket.find({ _id }).toArray();
      if (!files.length) return null;
      return { contentType: files[0].contentType, length: files[0].length, stream: bucket.openDownloadStream(_id) };
    },
    () => null,
  );
}

// ─── Синк: Локал → MongoDB ───────────────────────────────────────────────────
async function syncMedia() {
  let count = 0;
  for (const kind of ["photos", "audio"]) {
    const dir = path.join(MEDIA_DIR, kind);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const id = file.replace(/\.json$/, "");
      const p = localMediaPaths(kind, id);
      if (!fs.existsSync(p.bin)) continue;
      const meta = JSON.parse(fs.readFileSync(p.meta, "utf8"));
      const metadata = { ...(meta.metadata || {}) };
      if (metadata.reportId && ObjectId.isValid(metadata.reportId)) metadata.reportId = new ObjectId(metadata.reportId);
      const _id = new ObjectId(id);
      const bucket = bucketFor(kind);
      const exists = await bucket.find({ _id }).limit(1).toArray();
      if (!exists.length) {
        await uploadToBucket(bucket, _id, fs.readFileSync(p.bin), meta.filename, meta.contentType, metadata);
      }
      fs.unlinkSync(p.bin);
      fs.unlinkSync(p.meta);
      count++;
    }
  }
  return count;
}

async function syncCollection(key) {
  const Model = MODELS[key];
  let count = 0;
  for (const doc of local[key].filter((d) => !d._synced)) {
    const raw = stripMeta(doc);
    if (key === "users") {
      // Ижил ажилтны дугаар MongoDB-д аль хэдийн байвал MongoDB-ийнхыг хадгална.
      const casted = new Model(raw).toObject();
      await Model.collection.updateOne({ employeeId: raw.employeeId }, { $setOnInsert: casted }, { upsert: true });
    } else {
      const casted = new Model(raw).toObject();
      casted.createdAt = new Date(raw.createdAt);
      casted.updatedAt = new Date(raw.updatedAt || raw.createdAt);
      await Model.collection.replaceOne({ _id: casted._id }, casted, { upsert: true });
    }
    doc._synced = true;
    count++;
  }
  return count;
}

// MongoDB-ээс сүүлийн өгөгдлийг татаж локал кэшийг шинэчилнэ (MongoDB унавал ашиглагдана).
async function refreshLocalCache() {
  const [users, reports, notifications] = await Promise.all([
    User.find({}).lean(),
    Report.find({}).sort({ createdAt: -1 }).limit(MAX_CACHED_SYNCED).lean(),
    Notification.find({}).sort({ createdAt: -1 }).limit(MAX_CACHED_SYNCED).lean(),
  ]);
  for (const [key, docs] of [["users", users], ["reports", reports], ["notifications", notifications]]) {
    const unsynced = new Set(local[key].filter((d) => !d._synced).map((d) => d._id));
    for (const d of plain(docs)) {
      if (!unsynced.has(d._id)) upsertLocal(key, d, true);
    }
  }
}

async function syncLocalToMongo() {
  if (syncing || !mongoReady()) return;
  syncing = true;
  try {
    const media = await syncMedia();
    const users = await syncCollection("users");
    const reports = await syncCollection("reports");
    const notifications = await syncCollection("notifications");
    await refreshLocalCache();
    persist();
    if (media + users + reports + notifications > 0) {
      console.log(`[Sync] Pushed local data to MongoDB — users: ${users}, reports: ${reports}, notifications: ${notifications}, media files: ${media}`);
    }
  } catch (err) {
    persist();
    console.warn("[Sync] Sync to MongoDB stopped, will retry on next reconnect:", err.message);
  } finally {
    syncing = false;
  }
}

function status() {
  const pending = ["users", "reports", "notifications"].reduce(
    (acc, k) => ({ ...acc, [k]: local[k].filter((d) => !d._synced).length }), {},
  );
  return {
    mode: mongoReady() ? "mongodb" : "local",
    mongoConfigured: !MONGO_DISABLED,
    pendingSync: pending,
  };
}

module.exports = {
  connectMongo,
  status,
  findUserByEmployeeId,
  createUser,
  findUsers,
  createReport,
  updateReport,
  findReports,
  findReportByMedia,
  reportStats,
  insertNotifications,
  findNotifications,
  markNotificationRead,
  saveMedia,
  linkMediaToReport,
  getMedia,
};
