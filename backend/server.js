const express = require("express");
const multer = require("multer");
const cors = require("cors");
const Groq = require("groq-sdk");
const mongoose = require("mongoose");
const twilio = require("twilio");
const crypto = require("crypto");

const app = express();
const PORT = 3000;

// ─── MongoDB ───────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/mine_safety";
mongoose.connect(MONGO_URI)
  .then(() => console.log("[DB] Connected to MongoDB:", MONGO_URI))
  .catch((err) => { console.error("[DB] Connection failed:", err.message); process.exit(1); });

const reportSchema = new mongoose.Schema({
  filename:   { type: String },
  mimeType:   { type: String },
  sizeBytes:  { type: Number },
  is_hazard:  { type: Boolean, required: true },
  type:       { type: String, default: "" },
  severity:   { type: String, default: "" },
  reasoning:  { type: String },
  confidence: { type: Number },
  transcript: { type: String, default: "" },
  tsekh:      { type: String, default: "" },
  alerted:    { type: Boolean, default: false },
  smsNumbers: [{ type: String }],
  smsFailed:  [{ type: String }],
  wasEdited:  { type: Boolean, default: false },
  aiOriginal: {
    type:     { type: String },
    severity: { type: String },
  },
  reporterPhone: { type: String, default: "" },
  reporterName:  { type: String, default: "" },
  reporterEmployeeId: { type: String, default: "" },
  createdAt:  { type: Date, default: Date.now },
});
const Report = mongoose.model("Report", reportSchema);

// ─── Users (login) ───────────────────────────────────────────────────────────
// role: "ажилтан" (employee), "tsekh_darga" (цехийн дарга), "hub_darga" (хаб-ын дарга)
const userSchema = new mongoose.Schema({
  name:       { type: String, required: true },
  employeeId: { type: String, required: true, unique: true }, // internal ID the person types in to log in
  phone:      { type: String, required: true }, // used only for SMS alerts, not for login
  role:       { type: String, enum: ["ажилтан", "tsekh_darga", "hub_darga"], default: "ажилтан" },
  tsekh:      { type: String, default: "" }, // employee's own цех / tsekh_darga's managed цех (hub_darga: not tied to one цех)
  createdAt:  { type: Date, default: Date.now },
});
const User = mongoose.model("User", userSchema);

const ROLE_MN = {
  "ажилтан":     "Ажилтан",
  "tsekh_darga": "Цехийн дарга",
  "hub_darga":   "Хаб-ын дарга",
};

// ─── In-app notifications for supervisors ────────────────────────────────────
const notificationSchema = new mongoose.Schema({
  recipientPhone: { type: String, required: true },
  reportId:       { type: mongoose.Schema.Types.ObjectId, ref: "Report" },
  tsekh:          { type: String, default: "" },
  severity:       { type: String, default: "" },
  message:        { type: String, default: "" },
  read:           { type: Boolean, default: false },
  createdAt:      { type: Date, default: Date.now },
});
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

const upload = multer({ storage: multer.memoryStorage() }).fields([
  { name: "photo", maxCount: 1 },
  { name: "audio", maxCount: 1 },
]);
const chunkUpload = multer({ storage: multer.memoryStorage() }).single("chunk");

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
- Хэрэв зураг, дуут мэдэгдэл хоёулаа байгаа бол хоёуланг нь хослуулж дүгнэлт гарга.
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

// ─── In-memory draft store ───────────────────────────────────────────────────
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

// ─── Auth: register + login (phone-based, no password — internal tool) ──────
app.post("/api/register", async (req, res) => {
  try {
    const { name, employeeId, phone, role, tsekh } = req.body || {};
    if (!name || !employeeId || !phone || !role) {
      return res.status(400).json({ error: "Нэр, ажилтны дугаар, утасны дугаар, албан тушаалыг бөглөнө үү." });
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
app.post("/api/transcribe-chunk", chunkUpload, async (req, res) => {
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
app.post("/api/classify", upload, async (req, res) => {
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

    let result = {
      is_hazard: false, type: "other", severity: "low",
      reasoning: "Мэдээлэл ирээгүй.", confidence: 0,
    };

    const schemaProps = {
      is_hazard:  { type: "boolean" },
      type:       { type: "string", enum: HAZARD_TYPES },
      severity:   { type: "string", enum: SEVERITY_LEVELS },
      reasoning:  { type: "string", description: "ЗААВАЛ МОНГОЛ КИРИЛЛ ҮСГЭЭР бичих" },
      confidence: { type: "number" },
    };

    if (photoFile) {
      const base64Image = photoFile.buffer.toString("base64");
      const mimeType = photoFile.mimetype;
      const promptText = transcript
        ? `${SYSTEM_PROMPT}\n\nАжилтны дуут мэдэгдэл: "${transcript}"\nЭнэ мэдээллийг зурагтай хослуулан ашиглаж дүгнэлт гарга.\n\nЗөвхөн JSON форматаар хариул:\n${JSON.stringify(schemaProps)}`
        : `${SYSTEM_PROMPT}\n\nЗөвхөн JSON форматаар хариул:\n${JSON.stringify(schemaProps)}`;

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
      result = JSON.parse(response.choices[0].message.content);
      // ── Fix Korean/CJK contamination ──
      result.reasoning = cleanReasoning(result.reasoning);
      console.log("[Classification - image]", result);

    } else if (transcript) {
      const promptText = `${SYSTEM_PROMPT}\n\nЗураг алга. Ажилтан зөвхөн дуугаар дараах мэдэгдлийг өгсөн: "${transcript}"\n\nЗөвхөн JSON форматаар хариул:\n${JSON.stringify(schemaProps)}`;
      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: promptText }],
        response_format: { type: "json_object" },
        temperature: 0.2,
      });
      result = JSON.parse(response.choices[0].message.content);
      // ── Fix Korean/CJK contamination ──
      result.reasoning = cleanReasoning(result.reasoning);
      console.log("[Classification - voice only]", result);
    }

    const draftId = saveDraft({
      photoBuffer: photoFile?.buffer || null,
      photoMime: photoFile?.mimetype || null,
      photoName: photoFile?.originalname || null,
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
      transcript,
      tsekh,
    });

  } catch (err) {
    console.error("Error in /api/classify:", err);
    res.status(500).json({ error: "Failed", details: err.message });
  }
});

// POST /api/confirm — save to DB + send SMS
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

    const report = await Report.create({
      filename:   draft.photoName || "voice_only",
      mimeType:   draft.photoMime || "audio",
      sizeBytes:  (draft.photoBuffer?.length || 0) + draft.audioSize,
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
      aiOriginal: { type: draft.aiResult.type, severity: draft.aiResult.severity },
      reporterPhone: draft.reporterPhone || "",
      reporterName:  draft.reporterName || "",
      reporterEmployeeId: draft.reporterEmployeeId || "",
    });

    if (shouldAlert && responsibleUsers.length > 0) {
      const typeLabel = HAZARD_TYPE_MN[finalType] || finalType;
      await createNotifications(responsibleUsers, report._id, draft.tsekh, finalSeverity, typeLabel);
    }

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
      createdAt: report.createdAt,
    });

  } catch (err) {
    console.error("Error in /api/confirm:", err);
    res.status(500).json({ error: "Failed", details: err.message });
  }
});

// GET history
app.get("/api/history", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const filter = {};
    if (req.query.reporterPhone) filter.reporterPhone = req.query.reporterPhone;
    if (req.query.reporterEmployeeId) filter.reporterEmployeeId = req.query.reporterEmployeeId;
    const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(limit).select("-__v");
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

app.get("/api/history/:id", async (req, res) => {
  try {
    const report = await Report.findById(req.params.id).select("-__v");
    if (!report) return res.status(404).json({ error: "Not found" });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: "Failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`\nMine Safety Backend running on port ${PORT}`);
  console.log(`  Flow: /api/transcribe-chunk -> /api/classify -> /api/confirm\n`);
});