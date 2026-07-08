require("dotenv").config(); // .env файлыг хамгийн дээр уншуулна
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
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── MongoDB Холболт ────────────────────────────────────────────────────────
mongoose.set("strictQuery", true);

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/mine_safety";

let photoBucket, audioBucket;

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log("[DB] Connected to MongoDB:", MONGO_URI);
    const db = mongoose.connection.db;
    photoBucket = new GridFSBucket(db, { bucketName: "photos" });
    audioBucket = new GridFSBucket(db, { bucketName: "audio" });
  })
  .catch((err) => { 
    console.error("[DB] Connection failed:", err.message); 
    process.exit(1); 
  });

// ─── GridFS Туслах Функцууд ──────────────────────────────────────────────────
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

async function linkMediaToReport(bucketName, mediaId, reportId) {
  if (!mediaId) return;
  await mongoose.connection.db.collection(`${bucketName}.files`).updateOne(
    { _id: mediaId },
    { $set: { "metadata.reportId": reportId } }
  );
}

async function deleteMediaIfExists(bucket, mediaId) {
  if (!mediaId) return;
  try {
    await bucket.delete(mediaId);
  } catch (err) {
    console.warn(`[Media] Could not delete ${mediaId}:`, err.message);
  }
}

// ─── Схемүүд (Schemas & Indexes) ─────────────────────────────────────────────
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

const ROLE_MN = {
  "ажилтан":     "Ажилтан",
  "tsekh_darga": "Цехийн дарга",
  "hub_darga":   "Хаб-ын дарга",
};

async function canAccessReport(report, requesterEmployeeId) {
  if (!report || !requesterEmployeeId) return false;
  const user = await User.findOne({ employeeId: requesterEmployeeId });
  if (!user) return false;
  if (user.role === "hub_darga") return true;
  if (user.role === "tsekh_darga") return user.tsekh === report.tsekh;
  return report.reporterEmployeeId === requesterEmployeeId;
}

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

// ─── Цехийн холбоо барих мэдээлэл (Fallback) ───────────────────────────────────
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

// ─── Twilio SMS Тохиргоо ─────────────────────────────────────────────────────
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;

function buildAlertMessage(tsekh, severity, hazardType) {
  const severityLabel = { low: "бага", medium: "дунд", high: "өндөр", critical: "яаралтай" }[severity] || severity;
  const short = `АЮУЛ: ${tsekh}. ${hazardType}. Түвшин: ${severityLabel}.`;
  return short.length <= 70 ? short : short.slice(0, 67) + "...";
}

async function sendSmsAlerts(numbers, tsekh, severity, hazardType) {
  if (!numbers || numbers.length === 0) {
    console.log(`[SMS] No contacts found for цех: ${tsekh}`);
    return { sent: [], failed: [] };
  }
  if (!twilioClient || !TWILIO_FROM) {
    console.error("[SMS] Twilio env vars missing — skipping SMS.");
    return { sent: [], failed: numbers };
  }

  const message = buildAlertMessage(tsekh, severity, hazardType);
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

async function createNotifications(users, reportId, tsekh, severity, hazardType) {
  const severityLabel = { low: "бага", medium: "дунд", high: "өндөр", critical: "яаралтай" }[severity] || severity;
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

// ─── Chimege API (STT) ───────────────────────────────────────────────────────
const CHIMEGE_TOKEN = process.env.CHIMEGE_TOKEN || "";
const CHIMEGE_URL = "https://api.chimege.com/v1.2/transcribe";

async function transcribeWithChimege(wavBuffer) {
  if (!CHIMEGE_TOKEN) throw new Error("Chimege token missing.");
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

// ─── Groq SDK Тохиргоо ────────────────────────────────────────────────────────
if (!process.env.GROQ_API_KEY) {
  console.error("\n[ERROR] GROQ_API_KEY is not set.\n");
  process.exit(1);
}
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Multer Файл Хяналт ──────────────────────────────────────────────────────
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB Max
}).fields([
  { name: "photo", maxCount: 1 },
  { name: "audio", maxCount: 1 },
]);

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
}).single("chunk");

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

function cleanReasoning(text) {
  if (!text) return text;
  if (/[\uAC00-\uD7AF\u4E00-\u9FFF\u3040-\u30FF]/.test(text)) {
    return text.replace(/[\uAC00-\uD7AF\u4E00-\u9FFF\u3040-\u30FF]+/g, '').replace(/\s+/g, ' ').trim();
  }
  return text;
}

// ─── Ангилал Нэгтгэх Логик (Deterministic AI Merge) ──────────────────────────
const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
function severityRank(s) { return SEVERITY_RANK[s] || 0; }

const CRITICAL_KEYWORDS = ["гал", "тэсрэ", "цахилгаан цохи", "нурсан", "нуран", "цус", "ухаангүй", "амьсгал", "гарч чадахгүй", "хоргодох", "яаралтай тусла"];

function applyKeywordFloor(result, transcript) {
  if (!transcript) return result;
  const lower = transcript.toLowerCase();
  const hasKeyword = CRITICAL_KEYWORDS.some((kw) => lower.includes(kw));
  
  if (hasKeyword && severityRank(result.severity) < severityRank("high")) {
    return {
      ...result,
      is_hazard: true,
      severity: "high",
      reasoning: `${result.reasoning} [Автомат анхааруулга: дуут мэдэгдэлд аюултай түлхүүр үг илэрсэн тул түвшинг өсгөв.]`,
    };
  }
  return result;
}

function mergeClassifications(imageResult, voiceResult, transcript) {
  if (imageResult && !voiceResult) return applyKeywordFloor(imageResult, transcript);
  if (voiceResult && !imageResult) return applyKeywordFloor(voiceResult, transcript);
  if (!imageResult && !voiceResult) {
    return { is_hazard: false, type: "other", severity: "low", reasoning: "Мэдээлэл ирээгүй.", confidence: 0 };
  }

  const imgRank = severityRank(imageResult.severity);
  const voiceRank = severityRank(voiceResult.severity);
  const conflicted = imageResult.is_hazard !== voiceResult.is_hazard || Math.abs(imgRank - voiceRank) >= 2;

  let winner = imgRank > voiceRank ? imageResult : (imgRank < voiceRank ? voiceResult : (imageResult.is_hazard ? imageResult : voiceResult));

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
  const promptText = `${SYSTEM_PROMPT}\n\nЗөвхөн зургийг үндэслэн дүгнэлт гарга. JSON-оор хариул:\n${JSON.stringify(schemaProps)}`;

  const response = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: promptText },
        { type: "image_url", image_url: { url: `data:${photoFile.mimetype};base64,${base64Image}` } },
      ],
    }],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });
  const result = JSON.parse(response.choices[0].message.content);
  result.reasoning = cleanReasoning(result.reasoning);
  return result;
}

async function classifyVoiceOnly(transcript, schemaProps) {
  const promptText = `${SYSTEM_PROMPT}\n\nАжилтан зөвхөн дуугаар мэдэгдсэн: "${transcript}". JSON-оор хариул:\n${JSON.stringify(schemaProps)}`;
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "user", content: promptText }],
    response_format: { type: "json_object" },
    temperature: 0.2,
  });
  const result = JSON.parse(response.choices[0].message.content);
  result.reasoning = cleanReasoning(result.reasoning);
  return result;
}

// ─── Түр санах ойн Draft Store ────────────────────────────────────────────────
const drafts = new Map();
const DRAFT_TTL_MS = 10 * 60 * 1000;

function saveDraft(data) {
  const id = crypto.randomUUID();
  drafts.set(id, { ...data, createdAt: Date.now() });
  setTimeout(() => drafts.delete(id), DRAFT_TTL_MS);
  return id;
}

// ─── API Эндпойнтууд (API Endpoints) ──────────────────────────────────────────
app.get("/", (req, res) => res.send("Mine Safety Backend is running."));

app.get("/api/tsekh", (req, res) => res.json(Object.keys(TSEKH_CONTACTS)));

app.get("/api/media/photo/:id", async (req, res) => {
  try {
    const requesterId = req.query.requesterId || "";
    const report = await Report.findOne({ photoMediaId: req.params.id });
    if (!report) return res.status(404).json({ error: "Файл олдсонгүй." });
    if (!(await canAccessReport(report, requesterId))) return res.status(403).json({ error: "Хандах эрхгүй." });

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
    if (!(await canAccessReport(report, requesterId))) return res.status(403).json({ error: "Хандах эрхгүй." });

    await streamFileToResponse(audioBucket, req.params.id, res);
  } catch (err) {
    res.status(500).json({ error: "Дуу татахад алдаа гарлаа" });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { employeeId, phone, role, tsekh } = req.body || {};
    const name = req.body?.name || `Ажилтан-${employeeId}`;
    if (!employeeId || !phone || !role) return res.status(400).json({ error: "Бүртгэлийн дугаар, утасны дугаар, албан тушаалыг бөглөнө үү." });
    if (!/^\d{5}$/.test(employeeId)) return res.status(400).json({ error: "Бүртгэлийн дугаар 5 оронтой тоо байх ёстой." });
    if (!["ажилтан", "tsekh_darga", "hub_darga"].includes(role)) return res.status(400).json({ error: "Албан тушаал буруу байна." });
    if (role !== "hub_darga" && !tsekh) return res.status(400).json({ error: "Цехээ сонгоно уу." });

    const existing = await User.findOne({ employeeId });
    if (existing) return res.status(409).json({ error: "Энэ ажилтны дугаар бүртгэгдсэн байна." });

    const user = await User.create({ name, employeeId, phone, role, tsekh: tsekh || "" });
    res.json({ _id: user._id, name: user.name, employeeId: user.employeeId, phone: user.phone, role: user.role, roleLabel: ROLE_MN[user.role], tsekh: user.tsekh });
  } catch (err) {
    res.status(500).json({ error: "Бүртгэхэд алдаа гарлаа", details: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { employeeId } = req.body || {};
    if (!employeeId) return res.status(400).json({ error: "Ажилтны дугаараа оруулна уу." });

    const user = await User.findOne({ employeeId });
    if (!user) return res.status(404).json({ error: "Хэрэглэгч олдсонгүй. Эхлээд бүртгүүлнэ үү." });
    res.json({ _id: user._id, name: user.name, employeeId: user.employeeId, phone: user.phone, role: user.role, roleLabel: ROLE_MN[user.role], tsekh: user.tsekh });
  } catch (err) {
    res.status(500).json({ error: "Нэвтрэхэд алдаа гарлаа" });
  }
});

app.get("/api/notifications/:phone", async (req, res) => {
  try {
    const notifications = await Notification.find({ recipientPhone: req.params.phone }).sort({ createdAt: -1 }).limit(100);
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

app.post("/api/transcribe-chunk", chunkUpload, handleUploadError, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Аудио хэсэг ирээгүй." });
    if (req.file.size < 2 * 1024) return res.json({ text: "" });

    try {
      const text = await transcribeWithChimege(req.file.buffer);
      res.json({ text: text.trim() });
    } catch (err) {
      res.json({ text: "" });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed", details: err.message });
  }
});

// POST /api/classify — AI Шинжилгээ (Баазад хадгалахгүй, SMS явуулахгүй)
app.post("/api/classify", upload, handleUploadError, async (req, res) => {
  try {
    const photoFile = req.files?.["photo"]?.[0];
    const audioFile = req.files?.["audio"]?.[0];
    const tsekh = req.body?.tsekh || "";
    const providedTranscript = req.body?.transcript || "";
    const reporterPhone = req.body?.reporterPhone || "";
    const reporterName = req.body?.reporterName || "";
    const reporterEmployeeId = req.body?.reporterEmployeeId || "";

    if (!photoFile && !audioFile && !providedTranscript) return res.status(400).json({ error: "Зураг эсвэл дуу илгээнэ үү." });
    if (!tsekh) return res.status(400).json({ error: "Цехийг сонгоно уу." });

    let transcript = providedTranscript;
    if (!transcript && audioFile) {
      try {
        transcript = await transcribeWithChimege(audioFile.buffer);
      } catch (err) {
        console.error("[Voice] Chimege failed:", err.message);
      }
    }

    const schemaProps = {
      is_hazard:  { type: "boolean" },
      type:       { type: "string", enum: HAZARD_TYPES },
      severity:   { type: "string", enum: SEVERITY_LEVELS },
      reasoning:  { type: "string" },
      confidence: { type: "number" },
    };

    let imageResult = null;
    let voiceResult = null;

    if (photoFile) imageResult = await classifyImageOnly(photoFile, schemaProps);
    if (transcript) voiceResult = await classifyVoiceOnly(transcript, schemaProps);

    const result = mergeClassifications(imageResult, voiceResult, transcript);

    const draftId = saveDraft({
      photo: photoFile ? { buffer: photoFile.buffer, originalname: photoFile.originalname, mimetype: photoFile.mimetype } : null,
      audio: audioFile ? { buffer: audioFile.buffer, originalname: audioFile.originalname, mimetype: audioFile.mimetype } : null,
      classification: result,
      transcript: transcript,
      tsekh: tsekh,
      reporterPhone: reporterPhone,
      reporterName: reporterName,
      reporterEmployeeId: reporterEmployeeId,
      isTestData: req.body?.isTestData === "true",
    });

    res.json({ draftId, ...result, transcript });
  } catch (err) {
    console.error("Error in /api/classify:", err);
    res.status(500).json({ error: "Шинжилгээ хийхэд алдаа гарлаа." });
  }
});

// POST /api/confirm — Баталгаажуулалт (Файлыг GridFS рүү хадгалж, SMS гаргана)
app.post("/api/confirm", async (req, res) => {
  try {
    const { draftId, type, severity, reasoning, is_hazard, wasEdited } = req.body || {};
    if (!draftId) return res.status(400).json({ error: "Draft ID шаардлагатай." });

    const draft = drafts.get(draftId);
    if (!draft) return res.status(410).json({ error: "Хүсэлтийн хугацаа дууссан байна." });

    let photoMediaId = null;
    let audioMediaId = null;

    if (draft.photo && photoBucket) {
      photoMediaId = await uploadBufferToBucket(photoBucket, draft.photo.buffer, draft.photo.originalname, draft.photo.mimetype, { reporterEmployeeId: draft.reporterEmployeeId });
    }
    if (draft.audio && audioBucket) {
      audioMediaId = await uploadBufferToBucket(audioBucket, draft.audio.buffer, draft.audio.originalname, draft.audio.mimetype, { reporterEmployeeId: draft.reporterEmployeeId });
    }

    const newReport = await Report.create({
      photoMediaId,
      audioMediaId,
      filename: draft.photo?.originalname || draft.audio?.originalname || "media",
      mimeType: draft.photo?.mimetype || draft.audio?.mimetype || "application/octet-stream",
      sizeBytes: (draft.photo?.buffer?.length || 0) + (draft.audio?.buffer?.length || 0),
      is_hazard: is_hazard ?? draft.classification.is_hazard,
      type: type || draft.classification.type,
      severity: severity || draft.classification.severity,
      reasoning: reasoning || draft.classification.reasoning,
      confidence: draft.classification.confidence,
      transcript: draft.transcript,
      tsekh: draft.tsekh,
      wasEdited: wasEdited || false,
      sourcesConflicted: draft.classification.sourcesConflicted || false,
      aiOriginal: { type: draft.classification.type, severity: draft.classification.severity },
      reporterPhone: draft.reporterPhone,
      reporterName: draft.reporterName,
      reporterEmployeeId: draft.reporterEmployeeId,
      isTestData: draft.isTestData,
    });

    if (photoMediaId) await linkMediaToReport("photos", photoMediaId, newReport._id);
    if (audioMediaId) await linkMediaToReport("audio", audioMediaId, newReport._id);

    const targetUsers = await getResponsibleUsers(draft.tsekh);
    const targetPhones = targetUsers.map((u) => u.phone);

    let smsStatus = { sent: [], failed: [] };
    const shouldSendSms = ["high", "critical"].includes(newReport.severity) && !draft.isTestData;
    
    if (shouldSendSms) {
      smsStatus = await sendSmsAlerts(targetPhones, newReport.tsekh, newReport.severity, HAZARD_TYPE_MN[newReport.type] || newReport.type);
      newReport.alerted = smsStatus.sent.length > 0;
      newReport.smsNumbers = smsStatus.sent;
      newReport.smsFailed = smsStatus.failed;
      await newReport.save();
    }

    await createNotifications(targetUsers, newReport._id, newReport.tsekh, newReport.severity, HAZARD_TYPE_MN[newReport.type] || newReport.type);
    drafts.delete(draftId);

    res.json({ success: true, reportId: newReport._id, smsSent: newReport.alerted, smsDetails: smsStatus });
  } catch (err) {
    console.error("Error in /api/confirm:", err);
    res.status(500).json({ error: "Баталгаажуулахад алдаа гарлаа." });
  }
});

// GET /api/history — Түүх харах
app.get("/api/history", async (req, res) => {
  try {
    const { requesterId } = req.query;
    if (!requesterId) return res.status(400).json({ error: "requesterId шаардлагатай." });

    const user = await User.findOne({ employeeId: requesterId });
    if (!user) return res.status(404).json({ error: "Хэрэглэгч олдсонгүй." });

    let query = {};
    if (user.role === "tsekh_darga") query.tsekh = user.tsekh;
    else if (user.role === "ажилтан") query.reporterEmployeeId = user.employeeId;

    const reports = await Report.find(query).sort({ createdAt: -1 }).limit(100);
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: "Түүх ачаалахад алдаа гарлаа." });
  }
});

// GET /api/stats — Дашбордын тоо
app.get("/api/stats", async (req, res) => {
  try {
    const { requesterId } = req.query;
    if (!requesterId) return res.status(400).json({ error: "requesterId шаардлагатай." });

    const user = await User.findOne({ employeeId: requesterId });
    if (!user) return res.status(404).json({ error: "Хэрэглэгч олдсонгүй." });

    let matchStage = {};
    if (user.role === "tsekh_darga") matchStage.tsekh = user.tsekh;
    else if (user.role === "ажилтан") matchStage.reporterEmployeeId = user.employeeId;

    const stats = await Report.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: null,
          totalReports: { $sum: 1 },
          criticalCount: { $sum: { $cond: [{ $eq: ["$severity", "critical"] }, 1, 0] } },
          highCount: { $sum: { $cond: [{ $eq: ["$severity", "high"] }, 1, 0] } },
          mediumCount: { $sum: { $cond: [{ $eq: ["$severity", "medium"] }, 1, 0] } },
          lowCount: { $sum: { $cond: [{ $eq: ["$severity", "low"] }, 1, 0] } },
        }
      }
    ]);

    const defaultStats = { totalReports: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
    res.json(stats[0] || defaultStats);
  } catch (err) {
    res.status(500).json({ error: "Статистик авахад алдаа гарлаа." });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Mining Alert backend running on port ${PORT}`);
});