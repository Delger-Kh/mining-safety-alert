# ⛏️ Mining Safety Alert System
### Уурхайн Аюулын Мэдэгдлийн Систем

> A real-time hazard reporting mobile application built for **Erdenet Mining Corporation** during a software engineering internship. Workers capture photo/voice evidence of workplace hazards — the system uses AI to classify danger severity and automatically sends SMS alerts to supervisors.

---

## 🎯 Problem

Erdenet Mining Corporation needed a faster way for workers to report hazardous situations on-site. Traditional reporting (phone calls, paper forms) is slow, inconsistent, and fails when workers are in areas with limited connectivity. Supervisors need to be notified immediately with enough context to act.

---

## 🏗️ System Architecture

```
Flutter App (Mobile)
       │
       ├──  Photo capture
       ├──  Voice recording → live Mongolian captions
       └──  Text input
              │
              ▼
    Node.js / Express Backend
              │
              ├──  Chimege API  →  Mongolian speech-to-text (96% accuracy)
              ├──  Groq API     →  AI hazard classification (image + voice + text)
              ├──  Twilio       →  Automated SMS to supervisors
              └──  MongoDB Atlas →  Report storage + history
```

**Key design decision**: AI suggests → worker reviews/edits → worker confirms → SMS fires. Human-in-the-loop before any alert is sent, which is the standard pattern for safety-critical systems.

---

## ✨ Features

- **Multi-modal input** — photo, voice (Mongolian), and text, used together for classification
- **Live Mongolian captions** — transcript appears in real time while worker is still recording
- **AI hazard classification** — detects hazard type (electrical, fire, structural, PPE violation, etc.) and severity (low / medium / high / critical)
- **Human review step** — worker sees AI's suggestion and can correct it before confirming
- **Automated SMS alerts** — fires to цехийн дарга and ХАБ-ийн дарга when severity is high or critical
- **Report history** — all reports stored in MongoDB with full audit trail including whether worker edited the AI suggestion
- **Цех-based routing** — each department has its own supervisor contact list

---

## 🛠️ Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Mobile app | Flutter (Dart) | Cross-platform, single codebase for Android |
| Backend | Node.js + Express | Fast to build, matches team's JS experience |
| Mongolian STT | Chimege API | Only Mongolian-native STT with 96% accuracy — generic APIs perform significantly worse on Mongolian |
| AI classification | Groq (Llama 3.3 70B + Llama 4 Scout vision) | Fast inference, free tier sufficient for prototype |
| SMS | Twilio | Reliable delivery, good API, supports Mongolian numbers |
| Database | MongoDB Atlas | Flexible schema for varied report types, cloud-hosted |

---

## 📁 Project Structure

```
mining-safety-alert/
├── backend/
│   ├── server.js          # Main Express server
│   ├── package.json
│   └── .env.example       # Required environment variables
└── frontend/
    ├── lib/
    │   └── main.dart      # Flutter app (capture + review + confirm flow)
    ├── pubspec.yaml
    └── android/
        └── app/src/main/
            └── AndroidManifest.xml
```

---

##  Running Locally

### Backend

```bash
cd backend
npm install
cp .env.example .env
# Fill in your API keys in .env
node server.js
```

### Frontend

```bash
cd frontend
flutter pub get
# Update backendBase in main.dart to your laptop's local IP
flutter run
```

### Required environment variables

```
GROQ_API_KEY=
CHIMEGE_TOKEN=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
MONGO_URI=
```

---

## 📊 API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/tsekh` | List all departments |
| POST | `/api/transcribe-chunk` | Transcribe a short audio chunk (live captions) |
| POST | `/api/classify` | AI classification — returns draft, no SMS yet |
| POST | `/api/confirm` | Worker confirms — saves to DB and sends SMS |
| GET | `/api/history` | All past reports |
| GET | `/api/history/:id` | Single report by ID |

---

## 🔍 Why Chimege for Mongolian STT?

Mongolian is a low-resource language — generic speech APIs (Google, Azure, OpenAI Whisper) achieve 10-25% word error rate on Mongolian. Chimege is a Mongolian startup that has trained specifically on Mongolian speech data and achieves ~4% WER. For a safety system where misheard words could affect hazard classification, this accuracy gap matters. Chimege is already deployed by Mobicom (Mongolia's largest telecom) and Golomt Bank.

---

## ⚠️ Current Limitations

- Requires internet connection for AI classification and SMS (offline-first was evaluated but descoped for v1 — see architecture notes)
- Twilio free trial limits SMS to verified numbers only; production deployment would use a Mongolian carrier direct integration
- Image classification accuracy depends on photo quality and lighting conditions

---

## 📝 Built During

**Internship** — Erdenet Mining Corporation, System Development Department  
**Period** — June–July 2026  
**Supervisor** — Ч. Мөнхцэцэг

---

##  Author

Delger Khorolmaa 
Software Engineering Student  
Mongolian University of Science and Technology 
GitHub: [@Delger-Kh](https://github.com/Delger-Kh)
