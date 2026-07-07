import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:http/http.dart' as http;
import 'package:record/record.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'history_screen.dart';
import 'app_user.dart';
import 'login_screen.dart';
import 'notifications_screen.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Уурхайн Аюулын Мэдээлэл',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepOrange),
        useMaterial3: true,
      ),
      // App now starts on the login screen. Once a user logs in or
      // registers, LoginScreen pushes HazardReportPage with that user.
      home: const LoginScreen(),
    );
  }
}

const Map<String, String> hazardTypeMn = {
  'structural': 'Барилгын бүтцийн аюул',
  'electrical': 'Цахилгааны аюул',
  'fire_explosion': 'Гал/тэсэлгээний аюул',
  'chemical_gas': 'Хими/хийн аюул',
  'equipment': 'Тоног төхөөрөмжийн эвдрэл',
  'fall_slip': 'Унах/гулсах аюул',
  'ppe_violation': 'Хамгаалах хувцасгүй',
  'vehicle_traffic': 'Тээврийн хэрэгслийн аюул',
  'other': 'Бусад',
};

const Map<String, String> severityMn = {
  'low': 'БАГА',
  'medium': 'ДУНД',
  'high': 'ӨНДӨР',
  'critical': 'ШУУД АЮУЛТАЙ',
};

Color severityColor(String? severity) {
  switch (severity) {
    case 'critical': return Colors.red[700]!;
    case 'high':     return Colors.orange[800]!;
    case 'medium':   return Colors.amber[700]!;
    case 'low':      return Colors.green[700]!;
    default:         return Colors.grey;
  }
}

// ════════════════════════════════════════════════════════════════════
// WAV CHUNK MERGING
// The live-caption flow records several short ~4s WAV chunks back to
// back (so it can transcribe-as-you-go). Each chunk is a fully valid,
// separate WAV file with its own 44-byte header. To end up with ONE
// playable recording for the whole hazard report, we strip each
// chunk's header, concatenate the raw PCM audio samples, and write a
// single new header sized for the combined data.
// ════════════════════════════════════════════════════════════════════

int _findDataChunkOffset(Uint8List bytes) {
  for (int i = 12; i < bytes.length - 4; i++) {
    if (bytes[i] == 0x64 && bytes[i + 1] == 0x61 && bytes[i + 2] == 0x74 && bytes[i + 3] == 0x61) {
      return i; // offset of the ASCII 'data' tag
    }
  }
  return -1;
}

Uint8List _buildWavHeader(int dataLength, int sampleRate, int numChannels, int bitsPerSample) {
  final byteRate = sampleRate * numChannels * bitsPerSample ~/ 8;
  final blockAlign = numChannels * bitsPerSample ~/ 8;
  final header = BytesBuilder();

  void writeString(String s) => header.add(s.codeUnits);
  void writeUint32(int v) {
    final b = ByteData(4)..setUint32(0, v, Endian.little);
    header.add(b.buffer.asUint8List());
  }
  void writeUint16(int v) {
    final b = ByteData(2)..setUint16(0, v, Endian.little);
    header.add(b.buffer.asUint8List());
  }

  writeString('RIFF');
  writeUint32(36 + dataLength);
  writeString('WAVE');
  writeString('fmt ');
  writeUint32(16); // PCM fmt chunk size
  writeUint16(1);  // audio format: PCM
  writeUint16(numChannels);
  writeUint32(sampleRate);
  writeUint32(byteRate);
  writeUint16(blockAlign);
  writeUint16(bitsPerSample);
  writeString('data');
  writeUint32(dataLength);

  return header.toBytes();
}

/// Merges a list of WAV chunk files (in order) into a single WAV file
/// at [outputPath]. Returns the output File, or null if there was
/// nothing usable to merge.
Future<File?> mergeWavChunks(List<String> chunkPaths, String outputPath) async {
  final pcmData = BytesBuilder();
  int sampleRate = 16000;
  int numChannels = 1;
  int bitsPerSample = 16;
  bool haveFormat = false;

  for (final path in chunkPaths) {
    final file = File(path);
    if (!await file.exists()) continue;
    final bytes = await file.readAsBytes();
    if (bytes.length < 44) continue;

    final dataOffset = _findDataChunkOffset(bytes);
    if (dataOffset == -1) continue;

    if (!haveFormat) {
      final byteData = ByteData.sublistView(bytes);
      numChannels = byteData.getUint16(22, Endian.little);
      sampleRate = byteData.getUint32(24, Endian.little);
      bitsPerSample = byteData.getUint16(34, Endian.little);
      haveFormat = true;
    }

    // Skip the 8-byte "data" + size sub-header, keep only raw samples.
    pcmData.add(bytes.sublist(dataOffset + 8));
  }

  final rawData = pcmData.toBytes();
  if (rawData.isEmpty) return null;

  final header = _buildWavHeader(rawData.length, sampleRate, numChannels, bitsPerSample);
  final outFile = File(outputPath);
  await outFile.writeAsBytes([...header, ...rawData]);
  return outFile;
}

// ════════════════════════════════════════════════════════════════════
// SCREEN 1: Capture — now with LIVE captions while recording, PLUS the
// employee can type/edit the transcript by hand at any time.
// ════════════════════════════════════════════════════════════════════
class HazardReportPage extends StatefulWidget {
  final AppUser currentUser;
  const HazardReportPage({super.key, required this.currentUser});
  @override
  State<HazardReportPage> createState() => _HazardReportPageState();
}

class _HazardReportPageState extends State<HazardReportPage> {
  static const String backendBase = 'http://192.168.1.108:3000'; // CHANGE to your laptop's IP

  File? _selectedImage;
  final ImagePicker _picker = ImagePicker();
  final AudioRecorder _recorder = AudioRecorder();

  bool _isRecording = false;
  String? _finalAudioPath;     // merged, final WAV for the whole recording — this is what gets uploaded
  final List<String> _chunkPaths = []; // every chunk recorded this session, in order, kept until merged

  // Transcript is now backed by a TextEditingController so the employee
  // can type or edit it by hand, in addition to it being auto-filled by
  // live voice transcription while recording.
  final TextEditingController _transcriptController = TextEditingController();
  bool _isTranscribingChunk = false;
  bool _isMergingAudio = false;

  Timer? _chunkTimer;
  static const Duration chunkDuration = Duration(seconds: 4); // short chunk = faster feedback
  String? _currentChunkPath;
  int _chunkCounter = 0;

  String? _selectedTsekh;
  List<String> _tsekhList = [];
  bool _isSubmitting = false;
  String? _errorMessage;

  bool get _isSupervisor =>
      widget.currentUser.role == 'tsekh_darga' || widget.currentUser.role == 'hub_darga';
  int _unreadNotifications = 0;

  @override
  void initState() {
    super.initState();
    _loadTsekhList();
    // Rebuild on every keystroke so the submit button enables/disables
    // correctly as the employee types into the transcript field.
    _transcriptController.addListener(() {
      setState(() {});
    });
    // Employees default to their own цех so they don't have to pick it every time.
    if (widget.currentUser.tsekh.isNotEmpty) {
      _selectedTsekh = widget.currentUser.tsekh;
    }
    if (_isSupervisor) _loadUnreadNotificationCount();
  }

  Future<void> _loadUnreadNotificationCount() async {
    try {
      final res = await http.get(Uri.parse('$backendBase/api/notifications/${widget.currentUser.phone}'));
      if (res.statusCode == 200) {
        final list = jsonDecode(res.body) as List;
        final unread = list.where((n) => n['read'] != true).length;
        if (mounted) setState(() => _unreadNotifications = unread);
      }
    } catch (_) {
      // Non-critical — badge just won't update.
    }
  }

  @override
  void dispose() {
    _chunkTimer?.cancel();
    _recorder.dispose();
    _transcriptController.dispose();
    super.dispose();
  }

  Future<void> _loadTsekhList() async {
    try {
      final res = await http.get(Uri.parse('$backendBase/api/tsekh'));
      if (res.statusCode == 200) {
        final list = (jsonDecode(res.body) as List).cast<String>();
        setState(() => _tsekhList = list);
      }
    } catch (_) {
      setState(() => _tsekhList = [
        'Уурхай-1', 'Уурхай-2', 'Баяжуулах цех', 'Засварын цех',
        'Цахилгааны цех', 'Тээврийн цех', 'Агуулах', 'Администраци',
      ]);
    }
  }

  Future<void> _takePhoto() async {
    final XFile? photo = await _picker.pickImage(source: ImageSource.camera, imageQuality: 85);
    if (photo != null) {
      setState(() { _selectedImage = File(photo.path); _errorMessage = null; });
    }
  }

  Future<void> _pickFromGallery() async {
    final XFile? photo = await _picker.pickImage(source: ImageSource.gallery, imageQuality: 85);
    if (photo != null) {
      setState(() { _selectedImage = File(photo.path); _errorMessage = null; });
    }
  }

  // ── LIVE CAPTION RECORDING ────────────────────────────────────────
  // Strategy: record short ~4s chunks back-to-back. After each chunk
  // finishes, immediately start the next one (so there's no gap the
  // worker would notice), and send the just-finished chunk to the
  // backend for transcription. Append the returned text to the
  // growing transcript field as it comes back.
  //
  // IMPORTANT: unlike before, chunk files are now KEPT (not deleted)
  // until recording stops, at which point they're merged into one
  // final WAV file (_finalAudioPath) that actually gets uploaded.
  Future<void> _startRecording() async {
    final status = await Permission.microphone.request();
    if (!status.isGranted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Микрофоны зөвшөөрөл шаардлагатай')));
      return;
    }

    // Clean up anything left over from a previous recording session.
    await _deleteFileQuietly(_finalAudioPath);
    for (final p in _chunkPaths) {
      await _deleteFileQuietly(p);
    }

    setState(() {
      _isRecording = true;
      _finalAudioPath = null;
      _chunkPaths.clear();
      _errorMessage = null;
      _chunkCounter = 0;
      // Note: we intentionally do NOT clear _transcriptController here —
      // if the employee already typed something by hand, recording will
      // simply append onto it, rather than wiping out what they wrote.
    });

    await _recordNextChunk();
  }

  Future<void> _recordNextChunk() async {
    if (!_isRecording) return;

    final dir = await getTemporaryDirectory();
    _chunkCounter++;
    final chunkPath = '${dir.path}/chunk_${_chunkCounter}_${DateTime.now().millisecondsSinceEpoch}.wav';
    _currentChunkPath = chunkPath;

    await _recorder.start(
      const RecordConfig(encoder: AudioEncoder.wav, sampleRate: 16000, numChannels: 1),
      path: chunkPath,
    );

    _chunkTimer = Timer(chunkDuration, () => _finishChunkAndContinue());
  }

  Future<void> _finishChunkAndContinue() async {
    if (!_isRecording) return;

    final path = await _recorder.stop();

    if (path != null) {
      _chunkPaths.add(path);
      _sendChunkForTranscription(path); // fire-and-forget, don't block next recording
    }

    // Immediately start recording the next chunk so there's minimal gap
    if (_isRecording) {
      await _recordNextChunk();
    }
  }

  Future<void> _sendChunkForTranscription(String path) async {
    try {
      setState(() => _isTranscribingChunk = true);

      final uri = Uri.parse('$backendBase/api/transcribe-chunk');
      final request = http.MultipartRequest('POST', uri);
      request.files.add(await http.MultipartFile.fromPath('chunk', path, filename: 'chunk.wav'));

      final streamedResponse = await request.send().timeout(const Duration(seconds: 15));
      final response = await http.Response.fromStream(streamedResponse);

      if (response.statusCode == 200) {
        final decoded = jsonDecode(response.body) as Map<String, dynamic>;
        final text = (decoded['text'] as String?) ?? '';
        if (text.isNotEmpty && mounted) {
          final current = _transcriptController.text;
          final updated = current.isEmpty ? text : '$current $text';
          _transcriptController.value = _transcriptController.value.copyWith(
            text: updated,
            selection: TextSelection.collapsed(offset: updated.length),
          );
        }
      }
    } catch (_) {
      // Silently ignore chunk failures — don't interrupt the live flow.
      // The worker just won't see that fragment; not critical.
    } finally {
      if (mounted) setState(() => _isTranscribingChunk = false);
      // NOTE: chunk file is intentionally NOT deleted here anymore —
      // it's needed later to build the final merged recording.
    }
  }

  Future<void> _stopRecording() async {
    _chunkTimer?.cancel();
    setState(() => _isRecording = false);

    // Stop whatever chunk is currently in progress, keep it, and transcribe it too.
    final path = await _recorder.stop();
    if (path != null) {
      _chunkPaths.add(path);
      await _sendChunkForTranscription(path);
    }

    await _buildFinalRecording();
  }

  Future<void> _buildFinalRecording() async {
    if (_chunkPaths.isEmpty) return;

    setState(() => _isMergingAudio = true);
    try {
      final dir = await getTemporaryDirectory();
      final outputPath = '${dir.path}/hazard_report_${DateTime.now().millisecondsSinceEpoch}.wav';
      final merged = await mergeWavChunks(_chunkPaths, outputPath);

      // Chunks are no longer needed once merged — clean them up.
      for (final p in _chunkPaths) {
        await _deleteFileQuietly(p);
      }
      _chunkPaths.clear();

      if (mounted) setState(() => _finalAudioPath = merged?.path);
    } finally {
      if (mounted) setState(() => _isMergingAudio = false);
    }
  }

  Future<void> _deleteFileQuietly(String? path) async {
    if (path == null) return;
    try {
      final f = File(path);
      if (await f.exists()) await f.delete();
    } catch (_) {}
  }

  void _clearVoice() {
    _deleteFileQuietly(_finalAudioPath);
    for (final p in _chunkPaths) {
      _deleteFileQuietly(p);
    }
    setState(() {
      _transcriptController.clear();
      _finalAudioPath = null;
      _chunkPaths.clear();
    });
  }

  // ── Classify and go to review screen ──────────────────────────────
  Future<void> _classifyAndReview() async {
    final transcriptText = _transcriptController.text.trim();
    if (_selectedImage == null && transcriptText.isEmpty) return;
    if (_selectedTsekh == null) {
      setState(() => _errorMessage = 'Цехийг сонгоно уу.');
      return;
    }

    setState(() { _isSubmitting = true; _errorMessage = null; });

    try {
      final uri = Uri.parse('$backendBase/api/classify');
      final request = http.MultipartRequest('POST', uri);
      request.fields['tsekh'] = _selectedTsekh!;
      request.fields['transcript'] = transcriptText;
      request.fields['reporterPhone'] = widget.currentUser.phone;
      request.fields['reporterName'] = widget.currentUser.name;
      request.fields['reporterEmployeeId'] = widget.currentUser.employeeId;

      if (_selectedImage != null) {
        request.files.add(await http.MultipartFile.fromPath('photo', _selectedImage!.path));
      }

      // ── This is the piece that was missing: actually attach the
      // merged voice recording, under the field name the backend
      // expects ("audio"), so it gets persisted to the `audio` GridFS
      // bucket in /api/confirm instead of vanishing.
      if (_finalAudioPath != null && await File(_finalAudioPath!).exists()) {
        request.files.add(await http.MultipartFile.fromPath(
          'audio', _finalAudioPath!, filename: 'voice_report.wav',
        ));
      }

      final streamedResponse = await request.send().timeout(const Duration(seconds: 60));
      final response = await http.Response.fromStream(streamedResponse);

      if (response.statusCode == 200) {
        final decoded = jsonDecode(response.body) as Map<String, dynamic>;
        if (!mounted) return;

        final confirmed = await Navigator.push<bool>(
          context,
          MaterialPageRoute(builder: (_) => ReviewScreen(
            backendBase: backendBase,
            draft: decoded,
          )),
        );

        if (confirmed == true) {
          await _deleteFileQuietly(_finalAudioPath);
          setState(() {
            _selectedImage = null;
            _transcriptController.clear();
            _finalAudioPath = null;
            _selectedTsekh = null;
          });
        }
      } else {
        setState(() => _errorMessage = 'Серверийн алдаа (${response.statusCode}): ${response.body}');
      }
    } catch (e) {
      setState(() => _errorMessage = 'Серверт холбогдож чадсангүй.\n\nДэлгэрэнгүй: $e');
    } finally {
      if (mounted) setState(() => _isSubmitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final hasVoice = _transcriptController.text.trim().isNotEmpty;
    final canSubmit = (_selectedImage != null || hasVoice) && !_isSubmitting && !_isRecording && !_isMergingAudio;

    return Scaffold(
      appBar: AppBar(
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Аюулын тухай мэдээлэх'),
            Text(
              '${widget.currentUser.name} (${widget.currentUser.employeeId}) · ${widget.currentUser.roleLabel}',
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.normal),
            ),
          ],
        ),
        actions: [
          if (_isSupervisor)
            Stack(
              alignment: Alignment.center,
              children: [
                IconButton(
                  icon: const Icon(Icons.notifications_outlined),
                  tooltip: 'Мэдэгдэл',
                  onPressed: () async {
                    await Navigator.push(
                      context,
                      MaterialPageRoute(builder: (_) => NotificationsScreen(
                        backendBase: backendBase,
                        phone: widget.currentUser.phone,
                      )),
                    );
                    _loadUnreadNotificationCount();
                  },
                ),
                if (_unreadNotifications > 0)
                  Positioned(
                    right: 8, top: 8,
                    child: Container(
                      padding: const EdgeInsets.all(3),
                      decoration: const BoxDecoration(color: Colors.red, shape: BoxShape.circle),
                      constraints: const BoxConstraints(minWidth: 16, minHeight: 16),
                      child: Text('$_unreadNotifications',
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: Colors.white, fontSize: 10)),
                    ),
                  ),
              ],
            ),
          IconButton(
            icon: const Icon(Icons.history),
            tooltip: 'Түүх',
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(builder: (_) => HistoryScreen(backendBase: backendBase, currentUser: widget.currentUser)),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Гарах',
            onPressed: () {
              Navigator.pushAndRemoveUntil(
                context,
                MaterialPageRoute(builder: (_) => const LoginScreen()),
                (route) => false,
              );
            },
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Цех сонгох', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            DropdownButtonFormField<String>(
              value: _selectedTsekh,
              hint: const Text('Аль цехэд байгаагаа сонгоно уу'),
              isExpanded: true,
              decoration: InputDecoration(
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              ),
              items: _tsekhList.map((t) => DropdownMenuItem(value: t, child: Text(t))).toList(),
              onChanged: (v) => setState(() => _selectedTsekh = v),
            ),
            const SizedBox(height: 20),

            const Text('Зураг (заавал биш)', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            Container(
              height: 200,
              width: double.infinity,
              decoration: BoxDecoration(
                color: Colors.grey[200],
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Colors.grey[400]!),
              ),
              child: _selectedImage == null
                  ? const Center(child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      Icon(Icons.photo_camera_outlined, size: 48, color: Colors.grey),
                      SizedBox(height: 8),
                      Text('Зураг сонгогдоогүй', style: TextStyle(color: Colors.grey)),
                    ]))
                  : ClipRRect(borderRadius: BorderRadius.circular(12), child: Image.file(_selectedImage!, fit: BoxFit.cover)),
            ),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(child: ElevatedButton.icon(
                onPressed: (_isSubmitting || _isRecording) ? null : _takePhoto,
                icon: const Icon(Icons.camera_alt), label: const Text('Зураг авах'),
                style: ElevatedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 12)))),
              const SizedBox(width: 10),
              Expanded(child: OutlinedButton.icon(
                onPressed: (_isSubmitting || _isRecording) ? null : _pickFromGallery,
                icon: const Icon(Icons.photo_library), label: const Text('Галерей'),
                style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(vertical: 12)))),
            ]),
            const SizedBox(height: 20),

            const Text('Дуут мэдэгдэл / бичвэр (заавал биш)', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(
              'Дуугаар ярьж болно, эсвэл доор шууд бичиж болно.',
              style: TextStyle(fontSize: 12, color: Colors.grey[600]),
            ),
            const SizedBox(height: 8),

            // ── TRANSCRIPT BOX — now a real, editable text field ──
            // While recording, this fills in automatically from live
            // speech-to-text. At any other time (or even at the same
            // time), the employee can tap in and type/edit it by hand.
            Container(
              width: double.infinity,
              decoration: BoxDecoration(
                color: _isRecording ? Colors.red[50] : Colors.grey[100],
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: _isRecording ? Colors.red[300]! : Colors.grey[300]!),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (_isRecording || _isMergingAudio)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(8, 6, 8, 0),
                      child: Row(children: [
                        if (_isRecording) ...[
                          const Icon(Icons.fiber_manual_record, color: Colors.red, size: 12),
                          const SizedBox(width: 6),
                          const Text('Бичиж байна...', style: TextStyle(color: Colors.red, fontSize: 12, fontWeight: FontWeight.w600)),
                          if (_isTranscribingChunk) ...[
                            const SizedBox(width: 8),
                            const SizedBox(height: 10, width: 10, child: CircularProgressIndicator(strokeWidth: 1.5)),
                          ],
                        ],
                        if (_isMergingAudio) ...[
                          const SizedBox(height: 10, width: 10, child: CircularProgressIndicator(strokeWidth: 1.5)),
                          const SizedBox(width: 8),
                          Text('Бичлэгийг нэгтгэж байна...', style: TextStyle(color: Colors.grey[600], fontSize: 12)),
                        ],
                      ]),
                    ),
                  TextField(
                    controller: _transcriptController,
                    maxLines: null,
                    minLines: 3,
                    enabled: !_isSubmitting,
                    // Read-only while actively recording, so the live
                    // captions aren't fought over by simultaneous typing.
                    // As soon as recording stops, it's freely editable.
                    readOnly: _isRecording,
                    style: const TextStyle(fontSize: 15, height: 1.4, color: Colors.black87),
                    decoration: InputDecoration(
                      border: InputBorder.none,
                      contentPadding: const EdgeInsets.all(8),
                      hintText: _isRecording ? 'Ярьж эхэлнэ үү...' : 'Энд бичих эсвэл дуугаар ярих...',
                      hintStyle: TextStyle(color: Colors.grey[500]),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),

            Row(children: [
              Expanded(child: ElevatedButton.icon(
                onPressed: (_isSubmitting || _isMergingAudio) ? null : (_isRecording ? _stopRecording : _startRecording),
                icon: Icon(_isRecording ? Icons.stop : Icons.mic),
                label: Text(_isRecording ? 'Зогсоох' : 'Бичлэг эхлэх'),
                style: ElevatedButton.styleFrom(
                  backgroundColor: _isRecording ? Colors.red : null,
                  foregroundColor: _isRecording ? Colors.white : null,
                  padding: const EdgeInsets.symmetric(vertical: 12)))),
              if (hasVoice && !_isRecording) ...[
                const SizedBox(width: 10),
                IconButton(onPressed: _clearVoice, icon: const Icon(Icons.delete_outline, color: Colors.red)),
              ],
            ]),
            const SizedBox(height: 24),

            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: canSubmit ? _classifyAndReview : null,
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  backgroundColor: Colors.deepOrange, foregroundColor: Colors.white,
                ),
                child: _isSubmitting
                    ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                    : const Text('Шинжилгээ хийх →', style: TextStyle(fontSize: 16)),
              ),
            ),
            const SizedBox(height: 20),

            if (_errorMessage != null)
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: Colors.red[50], borderRadius: BorderRadius.circular(8), border: Border.all(color: Colors.red[300]!)),
                child: Text(_errorMessage!, style: TextStyle(color: Colors.red[900])),
              ),
          ],
        ),
      ),
    );
  }
}

// ════════════════════════════════════════════════════════════════════
// SCREEN 2: Review — editable AI suggestion before final confirm + SMS
// ════════════════════════════════════════════════════════════════════
class ReviewScreen extends StatefulWidget {
  final String backendBase;
  final Map<String, dynamic> draft;

  const ReviewScreen({super.key, required this.backendBase, required this.draft});

  @override
  State<ReviewScreen> createState() => _ReviewScreenState();
}

class _ReviewScreenState extends State<ReviewScreen> {
  late String _selectedType;
  late String _selectedSeverity;
  late TextEditingController _reasoningController;
  bool _isConfirming = false;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _selectedType = widget.draft['type'] ?? 'other';
    _selectedSeverity = widget.draft['severity'] ?? 'low';
    _reasoningController = TextEditingController(text: widget.draft['reasoning'] ?? '');
  }

  @override
  void dispose() {
    _reasoningController.dispose();
    super.dispose();
  }

  bool get _wasEdited =>
      _selectedType != widget.draft['type'] || _selectedSeverity != widget.draft['severity'];

  Future<void> _confirmAndSend() async {
    setState(() { _isConfirming = true; _errorMessage = null; });

    try {
      final res = await http.post(
        Uri.parse('${widget.backendBase}/api/confirm'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'draftId': widget.draft['draftId'],
          'type': _selectedType,
          'severity': _selectedSeverity,
          'reasoning': _reasoningController.text.trim(),
        }),
      ).timeout(const Duration(seconds: 30));

      if (res.statusCode == 200) {
        final result = jsonDecode(res.body) as Map<String, dynamic>;
        if (!mounted) return;

        final alerted = result['alerted'] == true;
        final smsCount = (result['smsNumbers'] as List?)?.length ?? 0;

        await showDialog(
          context: context,
          builder: (_) => AlertDialog(
            title: Row(children: [
              Icon(alerted ? Icons.check_circle : Icons.info_outline,
                  color: alerted ? Colors.green : Colors.blueGrey),
              const SizedBox(width: 8),
              Text(alerted ? 'Илгээгдсэн' : 'Хадгалагдсан'),
            ]),
            content: Text(alerted
                ? 'Мэдэгдэл баталгаажиж, $smsCount хүнд SMS илгээгдлээ.'
                : 'Мэдээлэл хадгалагдсан. Аюулын түвшин бага тул SMS илгээгдээгүй.'),
            actions: [
              TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK')),
            ],
          ),
        );

        if (!mounted) return;
        Navigator.pop(context, true);
      } else {
        setState(() => _errorMessage = 'Алдаа (${res.statusCode}): ${res.body}');
      }
    } catch (e) {
      setState(() => _errorMessage = 'Баталгаажуулахад алдаа гарлаа: $e');
    } finally {
      if (mounted) setState(() => _isConfirming = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final transcript = widget.draft['transcript'] as String?;
    final isHazard = widget.draft['is_hazard'] == true;
    final confidence = widget.draft['confidence'];

    return Scaffold(
      appBar: AppBar(
        title: const Text('Шинжилгээг шалгах'),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: isHazard ? Colors.orange[50] : Colors.green[50],
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: isHazard ? Colors.orange[300]! : Colors.green[300]!),
              ),
              child: Row(children: [
                Icon(isHazard ? Icons.warning_amber_rounded : Icons.check_circle_outline,
                    color: isHazard ? Colors.orange[800] : Colors.green[700]),
                const SizedBox(width: 10),
                Expanded(child: Text(
                  isHazard ? 'Хиймэл оюун ухаан аюул илрүүлсэн' : 'Хиймэл оюун ухаан аюул илрүүлээгүй',
                  style: const TextStyle(fontWeight: FontWeight.w600),
                )),
              ]),
            ),
            const SizedBox(height: 8),
            if (confidence != null)
              Text('Итгэлцэл: ${((confidence as num) * 100).toStringAsFixed(0)}%',
                  style: TextStyle(fontSize: 12, color: Colors.grey[600])),
            const SizedBox(height: 20),

            if (transcript != null && transcript.isNotEmpty) ...[
              const Text('Дуу хоолойн бичвэр', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: Colors.blue[50], borderRadius: BorderRadius.circular(8)),
                child: Text('"$transcript"', style: TextStyle(color: Colors.blue[900], fontStyle: FontStyle.italic, height: 1.4)),
              ),
              const SizedBox(height: 20),
            ],

            const Text('Аюулын төрөл (засаж болно)', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            DropdownButtonFormField<String>(
              value: _selectedType,
              isExpanded: true,
              decoration: InputDecoration(
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              ),
              items: hazardTypeMn.entries
                  .map((e) => DropdownMenuItem(value: e.key, child: Text(e.value)))
                  .toList(),
              onChanged: (v) => setState(() => _selectedType = v!),
            ),
            const SizedBox(height: 16),

            const Text('Аюулын түвшин (засаж болно)', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            DropdownButtonFormField<String>(
              value: _selectedSeverity,
              isExpanded: true,
              decoration: InputDecoration(
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              ),
              items: severityMn.entries
                  .map((e) => DropdownMenuItem(
                        value: e.key,
                        child: Row(children: [
                          Container(width: 10, height: 10, decoration: BoxDecoration(color: severityColor(e.key), shape: BoxShape.circle)),
                          const SizedBox(width: 8),
                          Text(e.value),
                        ]),
                      ))
                  .toList(),
              onChanged: (v) => setState(() => _selectedSeverity = v!),
            ),
            const SizedBox(height: 16),

            const Text('Тайлбар (засаж болно)', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 6),
            TextField(
              controller: _reasoningController,
              maxLines: 3,
              decoration: InputDecoration(
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                contentPadding: const EdgeInsets.all(12),
              ),
            ),

            if (_wasEdited) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                decoration: BoxDecoration(color: Colors.amber[50], borderRadius: BorderRadius.circular(6)),
                child: Row(children: [
                  Icon(Icons.edit, size: 14, color: Colors.amber[800]),
                  const SizedBox(width: 6),
                  Expanded(child: Text(
                    'Та хиймэл оюун ухааны санал болгосон үнэлгээг өөрчилсөн байна.',
                    style: TextStyle(fontSize: 12, color: Colors.amber[900]),
                  )),
                ]),
              ),
            ],

            const SizedBox(height: 28),

            if (_errorMessage != null) ...[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: Colors.red[50], borderRadius: BorderRadius.circular(8)),
                child: Text(_errorMessage!, style: TextStyle(color: Colors.red[900])),
              ),
              const SizedBox(height: 16),
            ],

            SizedBox(
              width: double.infinity,
              child: ElevatedButton.icon(
                onPressed: _isConfirming ? null : _confirmAndSend,
                icon: _isConfirming
                    ? const SizedBox(height: 16, width: 16, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                    : const Icon(Icons.send),
                label: Text(_isConfirming ? 'Илгээж байна...' : 'Баталгаажуулж илгээх'),
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  backgroundColor: severityColor(_selectedSeverity),
                  foregroundColor: Colors.white,
                ),
              ),
            ),
            const SizedBox(height: 8),
            Center(
              child: TextButton(
                onPressed: _isConfirming ? null : () => Navigator.pop(context, false),
                child: const Text('Цуцлах'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}