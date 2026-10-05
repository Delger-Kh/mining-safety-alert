require("dotenv").config(); // .env файлыг хамгийн дээр уншуулна
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const Groq = require("groq-sdk");
const twilio = require("twilio");
const crypto = require("crypto");
const store = require("./store");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ─── Өгөгдлийн сан ───────────────────────────────────────────────────────────
// MongoDB байхгүй/тасарсан үед сервер унахгүй — store.js локал файл руу шилжиж,
// MongoDB эргэж холбогдоход өгөгдлийг автоматаар синк хийнэ.
store.connectMongo();

async function streamMediaToResponse(kind, id, res) {
  const file = await store.getMedia(kind, id);
  if (!file) return res.status(404).json({ error: "Файл олдсонгүй." });
  res.set("Content-Type", file.contentType || "application/octet-stream");
  if (file.length != null) res.set("Content-Length", file.length);
  file.stream.on("error", () => res.status(404).end()).pipe(res);
}

const ROLE_MN = {
  "ажилтан":     "Ажилтан",
  "tsekh_darga": "Цехийн дарга",
  "hub_darga":   "Хаб-ын дарга",
};

async function canAccessReport(report, requesterEmployeeId) {
  if (!report || !requesterEmployeeId) return false;
  const user = await store.findUserByEmployeeId(requesterEmployeeId);
  if (!user) return false;
  if (user.role === "hub_darga") return true;
  if (user.role === "tsekh_darga") return user.tsekh === report.tsekh;
  return report.reporterEmployeeId === requesterEmployeeId;
}

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
    store.findUsers({ role: "hub_darga" }),
    store.findUsers({ role: "tsekh_darga", tsekh }),
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
// SMS_MODE=simulate → SMS бодитоор илгээхгүй, зөвхөн "илгээх байсан" гэж бүртгэнэ (Twilio-гүй туршилт/демо).
const SMS_MODE = (process.env.SMS_MODE || "twilio").toLowerCase();
if (SMS_MODE === "simulate") console.warn("[SMS] SMS_MODE=simulate — SMS will NOT really be sent (demo mode).");

function buildAlertMessage(tsekh, severity, hazardType) {
  const severityLabel = { low: "бага", medium: "дунд", high: "өндөр", critical: "яаралтай" }[severity] || severity;
  const short = `АЮУЛ: ${tsekh}. ${hazardType}. Түвшин: ${severityLabel}.`;
  return short.length <= 70 ? short : short.slice(0, 67) + "...";
}

// Twilio зөвхөн олон улсын форматтай (+976XXXXXXXX) дугаар хүлээн авна.
// "99112233", "976 9911 2233", "0097699112233" гэх мэтийг +97699112233 болгоно.
function toE164(phone) {
  if (!phone) return "";
  let p = String(phone).replace(/[\s\-()]/g, "");
  if (p.startsWith("00")) p = "+" + p.slice(2);
  if (/^\d{8}$/.test(p)) return "+976" + p;          // Монгол 8 оронтой дугаар
  if (/^976\d{8}$/.test(p)) return "+" + p;
  return p.startsWith("+") ? p : "+" + p;
}

// Twilio-ийн түгээмэл алдааны кодыг ойлгомжтой тайлбар болгоно.
const TWILIO_ERROR_HINTS = {
  20003: "Twilio данс идэвхгүй эсвэл SID/Auth Token буруу байна.",
  21211: "Хүлээн авагчийн дугаар буруу форматтай байна.",
  21408: "Twilio дээр Монгол руу SMS илгээх зөвшөөрөл идэвхгүй байна (Messaging → Settings → Geo permissions → Mongolia).",
  21608: "Twilio trial данс: энэ дугаарыг Twilio дээр Verified Caller ID болгож баталгаажуулах шаардлагатай.",
  21606: "TWILIO_FROM_NUMBER дугаар SMS илгээх боломжгүй эсвэл таны дансных биш байна.",
  21659: "TWILIO_FROM_NUMBER дугаар таны Twilio дансных биш байна.",
  21612: "Энэ From дугаараас тухайн улс руу SMS илгээх боломжгүй.",
};

const TWILIO_TRIAL_TEMPLATE = process.env.TWILIO_TRIAL_TEMPLATE || "sms_internal_alerts";
let twilioTrialMode = false;

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

  // Twilio trial accounts can't send custom text (error 572006): they only
  // accept a predefined template name as the body. When that happens we resend
  // using the template. After you upgrade Twilio, the full message is sent.
  for (const to of numbers) {
    try {
      let msg;
      if (!twilioTrialMode) {
        try {
          msg = await twilioClient.messages.create({ from: TWILIO_FROM, to, body: message });
        } catch (err) {
          if (err.code !== 572006) throw err;
          twilioTrialMode = true;
          console.warn(`[SMS] Twilio trial account: custom text not allowed, using template "${TWILIO_TRIAL_TEMPLATE}".`);
        }
      }
      if (!msg) {
        msg = await twilioClient.messages.create({ from: TWILIO_FROM, to, body: TWILIO_TRIAL_TEMPLATE });
      }
      console.log(`[SMS] ✅ Sent to ${to}${twilioTrialMode ? " (trial template)" : ""} — SID: ${msg.sid}`);
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
    await store.insertNotifications(docs);
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
// GROQ_API_KEY байхгүй ч сервер асна (нэвтрэх, түүх гэх мэт ажиллана); зөвхөн /api/classify 503 буцаана.
const groq = process.env.GROQ_API_KEY ? new Groq({ apiKey: process.env.GROQ_API_KEY }) : null;
if (!groq) console.error("\n[WARN] GROQ_API_KEY is not set — AI classification is disabled.\n");

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

const CRITICAL_KEYWORDS = [
  "гал", "тэсрэ", "цахилгаан цохи", "нурсан", "нуран", "цус", "ухаангүй",
  "амьсгал", "гарч чадахгүй", "хоргодох", "яаралтай тусла",
  "унасан", "унаж", "шархадсан", "шарх", "гэмтсэн", "гэмтэл",
  "өвдөж", "өвдсөн", "хөдөлж чадахгүй", "тусламж хэрэгтэй",
];

function applyKeywordFloor(result, transcript) {
  const textToScan = [transcript, result.reasoning].filter(Boolean).join(" ").toLowerCase();
  const hasKeyword = CRITICAL_KEYWORDS.some((kw) => textToScan.includes(kw));

  if (hasKeyword && severityRank(result.severity) < severityRank("high")) {
    return {
      ...result,
      is_hazard: true,
      severity: "high",
      reasoning: `${result.reasoning} [Автомат анхааруулга: аюултай нөхцөл илэрсэн тул түвшинг өсгөв.]`,
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

// Апп файлын төрлийг ихэвчлэн "application/octet-stream" гэж илгээдэг тул
// файлын эхний байтуудаас жинхэнэ зургийн төрлийг тогтооно.
function detectImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.toString("ascii", 0, 3) === "GIF") return "image/gif";
  if (buf.toString("ascii", 4, 8) === "ftyp") {
    const brand = buf.toString("ascii", 8, 12);
    if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return "image/heic";
  }
  return null;
}

async function classifyImageOnly(photoFile, schemaProps) {
  const base64Image = photoFile.buffer.toString("base64");
  const promptText = `${SYSTEM_PROMPT}\n\nЗөвхөн зургийг үндэслэн дүгнэлт гарга. JSON-оор хариул:\n${JSON.stringify(schemaProps)}`;
const response = await groq.chat.completions.create({
 model: "qwen/qwen3.8-27b",
  messages: [{
    role: "user",
    content: [
      { type: "text", text: promptText },
      { type: "image_url", image_url: { url: `data:${photoFile.mimetype};base64,${base64Image}` } },
    ],
  }],
  response_format: { type: "json_object" },
  temperature: 0.2,
  max_completion_tokens: 500,
  reasoning_effort: "none",
});

  const result = JSON.parse(response.choices[0].message.content);
  result.reasoning = cleanReasoning(result.reasoning);
  return result;
}

async function classifyVoiceOnly(transcript, schemaProps) {
  const promptText = `${SYSTEM_PROMPT}\n\nАжилтан зөвхөн дуугаар мэдэгдсэн: "${transcript}". JSON-оор хариул:\n${JSON.stringify(schemaProps)}`;
  const response = await groq.chat.completions.create({
   model: "openai/gpt-oss-120b",
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

// Сервер болон өгөгдлийн сангийн төлөв (mode: "mongodb" | "local")
app.get("/api/health", (req, res) => res.json({ ok: true, db: store.status() }));

app.get("/api/tsekh", (req, res) => res.json(Object.keys(TSEKH_CONTACTS)));

app.get("/api/media/photo/:id", async (req, res) => {
  try {
    const requesterId = req.query.requesterId || "";
    const report = await store.findReportByMedia("photoMediaId", req.params.id);
    if (!report) return res.status(404).json({ error: "Файл олдсонгүй." });
    if (!(await canAccessReport(report, requesterId))) return res.status(403).json({ error: "Хандах эрхгүй." });

    await streamMediaToResponse("photos", req.params.id, res);
  } catch (err) {
    res.status(500).json({ error: "Зураг татахад алдаа гарлаа" });
  }
});

app.get("/api/media/audio/:id", async (req, res) => {
  try {
    const requesterId = req.query.requesterId || "";
    const report = await store.findReportByMedia("audioMediaId", req.params.id);
    if (!report) return res.status(404).json({ error: "Файл олдсонгүй." });
    if (!(await canAccessReport(report, requesterId))) return res.status(403).json({ error: "Хандах эрхгүй." });

    await streamMediaToResponse("audio", req.params.id, res);
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

    const existing = await store.findUserByEmployeeId(employeeId);
    if (existing) return res.status(409).json({ error: "Энэ ажилтны дугаар бүртгэгдсэн байна." });

    let user;
    try {
      user = await store.createUser({ name, employeeId, phone, role, tsekh: tsekh || "" });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: "Энэ ажилтны дугаар бүртгэгдсэн байна." });
      throw err;
    }
    res.json({ _id: user._id, name: user.name, employeeId: user.employeeId, phone: user.phone, role: user.role, roleLabel: ROLE_MN[user.role], tsekh: user.tsekh });
  } catch (err) {
    res.status(500).json({ error: "Бүртгэхэд алдаа гарлаа", details: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { employeeId } = req.body || {};
    if (!employeeId) return res.status(400).json({ error: "Ажилтны дугаараа оруулна уу." });

    const user = await store.findUserByEmployeeId(employeeId);
    if (!user) return res.status(404).json({ error: "Хэрэглэгч олдсонгүй. Эхлээд бүртгүүлнэ үү." });
    res.json({ _id: user._id, name: user.name, employeeId: user.employeeId, phone: user.phone, role: user.role, roleLabel: ROLE_MN[user.role], tsekh: user.tsekh });
  } catch (err) {
    res.status(500).json({ error: "Нэвтрэхэд алдаа гарлаа" });
  }
});

app.get("/api/notifications/:phone", async (req, res) => {
  try {
    const notifications = await store.findNotifications(req.params.phone, 100);
    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.post("/api/notifications/:id/read", async (req, res) => {
  try {
    await store.markNotificationRead(req.params.id);
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
    if (photoFile) photoFile.mimetype = detectImageMime(photoFile.buffer) || photoFile.mimetype;
    const audioFile = req.files?.["audio"]?.[0];
    const tsekh = req.body?.tsekh || "";
    const providedTranscript = req.body?.transcript || "";
    const reporterPhone = req.body?.reporterPhone || "";
    const reporterName = req.body?.reporterName || "";
    const reporterEmployeeId = req.body?.reporterEmployeeId || "";

    if (!photoFile && !audioFile && !providedTranscript) return res.status(400).json({ error: "Зураг эсвэл дуу илгээнэ үү." });
    if (!tsekh) return res.status(400).json({ error: "Цехийг сонгоно уу." });
    if (!groq) return res.status(503).json({ error: "AI шинжилгээ идэвхгүй байна (GROQ_API_KEY тохируулаагүй)." });

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

    // Зураг болон дуу/бичвэрийг тус тусад нь шинжилнэ. Нэг нь алдаа гарвал нөгөөгөөр үргэлжилнэ.
    const errors = [];
    const MAX_GROQ_IMAGE_BYTES = 3 * 1024 * 1024; // base64 болоход ~4MB — Groq-ийн хязгаар

    const imageTask = !photoFile ? null
      : photoFile.size > MAX_GROQ_IMAGE_BYTES
        ? Promise.reject(new Error(`Photo too large for AI (${(photoFile.size / 1048576).toFixed(1)}MB, max 3MB)`))
        : classifyImageOnly(photoFile, schemaProps);
    const voiceTask = transcript ? classifyVoiceOnly(transcript, schemaProps) : null;

    const [imageOutcome, voiceOutcome] = await Promise.allSettled([imageTask, voiceTask]);

    let imageResult = null;
    let voiceResult = null;
    if (photoFile) {
      if (imageOutcome.status === "fulfilled") imageResult = imageOutcome.value;
      else { errors.push(`image: ${imageOutcome.reason?.message}`); console.error("[AI] Image classification failed:", imageOutcome.reason?.message); }
    }
    if (transcript) {
      if (voiceOutcome.status === "fulfilled") voiceResult = voiceOutcome.value;
      else { errors.push(`text: ${voiceOutcome.reason?.message}`); console.error("[AI] Text classification failed:", voiceOutcome.reason?.message); }
    }

    if (!imageResult && !voiceResult) {
      const tooBig = photoFile && photoFile.size > MAX_GROQ_IMAGE_BYTES;
      return res.status(502).json({
        error: tooBig
          ? "Зураг хэт том байна (3MB-аас бага байх ёстой). Дахин зураг аваад оролдоно уу."
          : "AI шинжилгээ хийж чадсангүй. Дахин оролдоно уу.",
        details: errors,
      });
    }

    if (imageResult) console.log(`[AI] Photo → ${imageResult.is_hazard ? "hazard" : "safe"}, ${imageResult.type}, ${imageResult.severity}, conf ${imageResult.confidence}`);
    if (voiceResult) console.log(`[AI] Text  → ${voiceResult.is_hazard ? "hazard" : "safe"}, ${voiceResult.type}, ${voiceResult.severity}, conf ${voiceResult.confidence}`);

    const result = mergeClassifications(imageResult, voiceResult, transcript);
    if (errors.length) result.partialErrors = errors;
    console.log(`[AI] Result → ${result.type}, ${result.severity}`);

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

    if (draft.photo) {
      photoMediaId = await store.saveMedia("photos", draft.photo.buffer, draft.photo.originalname, draft.photo.mimetype, { reporterEmployeeId: draft.reporterEmployeeId });
    }
    if (draft.audio) {
      audioMediaId = await store.saveMedia("audio", draft.audio.buffer, draft.audio.originalname, draft.audio.mimetype, { reporterEmployeeId: draft.reporterEmployeeId });
    }

    let newReport = await store.createReport({
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

    if (photoMediaId) await store.linkMediaToReport("photos", photoMediaId, newReport._id);
    if (audioMediaId) await store.linkMediaToReport("audio", audioMediaId, newReport._id);

    const targetUsers = await getResponsibleUsers(draft.tsekh);
    const targetPhones = targetUsers.map((u) => u.phone);

    let smsStatus = { sent: [], failed: [] };
    const shouldSendSms = ["high", "critical"].includes(newReport.severity) && !draft.isTestData;
    
    if (shouldSendSms) {
      smsStatus = await sendSmsAlerts(targetPhones, newReport.tsekh, newReport.severity, HAZARD_TYPE_MN[newReport.type] || newReport.type);
      newReport = (await store.updateReport(newReport._id, {
        alerted: smsStatus.sent.length > 0,
        smsNumbers: smsStatus.sent,
        smsFailed: smsStatus.failed,
      })) || { ...newReport, alerted: smsStatus.sent.length > 0 };
    }

    await createNotifications(targetUsers, newReport._id, newReport.tsekh, newReport.severity, HAZARD_TYPE_MN[newReport.type] || newReport.type);
    drafts.delete(draftId);

    res.json({
      success: true,
      reportId: newReport._id,
      severity: newReport.severity,
      smsSent: newReport.alerted,
      smsAttempted: shouldSendSms,
      smsSimulated: (smsStatus.simulated || []).length > 0,
      smsDetails: smsStatus,
      notifiedCount: targetUsers.filter((u) => u.phone).length,
      storage: store.status().mode,
    });
  } catch (err) {
    console.error("Error in /api/confirm:", err);
    res.status(500).json({ error: "Баталгаажуулахад алдаа гарлаа." });
  }
});

// Хүсэлт гаргагчийн эрхээс хамааран тайлангийн шүүлтүүр үүсгэнэ.
// requesterId (эсвэл хуучин апп-ын reporterEmployeeId) хүлээн авна.
async function reportFilterFor(req, res) {
  const requesterId = req.query.requesterId || req.query.reporterEmployeeId;
  if (!requesterId) {
    res.status(400).json({ error: "requesterId шаардлагатай." });
    return null;
  }
  const user = await store.findUserByEmployeeId(requesterId);
  if (!user) {
    res.status(404).json({ error: "Хэрэглэгч олдсонгүй." });
    return null;
  }
  const filter = {};
  if (user.role === "tsekh_darga") filter.tsekh = user.tsekh;
  else if (user.role === "ажилтан") filter.reporterEmployeeId = user.employeeId;
  if (req.query.includeTestData !== "true") filter.isTestData = { $ne: true };
  return filter;
}

// GET /api/history — Түүх харах
app.get("/api/history", async (req, res) => {
  try {
    const filter = await reportFilterFor(req, res);
    if (!filter) return;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    res.json(await store.findReports(filter, limit));
  } catch (err) {
    console.error("Error in /api/history:", err);
    res.status(500).json({ error: "Түүх ачаалахад алдаа гарлаа." });
  }
});

// GET /api/stats — Дашбордын тоо
app.get("/api/stats", async (req, res) => {
  try {
    const filter = await reportFilterFor(req, res);
    if (!filter) return;
    res.json(await store.reportStats(filter));
  } catch (err) {
    console.error("Error in /api/stats:", err);
    res.status(500).json({ error: "Статистик авахад алдаа гарлаа." });
  }
});

app.listen(PORT, () => {
  console.log(`[Server] Mining Alert backend running on port ${PORT}`);
});