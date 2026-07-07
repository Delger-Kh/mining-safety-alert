const express = require("express");
const multer = require("multer");
const cors = require("cors");
const Groq = require("groq-sdk");
const mongoose = require("mongoose");
const { GridFSBucket, ObjectId } = require("mongodb");
const twilio = require("twilio");
const crypto = require("crypto");
const { Readable } = require("stream");

const app = express();
const PORT = 3000;

// ─── MongoDB ───────────────────────────────────────────────────────────────
mongoose.set("strictQuery", true);

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/mine_safety";

let photoBucket, audioBucket;

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log("[DB] Connected to MongoDB:", MONGO_URI);
    // ── GridFS buckets: photos and audio are stored in their OWN
    // collections (photos.files/photos.chunks, audio.files/audio.chunks),
    // fully separate from the `reports` collection and from each other.
    // Reports only ever hold a reference (ObjectId) to the file, not the
    // binary itself — that's what keeps `reports` small and fast to query.
    const db = mongoose.connection.db;
    photoBucket = new GridFSBucket(db, { bucketName: "photos" });
    audioBucket = new GridFSBucket(db, { bucketName: "audio" });
  })
  .catch((err) => { console.error("[DB] Connection failed:", err.message); process.exit(1); });

// ─── GridFS helpers ──────────────────────────────────────────────────────────
// Uploads a buffer into the given bucket and resolves with the new file's ObjectId.
function uploadBufferToBucket(bucket, buffer, filename, mimeType, metadata) {
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename || "file", {
      contentType: mimeType || "application/octet-stream",
      metadata: metadata || {},
    });
    Readable.from(buffer).pipe(uploadStream)
      .on("error", reject)
      .on("finish", () => resolve(uploadStream.id));
  });
}

// Streams a stored file straight to an HTTP response (used by GET /api/media/*).
async function streamFileToResponse(bucket, id, res) {
  let _id;
  try {
    _id = new ObjectId(id);
  } catch {
    return res.status(400).json({ error: "Буруу ID." });
  }
  const files = await bucket.find({ _id }).toArray();
  if (files.length === 0) return res.status(404).json({ error: "Файл олдсонгүй." });

  const file = files[0];
  res.set("Content-Type", file.contentType || "application/octet-stream");
  res.set("Content-Length", file.length);
  bucket.openDownloadStream(_id)
    .on("error", () => res.status(404).end())
    .pipe(res);
}

// Writes the owning report's _id onto a GridFS file's metadata after the
// report is created (the file necessarily exists before the report does).
// This is what makes a stray file traceable back to its report — and is
// also what /api/history/:id/media-status and cascade-delete rely on.
async function linkMediaToReport(bucketName, mediaId, reportId) {
  if (!mediaId) return;
  await mongoose.connection.db.collection(`${bucketName}.files`).updateOne(
    { _id: mediaId },
    { $set: { "metadata.reportId": reportId } }
  );
}

// Deletes a GridFS file (both the .files doc and its .chunks) if it exists.
// Used for cascade-delete when a report is removed.
async function deleteMediaIfExists(bucket, mediaId) {
  if (!mediaId) return;
  try {
    await bucket.delete(mediaId);
  } catch (err) {
    // "FileNotFound" just means it was already gone — not worth failing over.
    console.warn(`[Media] Could not delete ${mediaId}:`, err.message);
  }
}

// ════════════════════════════════════════════════════════════════════
// SCHEMAS
// Every schema below gets: `timestamps` (adds a managed updatedAt
// alongside your existing createdAt), `versionKey: false` (drops the
// __v field so documents look clean in Compass), an explicit collection
// name (so it's obvious in Atlas which schema owns which collection),
// and indexes on whatever fields the routes below actually query/filter
// by — that's the part that was missing before and is what made the
// collections feel unorganized once they had more than a couple documents.
// ════════════════════════════════════════════════════════════════════

const reportSchema = new mongoose.Schema({
  // ── Media references only — NOT the binary data. The actual photo
  // lives in the `photos` GridFS bucket, the actual audio lives in the
  // `audio` GridFS bucket. This keeps `reports` documents tiny (fast to
  // list/sort/filter in /api/history) no matter how many/how large the
  // attached files are.
  photoMediaId: { type: mongoose.Schema.Types.ObjectId, default: null, ref: "photos.files" },
  audioMediaId: { type: mongoose.Schema.Types.ObjectId, default: null, ref: "audio.files" },

  // Denormalized copies of a few file facts so the frontend can render
  // a history row (name, size, whether a photo/audio exists at all)
  // without a second round-trip to GridFS.
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
  // ── NEW: records whether the image and voice/text classifications
  // disagreed with each other before being merged. Lets the review
  // screen or history list flag "AI sources disagreed" for a human to
  // double-check, instead of silently picking one side.
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

// Compound indexes matching the exact query shapes used by /api/history
// and the SMS/notification lookups — this is what actually makes reads
// fast and is what "organized" means at the database level.
reportSchema.index({ tsekh: 1, createdAt: -1 });
reportSchema.index({ reporterEmployeeId: 1, createdAt: -1 });
reportSchema.index({ alerted: 1, tsekh: 1, createdAt: -1 });
reportSchema.index({ isTestData: 1, createdAt: -1 });

const Report = mongoose.model("Report", reportSchema);

// ─── Users (login) ───────────────────────────────────────────────────────────
// role: "ажилтан" (employee), "tsekh_darga" (цехийн дарга), "hub_darga" (хаб-ын дарга)
const userSchema = new mongoose.Schema({
  name:       { type: String, default: "" },
  employeeId: {
    type: String,
    required: true,
    unique: true,
    match: [/^\d{5}$/, "Бүртгэлийн дугаар 5 оронтой тоо байх ёстой."],
  },
  phone:      { type: String, required: true }, // used only for SMS alerts, not for login
  role:       { type: String, enum: ["ажилтан", "tsekh_darga", "hub_darga"], default: "ажилтан", index: true },
  tsekh:      { type: String, default: "", index: true }, // employee's own цех / tsekh_darga's managed цех (hub_darga: not tied to one цех)
  createdAt:  { type: Date, default: Date.now },
}, {
  timestamps: { createdAt: "createdAt", updatedAt: "updatedAt" },
  versionKey: false,
  collection: "users",
});

// employeeId already gets a unique index from `unique: true` above.
// This compound index is what getResponsibleUsers() and role-based
// history filtering actually query by.
userSchema.index({ role: 1, tsekh: 1 });

const User = mongoose.model("User", userSchema);

const ROLE_MN = {
  "ажилтан":     "Ажилтан",
  "tsekh_darga": "Цехийн дарга",
  "hub_darga":   "Хаб-ын дарга",
};

// ─── Media access control ────────────────────────────────────────────────────
// Same visibility rules as /api/history: workers see only their own reports,
// tsekh_darga sees their own цех, hub_darga sees everything. Anyone hitting
// GET /api/media/* must identify themselves via ?requesterId=<employeeId>,
// and that identity is checked against the specific report the file belongs
// to — not just trusted blindly from the URL.
async function canAccessReport(report, requesterEmployeeId) {
  if (!report || !requesterEmployeeId) return false;
  const user = await User.findOne({ employeeId: requesterEmployeeId });
  if (!user) return false;
  if (user.role === "hub_darga") return true;
  if (user.role === "tsekh_darga") return user.tsekh === report.tsekh;
  return report.reporterEmployeeId === requesterEmployeeId; // ажилтан: own reports only
}

// ─── In-app notifications for supervisors ────────────────────────────────────
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

// Matches the exact query in GET /api/notifications/:phone (sorted by
// recency) and makes an "unread count" query cheap if you add one later.
notificationSchema.index({ recipientPhone: 1, createdAt: -1 });
notificationSchema.index({ recipientPhone: 1, read: 1 });

const Notification = mongoose.model("Notification", notificationSchema);

// ─── Цех → supervisor phone numbers (fallback if no users registered) ───────
const MY_TEST_NUMBER = "+97680509572";

const TSEKH_CONTACTS = {
  "Уурхай-1":       [MY_TEST_NUMBER],
  "Уурхай-2":       [MY_TEST_NUMBER],
  "Баяжуулах цех":  [MY_TEST_NUMBER],
  "Засварын цех":   [MY_TEST_NUMBER],
  "Цахилгааны цех": [MY_TEST_NUMBER],
  "Тээврийн цех":   [MY_TEST_NUMBER],
  "Агуулах":        [MY_TEST_NUMBER],
  "Администраци":   [MY_TEST_NUMBER],
};

// Finds who should be alerted for a given цех: the hub director (all цехs)
// plus that цех's own tsekh_darga. Falls back to the static test list if
// no users have been registered yet for that цех.
async function getResponsibleUsers(tsekh) {
  const [hubDargas, tsekhDargas] = await Promise.all([
    User.find({ role: "hub_darga" }),
    User.find({ role: "tsekh_darga", tsekh }),
  ]);
  const users = [...hubDargas, ...tsekhDargas];
  if (users.length === 0) {
    return (TSEKH_CONTACTS[tsekh] || [MY_TEST_NUMBER]).map((phone) => ({ phone, name: "", role: "" }));
  }
  return users.map((u) => ({ phone: u.phone, name: u.name, role: u.role }));
}

// ─── Twilio ─────────────────────────────────────────────────────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

function buildAlertMessage(tsekh, severity, hazardType) {
  const severityLabel = {
    low: "бага", medium: "дунд", high: "өндөр", critical: "яаралтай",
  }[severity] || severity;
  const short = `АЮУЛ: ${tsekh}. ${hazardType}. Түвшин: ${severityLabel}.`;
  return short.length <= 70 ? short : short.slice(0, 67) + "...";
}

async function sendSmsAlerts(numbers, tsekh, severity, hazardType) {
  if (!numbers || numbers.length === 0) {
    console.log(`[SMS] No contacts found for цех: ${tsekh}`);
    return { sent: [], failed: [] };
  }
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
    console.error("[SMS] Twilio env vars missing — cannot send.");
    return { sent: [], failed: numbers };
  }

  const message = buildAlertMessage(tsekh, severity, hazardType);
  console.log(`[SMS] Sending to ${numbers.length} number(s) for ${tsekh}...`);
  console.log(`[SMS] Message (${message.length} chars): ${message}`);

  const sent = [];
  const failed = [];
  for (const to of numbers) {
    try {
      const msg = await twilioClient.messages.create({ from: TWILIO_FROM, to, body: message });
      console.log(`[SMS] ✅ Sent to ${to} — SID: ${msg.sid}`);
      sent.push(to);
    } catch (err) {
      console.error(`[SMS] ❌ Failed to send to ${to} — code: ${err.code}, message: ${err.message}`);
      failed.push(to);
    }
  }
  return { sent, failed };
}

// Creates in-app notifications for hub/tsekh dargas (separate from SMS,
// so they still see it in the app even if the SMS failed or was skipped).
async function createNotifications(users, reportId, tsekh, severity, hazardType) {
  const severityLabel = severityMnBackend(severity);
  const message = `${tsekh}: ${hazardType} — ${severityLabel} аюул илэрлээ.`;
  const docs = users
    .filter((u) => u.phone)
    .map((u) => ({
      recipientPhone: u.phone,
      reportId,
      tsekh,
      severity,
      message,
    }));
  if (docs.length > 0) {
    await Notification.insertMany(docs);
  }
}

function severityMnBackend(severity) {
  return { low: "бага", medium: "дунд", high: "өндөр", critical: "яаралтай" }[severity] || severity;
}

// ─── Chimege (Mongolian Speech-to-Text) ──────────────────────────────────────
const CHIMEGE_TOKEN = process.env.CHIMEGE_TOKEN || "";
const CHIMEGE_URL = "https://api.chimege.com/v1.2/transcribe";

async function transcribeWithChimege(wavBuffer) {
  const response = await fetch(CHIMEGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "Token": CHIMEGE_TOKEN, "Punctuate": "true" },
    body: wavBuffer,
  });
  if (!response.ok) {
    const errorCode = response.headers.get("Error-Code");
    const bodyText = await response.text().catch(() => "");
    throw new Error(`Chimege error ${response.status} (code: ${errorCode}): ${bodyText}`);
  }
  return await response.text();
}

// ─── Groq ───────────────────────────────────────────────────────────────────
if (!process.env.GROQ_API_KEY) {
  console.error("\n[ERROR] GROQ_API_KEY is not set.\n");
  process.exit(1);
}
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── Upload guards ──────────────────────────────────────────────────────────
// 1) Size limits: memoryStorage() holds the whole file in RAM, so without a
//    cap a single bad/malicious upload could exhaust server memory.
// 2) fileFilter: rejects anything that isn't actually an image under the
//    "photo" field or actually audio under the "audio"/"chunk" field, so a
//    mislabeled or spoofed file never reaches Groq/Chimege or gets stored.


const MAX_PHOTO_AUDIO_BYTES = 20 * 1024 * 1024; // 20MB per file
const MAX_CHUNK_BYTES = 5 * 1024 * 1024;         // 5MB per live-caption chunk

const upload = multer({ storage: multer.memoryStorage() }).fields([
  { name: "photo", maxCount: 1 },
  { name: "audio", maxCount: 1 },
]);

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CHUNK_BYTES },
  fileFilter: (req, file, cb) => audioOnlyFilter(req, file, cb),
}).single("chunk");

// multer's fileFilter/limits errors land here (not in the normal try/catch
// inside route handlers), so give them a dedicated, friendly JSON response.
function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "Файлын хэмжээ хэтэрхий том байна." });
    }
    return res.status(400).json({ error: "Файл хуулахад алдаа гарлаа.", details: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message || "Файл хуулахад алдаа гарлаа." });
  }
  next();
}


app.use(cors());
app.use(express.json());

const HAZARD_TYPES = ["structural","electrical","fire_explosion","chemical_gas","equipment","fall_slip","ppe_violation","vehicle_traffic","other"];
const SEVERITY_LEVELS = ["low","medium","high","critical"];

const HAZARD_TYPE_MN = {
  structural: "Барилгын бүтцийн аюул",
  electrical: "Цахилгааны аюул",
  fire_explosion: "Гал/тэсэлгээний аюул",
  chemical_gas: "Хими/хийн аюул",
  equipment: "Тоног төхөөрөмжийн эвдрэл",
  fall_slip: "Унах/гулсах аюул",
  ppe_violation: "Хамгаалах хувцасгүй",
  vehicle_traffic: "Тээврийн хэрэгслийн аюул",
  other: "Бусад",
};

// ─── System prompt (Mongolian only, Korean/CJK explicitly forbidden) ──────────
const SYSTEM_PROMPT = `Чи уурхайн аюулгүй байдлын мэргэжилтэн. Ажилтны илгээсэн зураг болон/эсвэл дуут мэдэгдлийг шинжилж, аюулыг ангилна.

ЧУХАЛ ШААРДЛАГА: "reasoning" талбарыг ЗААВАЛ ЗӨВХӨН МОНГОЛ КИРИЛЛ ҮСГЭЭР бич.
ХОРИГЛОНО: Солонгос үсэг (한국어), Хятад үсэг (中文), Япон үсэг (日本語), латин үсэг ашиглахыг ХАТУУ ХОРИГЛОНО.
ЗӨВХӨН кирилл үсэг, цэг, таслал, тоо ашиглана.

Зааварчилгаа:
- "is_hazard" нь зөвхөн зураг/дуу нь бүрэн аюулгүй, хэвийн ажлын орчинг харуулж байгаа тохиолдолд л false байна.
- Түвшний удирдамж:
  - low: бага зэргийн асуудал, шууд аюул байхгүй
  - medium: удахгүй засах шаардлагатай
  - high: ноцтой эрсдэл, яаралтай анхаарал шаардлагатай
  - critical: амь насанд шууд аюултай, шуурхай арга хэмжээ авах шаардлагатай
- Эргэлзэж байвал илүү өндөр түвшинг сонго.
- "reasoning"-ийг 1-2 өгүүлбэрээр МОНГОЛ КИРИЛЛ ҮСГЭЭР бич.`;

// ─── Korean/CJK contamination filter ────────────────────────────────────────
function hasAsianScriptContamination(text) {
  return /[\uAC00-\uD7AF\u4E00-\u9FFF\u3040-\u30FF]/.test(text);
}

function cleanReasoning(text) {
  if (!text) return text;
  if (hasAsianScriptContamination(text)) {
    console.warn('[Classification] Korean/CJK detected in reasoning — stripping contamination');
    return text.replace(/[\uAC00-\uD7AF\u4E00-\u9FFF\u3040-\u30FF]+/g, '').replace(/\s+/g, ' ').trim();
  }
  return text;
}

// ═══════════════════════════════════════════════════════════════════════
// ── NEW: independent image/voice classification + deterministic merge ──
// The point: image and voice/text are now classified in TWO SEPARATE
// Groq calls, each blind to the other. Neither can dilute the other's
// judgment inside one shared prompt. The two results are then combined
// here, in plain code, with a fixed rule — never left to an LLM's own
// judgment call about who "wins" when they disagree.
// ═══════════════════════════════════════════════════════════════════════

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
function severityRank(s) { return SEVERITY_RANK[s] || 0; }

// Hard keyword floor — independent of what any LLM decides. If the
// transcript contains clear high-danger language, severity is never
// allowed to fall below "high", no matter what the model output was.
const CRITICAL_KEYWORDS = [
  "гал",             // fire
  "тэсрэ",           // explo(sion/de)
  "цахилгаан цохи",  // electric shock
  "нурсан",          // collapsed
  "нуран",           // collapsing
  "цус",             // blood
  "ухаангүй",        // unconscious
  "амьсгал",         // breathing (difficulty)
  "гарч чадахгүй",   // "can't get out" / trapped
  "хоргодох",        // trapped/stuck
  "яаралтай тусла",  // "help urgently"
];

function hasCriticalKeyword(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return CRITICAL_KEYWORDS.some((kw) => lower.includes(kw));
}

// Forces severity up to at least "high" if the transcript contains
// unambiguous danger language the model may have underrated.
function applyKeywordFloor(result, transcript) {
  if (hasCriticalKeyword(transcript) && severityRank(result.severity) < severityRank("high")) {
    console.warn("[Classification] Critical keyword detected in transcript — flooring severity to 'high'");
    return {
      ...result,
      is_hazard: true,
      severity: "high",
      reasoning: `${result.reasoning} [Автомат анхааруулга: дуут мэдэгдэлд аюултай түлхүүр үг илэрсэн тул түвшинг өсгөв.]`,
      severityFloored: true,
    };
  }
  return result;
}

// Merges an image-only result and a voice/text-only result into one
// final classification. Either argument can be null if that modality
// wasn't sent.
function mergeClassifications(imageResult, voiceResult, transcript) {
  if (imageResult && !voiceResult) return applyKeywordFloor(imageResult, transcript);
  if (voiceResult && !imageResult) return applyKeywordFloor(voiceResult, transcript);
  if (!imageResult && !voiceResult) {
    return { is_hazard: false, type: "other", severity: "low", reasoning: "Мэдээлэл ирээгүй.", confidence: 0 };
  }

  const imgRank = severityRank(imageResult.severity);
  const voiceRank = severityRank(voiceResult.severity);
  const conflicted =
    imageResult.is_hazard !== voiceResult.is_hazard ||
    Math.abs(imgRank - voiceRank) >= 2;

  // Deterministic rule: highest severity wins. Ties broken by is_hazard=true.
  let winner;
  if (imgRank !== voiceRank) {
    winner = imgRank > voiceRank ? imageResult : voiceResult;
  } else {
    winner = imageResult.is_hazard ? imageResult : voiceResult;
  }

  const merged = {
    is_hazard: imageResult.is_hazard || voiceResult.is_hazard,
    type: winner.type,
    severity: winner.severity,
    confidence: Math.min(imageResult.confidence ?? 1, voiceResult.confidence ?? 1),
    reasoning: conflicted
      ? `[Зураг] ${imageResult.reasoning} [Дуу/бичвэр] ${voiceResult.reasoning} — Анхаар: эх сурвалжууд зөрж байгаа тул илүү өндөр эрсдэлийг сонгов.`
      : `[Зураг] ${imageResult.reasoning} [Дуу/бичвэр] ${voiceResult.reasoning}`,
    sourcesConflicted: conflicted,
  };

  return applyKeywordFloor(merged, transcript);
}

async function classifyImageOnly(photoFile, schemaProps) {
  const base64Image = photoFile.buffer.toString("base64");
  const mimeType = photoFile.mimetype;
  const promptText = `${SYSTEM_PROMPT}\n\nЗөвхөн зургийг үндэслэн дүгнэлт гарга (дуут мэдэгдэл байхгүй гэж үзэж дүгнэ).\n\nЗөвхөн JSON форматаар хариул:\n${JSON.stringify(schemaProps)}`;

  const response = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: promptText },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } },
      ],
    }],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });
  const result = JSON.parse(response.choices[0].message.content);
  result.reasoning = cleanReasoning(result.reasoning);
  console.log("[Classification - image only]", result);
  return result;
}

async function classifyVoiceOnly(transcript, schemaProps) {
  const promptText = `${SYSTEM_PROMPT}\n\nЗураг алга. Ажилтан зөвхөн дуугаар дараах мэдэгдлийг өгсөн: "${transcript}"\n\nЗөвхөн JSON форматаар хариул:\n${JSON.stringify(schemaProps)}`;
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: promptText }],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });
  const result = JSON.parse(response.choices[0].message.content);
  result.reasoning = cleanReasoning(result.reasoning);
  console.log("[Classification - voice only]", result);
  return result;
}

// ─── In-memory draft store ───────────────────────────────────────────────────
// NOTE: this still holds raw buffers temporarily between /api/classify and
// /api/confirm (so the AI can look at the file before anything is written
// to the DB). The difference from before: once /api/confirm runs, the
// buffers now actually get persisted into GridFS instead of being thrown away.
const drafts = new Map();
const DRAFT_TTL_MS = 10 * 60 * 1000;

function saveDraft(data) {
  const id = crypto.randomUUID();
  drafts.set(id, { ...data, createdAt: Date.now() });
  setTimeout(() => drafts.delete(id), DRAFT_TTL_MS);
  return id;
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Mine Safety Backend is running."));

app.get("/api/tsekh", (req, res) => {
  res.json(Object.keys(TSEKH_CONTACTS));
});

// ─── Media: fetch stored photo / audio by id ─────────────────────────────────
// Frontend uses these to render the actual image / play the actual audio
// for a report (e.g. history_screen.dart, notifications_screen.dart),
// e.g. `${kBackendBase}/api/media/photo/<photoMediaId>?requesterId=<employeeId>`.
//
// requesterId is REQUIRED: without it, anyone with a link could pull any
// worker's hazard photo or voice recording. The same visibility rules as
// /api/history apply — see canAccessReport().
app.get("/api/media/photo/:id", async (req, res) => {
  try {
    const requesterId = req.query.requesterId || "";
    const report = await Report.findOne({ photoMediaId: req.params.id });
    if (!report) return res.status(404).json({ error: "Файл олдсонгүй." });

    const allowed = await canAccessReport(report, requesterId);
    if (!allowed) return res.status(403).json({ error: "Хандах эрхгүй." });

    await streamFileToResponse(photoBucket, req.params.id, res);
  } catch (err) {
    res.status(500).json({ error: "Зураг татахад алдаа гарлаа" });
  }
});

app.get("/api/media/audio/:id", async (req, res) => {
  try {
    const requesterId = req.query.requesterId || "";
    const report = await Report.findOne({ audioMediaId: req.params.id });
    if (!report) return res.status(404).json({ error: "Файл олдсонгүй." });

    const allowed = await canAccessReport(report, requesterId);
    if (!allowed) return res.status(403).json({ error: "Хандах эрхгүй." });

    await streamFileToResponse(audioBucket, req.params.id, res);
  } catch (err) {
    res.status(500).json({ error: "Дуу татахад алдаа гарлаа" });
  }
});

// ─── Auth: register + login (phone-based, no password — internal tool) ──────
app.post("/api/register", async (req, res) => {
  try {
    const { employeeId, phone, role, tsekh } = req.body || {};
const name = req.body?.name || `Ажилтан-${employeeId}`;
if (!employeeId || !phone || !role) {
  return res.status(400).json({ error: "Бүртгэлийн дугаар, утасны дугаар, албан тушаалыг бөглөнө үү." });
}
if (!/^\d{5}$/.test(employeeId)) {
  return res.status(400).json({ error: "Бүртгэлийн дугаар 5 оронтой тоо байх ёстой." });
}
    if (!["ажилтан", "tsekh_darga", "hub_darga"].includes(role)) {
      return res.status(400).json({ error: "Албан тушаал буруу байна." });
    }
    if (role !== "hub_darga" && !tsekh) {
      return res.status(400).json({ error: "Цехээ сонгоно уу." });
    }

    const existing = await User.findOne({ employeeId });
    if (existing) {
      return res.status(409).json({ error: "Энэ ажилтны дугаар аль хэдийн бүртгэгдсэн байна. Нэвтэрнэ үү." });
    }

    const user = await User.create({ name, employeeId, phone, role, tsekh: tsekh || "" });
    console.log(`[Auth] Registered: ${user.name} (${user.employeeId}, ${ROLE_MN[user.role]}, ${user.tsekh || "бүх цех"})`);
    res.json({
      _id: user._id, name: user.name, employeeId: user.employeeId, phone: user.phone,
      role: user.role, roleLabel: ROLE_MN[user.role], tsekh: user.tsekh,
    });
  } catch (err) {
    console.error("Error in /api/register:", err);
    res.status(500).json({ error: "Бүртгэхэд алдаа гарлаа", details: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { employeeId } = req.body || {};
    if (!employeeId) return res.status(400).json({ error: "Ажилтны дугаараа оруулна уу." });

    const user = await User.findOne({ employeeId });
    if (!user) {
      return res.status(404).json({ error: "Хэрэглэгч олдсонгүй. Эхлээд бүртгүүлнэ үү." });
    }
    console.log(`[Auth] Logged in: ${user.name} (${user.employeeId}, ${ROLE_MN[user.role]})`);
    res.json({
      _id: user._id, name: user.name, employeeId: user.employeeId, phone: user.phone,
      role: user.role, roleLabel: ROLE_MN[user.role], tsekh: user.tsekh,
    });
  } catch (err) {
    console.error("Error in /api/login:", err);
    res.status(500).json({ error: "Нэвтрэхэд алдаа гарлаа", details: err.message });
  }
});

// ─── In-app notifications (for хаб-ын дарга / цехийн дарга) ─────────────────
app.get("/api/notifications/:phone", async (req, res) => {
  try {
    const notifications = await Notification.find({ recipientPhone: req.params.phone })
      .sort({ createdAt: -1 }).limit(100);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.post("/api/notifications/:id/read", async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.id, { read: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update notification" });
  }
});

// POST /api/transcribe-chunk — live caption chunk endpoint
app.post("/api/transcribe-chunk", chunkUpload, handleUploadError, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Аудио хэсэг ирээгүй." });
    if (req.file.size < 2 * 1024) return res.json({ text: "" });

    try {
      const text = await transcribeWithChimege(req.file.buffer);
      console.log(`[Chunk] Transcribed: "${text}"`);
      res.json({ text: text.trim() });
    } catch (err) {
      console.warn(`[Chunk] Skipped: ${err.message}`);
      res.json({ text: "" });
    }
  } catch (err) {
    console.error("Error in /api/transcribe-chunk:", err);
    res.status(500).json({ error: "Failed", details: err.message });
  }
});

// POST /api/classify — AI classification only, no DB save, no SMS
app.post("/api/classify", upload, handleUploadError, async (req, res) => {
  try {
    const photoFile = req.files?.["photo"]?.[0];
    const audioFile = req.files?.["audio"]?.[0];
    const tsekh = req.body?.tsekh || "";
    const providedTranscript = req.body?.transcript || "";
    const reporterPhone = req.body?.reporterPhone || "";
    const reporterName = req.body?.reporterName || "";
    const reporterEmployeeId = req.body?.reporterEmployeeId || "";

    if (!photoFile && !audioFile && !providedTranscript) {
      return res.status(400).json({ error: "Зураг эсвэл дуу хоёрын аль нэгийг илгээнэ үү." });
    }
    if (!tsekh) {
      return res.status(400).json({ error: "Цехийг сонгоно уу." });
    }

    let transcript = providedTranscript;
    if (!transcript && audioFile) {
      console.log(`[Voice] Transcribing full audio: ${audioFile.size} bytes`);
      try {
        transcript = await transcribeWithChimege(audioFile.buffer);
        console.log("[Voice] Transcript:", transcript || "(EMPTY)");
      } catch (err) {
        console.error("[Voice] Chimege failed:", err.message);
      }
    }

    const schemaProps = {
      is_hazard:  { type: "boolean" },
      type:       { type: "string", enum: HAZARD_TYPES },
      severity:   { type: "string", enum: SEVERITY_LEVELS },
      reasoning:  { type: "string", description: "ЗААВАЛ МОНГОЛ КИРИЛЛ ҮСГЭЭР бичих" },
      confidence: { type: "number" },
    };

    // ── Independent classification: image and voice/text are judged
    // separately, then merged deterministically in code. See
    // mergeClassifications() above for the exact conflict-resolution rule.
    let imageResult = null;
    let voiceResult = null;

    if (photoFile) {
      imageResult = await classifyImageOnly(photoFile, schemaProps);
    }
    if (transcript) {
      voiceResult = await classifyVoiceOnly(transcript, schemaProps);
    }

    const result = mergeClassifications(imageResult, voiceResult, transcript);

    if (result.sourcesConflicted) {
      console.warn("[Classification] Sources conflicted — resolved to higher severity:", result);
    }

    // Keep the raw buffers (photo AND audio) in the draft so /api/confirm
    // can persist them into GridFS once the report is actually confirmed.
    const draftId = saveDraft({
      photoBuffer: photoFile?.buffer || null,
      photoMime: photoFile?.mimetype || null,
      photoName: photoFile?.originalname || null,
      audioBuffer: audioFile?.buffer || null,
      audioMime: audioFile?.mimetype || null,
      audioName: audioFile?.originalname || null,
      audioSize: audioFile?.size || 0,
      transcript,
      tsekh,
      reporterPhone,
      reporterName,
      reporterEmployeeId,
      aiResult: result,
    });

    res.json({
      draftId,
      is_hazard: result.is_hazard,
      type: result.type,
      typeLabel: HAZARD_TYPE_MN[result.type] || result.type,
      severity: result.severity,
      reasoning: result.reasoning,
      confidence: result.confidence,
      sourcesConflicted: !!result.sourcesConflicted,
      transcript,
      tsekh,
    });

  } catch (err) {
    console.error("Error in /api/classify:", err);
    res.status(500).json({ error: "Failed", details: err.message });
  }
});

// POST /api/confirm — save to DB (report + media in GridFS) + send SMS
app.post("/api/confirm", async (req, res) => {
  try {
    const { draftId, type, severity, reasoning } = req.body;

    if (!draftId || !drafts.has(draftId)) {
      return res.status(404).json({ error: "Драфт олдсонгүй эсвэл хугацаа дууссан. Дахин эхлэнэ үү." });
    }

    const draft = drafts.get(draftId);
    drafts.delete(draftId);

    const finalType = type || draft.aiResult.type;
    const finalSeverity = severity || draft.aiResult.severity;
    const finalReasoning = reasoning || draft.aiResult.reasoning;
    const wasEdited = finalType !== draft.aiResult.type || finalSeverity !== draft.aiResult.severity;
    const isHazard = draft.aiResult.is_hazard;

    const shouldAlert = isHazard && (finalSeverity === "high" || finalSeverity === "critical");
    let smsNumbers = [];
    let smsFailed = [];
    let responsibleUsers = [];
    if (shouldAlert) {
      const typeLabel = HAZARD_TYPE_MN[finalType] || finalType;
      responsibleUsers = await getResponsibleUsers(draft.tsekh);
      const smsResult = await sendSmsAlerts(
        responsibleUsers.map((u) => u.phone), draft.tsekh, finalSeverity, typeLabel
      );
      smsNumbers = smsResult.sent;
      smsFailed = smsResult.failed;
    }

    // ── Persist media into its own GridFS bucket, separate from the
    // report document and from each other. Only the resulting ObjectId
    // gets stored on the report.
    let photoMediaId = null;
    let audioMediaId = null;

    if (draft.photoBuffer) {
      photoMediaId = await uploadBufferToBucket(
        photoBucket, draft.photoBuffer, draft.photoName || "photo.jpg", draft.photoMime,
        { tsekh: draft.tsekh, reporterEmployeeId: draft.reporterEmployeeId }
      );
    }
    if (draft.audioBuffer) {
      audioMediaId = await uploadBufferToBucket(
        audioBucket, draft.audioBuffer, draft.audioName || "audio.wav", draft.audioMime,
        { tsekh: draft.tsekh, reporterEmployeeId: draft.reporterEmployeeId }
      );
    }

    const report = await Report.create({
      photoMediaId,
      audioMediaId,
      filename:   draft.photoName || draft.audioName || "voice_only",
      mimeType:   draft.photoMime || draft.audioMime || "audio",
      sizeBytes:  (draft.photoBuffer?.length || 0) + (draft.audioBuffer?.length || draft.audioSize || 0),
      is_hazard:  isHazard,
      type:       finalType,
      severity:   finalSeverity,
      reasoning:  finalReasoning,
      confidence: draft.aiResult.confidence,
      transcript: draft.transcript,
      tsekh:      draft.tsekh,
      alerted:    shouldAlert,
      smsNumbers,
      smsFailed,
      wasEdited,
      sourcesConflicted: !!draft.aiResult.sourcesConflicted,
      aiOriginal: { type: draft.aiResult.type, severity: draft.aiResult.severity },
      reporterPhone: draft.reporterPhone || "",
      reporterName:  draft.reporterName || "",
      reporterEmployeeId: draft.reporterEmployeeId || "",
    });

    if (shouldAlert && responsibleUsers.length > 0) {
      const typeLabel = HAZARD_TYPE_MN[finalType] || finalType;
      await createNotifications(responsibleUsers, report._id, draft.tsekh, finalSeverity, typeLabel);
    }

    // Now that the report exists, stamp its _id onto the media files'
    // metadata so a stray file in GridFS can always be traced back to
    // the report it belongs to (and so cascade-delete can find them by
    // reportId as a fallback even if the reference on `reports` is ever lost).
    await Promise.all([
      linkMediaToReport("photos", photoMediaId, report._id),
      linkMediaToReport("audio", audioMediaId, report._id),
    ]);

    console.log(`[DB] Report saved: ${report._id}${wasEdited ? " (edited)" : ""}`);

    res.json({
      _id: report._id,
      is_hazard: isHazard,
      type: finalType,
      severity: finalSeverity,
      reasoning: finalReasoning,
      transcript: draft.transcript,
      tsekh: draft.tsekh,
      alerted: shouldAlert,
      smsNumbers,
      smsFailed,
      wasEdited,
      sourcesConflicted: !!draft.aiResult.sourcesConflicted,
      photoUrl: photoMediaId ? `/api/media/photo/${photoMediaId}?requesterId=${draft.reporterEmployeeId || ""}` : null,
      audioUrl: audioMediaId ? `/api/media/audio/${audioMediaId}?requesterId=${draft.reporterEmployeeId || ""}` : null,
      createdAt: report.createdAt,
    });

  } catch (err) {
    console.error("Error in /api/confirm:", err);
    res.status(500).json({ error: "Failed", details: err.message });
  }
});

// GET history
// ── Replace your existing GET /api/history route with this ──────────────────
//
// Query params:
//   role              — "ажилтан" | "tsekh_darga" | "hub_darga"
//   reporterEmployeeId — required when role = "ажилтан"
//   tsekh              — required when role = "tsekh_darga"
//   limit              — optional, default 50
//   includeTestData    — optional, "true" to include old anonymous test reports
//
app.get("/api/history", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const role = req.query.role || "ажилтан";
    const includeTestData = req.query.includeTestData === "true";

    // Used to stamp ?requesterId=... onto photoUrl/audioUrl below, so the
    // frontend can fetch protected media without building the URL itself.
    // Send this from the app regardless of role — it's the logged-in
    // user's own employeeId, not necessarily the report's reporter.
    const requesterEmployeeId = req.query.requesterEmployeeId || req.query.reporterEmployeeId || "";

    let filter = {};

    if (role === "ажилтан") {
      // Workers see ONLY their own reports
      const employeeId = req.query.reporterEmployeeId || "";
      if (!employeeId) {
        return res.status(400).json({ error: "reporterEmployeeId шаардлагатай." });
      }
      filter.reporterEmployeeId = employeeId;

    } else if (role === "tsekh_darga") {
      // Цехийн дарга sees all reports from their цех
      const tsekh = req.query.tsekh || "";
      if (!tsekh) {
        return res.status(400).json({ error: "tsekh шаардлагатай." });
      }
      filter.tsekh = tsekh;

    } else if (role === "hub_darga") {
      // Хаб-ын дарга sees everything — no filter needed
      filter = {};
    }

    // By default exclude test data (old anonymous reports)
    if (!includeTestData) {
      filter.isTestData = { $ne: true };
    }

    const reports = await Report.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("-__v")
      .lean();

    // Attach convenience URLs so the frontend doesn't need to know
    // anything about GridFS or media IDs — just fetch these directly.
    const withUrls = reports.map((r) => ({
      ...r,
      photoUrl: r.photoMediaId ? `/api/media/photo/${r.photoMediaId}?requesterId=${requesterEmployeeId}` : null,
      audioUrl: r.audioMediaId ? `/api/media/audio/${r.audioMediaId}?requesterId=${requesterEmployeeId}` : null,
    }));

    res.json(withUrls);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

app.get("/api/history/:id", async (req, res) => {
  try {
    const requesterEmployeeId = req.query.requesterEmployeeId || "";
    const report = await Report.findById(req.params.id).select("-__v").lean();
    if (!report) return res.status(404).json({ error: "Not found" });
    res.json({
      ...report,
      photoUrl: report.photoMediaId ? `/api/media/photo/${report.photoMediaId}?requesterId=${requesterEmployeeId}` : null,
      audioUrl: report.audioMediaId ? `/api/media/audio/${report.audioMediaId}?requesterId=${requesterEmployeeId}` : null,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

// DELETE /api/history/:id — cascade delete: removes the report AND its
// associated photo/audio from GridFS (previously these would've been
// orphaned forever). Restricted to hub_darga since this is a destructive,
// org-wide action, not something an individual worker or tsekh_darga should
// be able to do to any report.
//
// Body: { requesterId: "<employeeId>" }
app.delete("/api/history/:id", async (req, res) => {
  try {
    const requesterId = req.body?.requesterId || req.query.requesterId || "";
    const requester = await User.findOne({ employeeId: requesterId });
    if (!requester || requester.role !== "hub_darga") {
      return res.status(403).json({ error: "Зөвхөн хаб-ын дарга устгах эрхтэй." });
    }

    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ error: "Мэдэгдэл олдсонгүй." });

    await Promise.all([
      deleteMediaIfExists(photoBucket, report.photoMediaId),
      deleteMediaIfExists(audioBucket, report.audioMediaId),
    ]);
    await Notification.deleteMany({ reportId: report._id });
    await Report.findByIdAndDelete(report._id);

    console.log(`[DB] Report deleted (cascade): ${report._id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in DELETE /api/history/:id:", err);
    res.status(500).json({ error: "Устгахад алдаа гарлаа", details: err.message });
  }
});

// GET /api/stats
app.get("/api/stats", async (req, res) => {
  try {
    const [total, hazards, bySeverity, byType, byTsekh] = await Promise.all([
      Report.countDocuments(),
      Report.countDocuments({ is_hazard: true }),
      Report.aggregate([{ $match: { is_hazard: true } }, { $group: { _id: "$severity", count: { $sum: 1 } } }]),
      Report.aggregate([{ $match: { is_hazard: true } }, { $group: { _id: "$type", count: { $sum: 1 } } }]),
      Report.aggregate([{ $group: { _id: "$tsekh", count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    ]);
    res.json({ total, hazards, bySeverity, byType, byTsekh });
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\nMine Safety Backend running on port ${PORT}`);
  console.log(`  Flow: /api/transcribe-chunk -> /api/classify -> /api/confirm\n`);
});