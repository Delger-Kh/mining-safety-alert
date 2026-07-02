import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

const Map<String, String> hazardTypeMnH = {
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

const Map<String, String> severityMnH = {
  'low': 'БАГА',
  'medium': 'ДУНД',
  'high': 'ӨНДӨР',
  'critical': 'ШУУД АЮУЛТАЙ',
};

Color severityColorH(String? severity) {
  switch (severity) {
    case 'critical': return Colors.red[700]!;
    case 'high':     return Colors.orange[800]!;
    case 'medium':   return Colors.amber[700]!;
    case 'low':      return Colors.green[700]!;
    default:         return Colors.grey;
  }
}

String _timeAgo(String? isoDate) {
  if (isoDate == null) return '';
  try {
    final dt = DateTime.parse(isoDate).toLocal();
    final diff = DateTime.now().difference(dt);
    if (diff.inSeconds < 60) return 'Дөнгөж сая';
    if (diff.inMinutes < 60) return '${diff.inMinutes}м өмнө';
    if (diff.inHours < 24) return '${diff.inHours}ц өмнө';
    if (diff.inDays < 7) return '${diff.inDays}ө өмнө';
    return '${dt.year}-${dt.month.toString().padLeft(2,'0')}-${dt.day.toString().padLeft(2,'0')}';
  } catch (_) {
    return '';
  }
}

class HistoryScreen extends StatefulWidget {
  final String backendBase;
  const HistoryScreen({super.key, required this.backendBase});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  List<Map<String, dynamic>> _reports = [];
  bool _isLoading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _loadHistory();
  }

  Future<void> _loadHistory() async {
    setState(() { _isLoading = true; _error = null; });
    try {
      final res = await http
          .get(Uri.parse('${widget.backendBase}/api/history?limit=100'))
          .timeout(const Duration(seconds: 15));
      if (res.statusCode == 200) {
        final list = (jsonDecode(res.body) as List).cast<Map<String, dynamic>>();
        setState(() { _reports = list; _isLoading = false; });
      } else {
        setState(() { _error = 'Серверийн алдаа (${res.statusCode})'; _isLoading = false; });
      }
    } catch (e) {
      setState(() { _error = 'Серверт холбогдож чадсангүй'; _isLoading = false; });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
        title: const Text('Мэдээллийн түүх'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _loadHistory),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _error != null
              ? Center(child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Icon(Icons.error_outline, size: 48, color: Colors.red[300]),
                  const SizedBox(height: 12),
                  Text(_error!, style: TextStyle(color: Colors.red[700])),
                  const SizedBox(height: 16),
                  ElevatedButton(onPressed: _loadHistory, child: const Text('Дахин оролдох')),
                ]))
              : _reports.isEmpty
                  ? const Center(child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      Icon(Icons.inbox_outlined, size: 64, color: Colors.grey),
                      SizedBox(height: 12),
                      Text('Одоогоор мэдээлэл байхгүй', style: TextStyle(color: Colors.grey)),
                    ]))
                  : RefreshIndicator(
                      onRefresh: _loadHistory,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(12),
                        itemCount: _reports.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 8),
                        itemBuilder: (context, index) {
                          final r = _reports[index];
                          return _ReportCard(
                            report: r,
                            onTap: () => Navigator.push(context,
                              MaterialPageRoute(builder: (_) => ReportDetailScreen(report: r))),
                          );
                        },
                      ),
                    ),
    );
  }
}

class _ReportCard extends StatelessWidget {
  final Map<String, dynamic> report;
  final VoidCallback onTap;
  const _ReportCard({required this.report, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final severity = report['severity'] as String?;
    final type = report['type'] as String?;
    final isHazard = report['is_hazard'] == true;
    final alerted = report['alerted'] == true;
    final tsekh = report['tsekh'] as String? ?? '';
    final color = severityColorH(severity);

    return Card(
      elevation: 2,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: BorderSide(color: isHazard ? color.withOpacity(0.4) : Colors.grey[300]!, width: 1),
      ),
      child: InkWell(
        borderRadius: BorderRadius.circular(10),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(
            children: [
              Container(
                width: 4, height: 52,
                decoration: BoxDecoration(
                  color: isHazard ? color : Colors.green,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Expanded(
                        child: Text(
                          hazardTypeMnH[type] ?? type ?? 'Тодорхойгүй',
                          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      if (alerted) const Icon(Icons.sms, size: 14, color: Colors.red),
                    ]),
                    const SizedBox(height: 4),
                    // ── FIXED: use Flexible so text never overflows ──
                    Row(children: [
                      const Icon(Icons.location_on_outlined, size: 13, color: Colors.grey),
                      const SizedBox(width: 2),
                      Flexible(child: Text(tsekh,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12, color: Colors.grey))),
                      const SizedBox(width: 8),
                      const Icon(Icons.access_time, size: 13, color: Colors.grey),
                      const SizedBox(width: 2),
                      Flexible(child: Text(_timeAgo(report['createdAt'] as String?),
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 12, color: Colors.grey))),
                    ]),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                decoration: BoxDecoration(
                  color: isHazard ? color.withOpacity(0.12) : Colors.green[50],
                  borderRadius: BorderRadius.circular(6),
                  border: Border.all(color: isHazard ? color.withOpacity(0.4) : Colors.green[200]!),
                ),
                child: Text(
                  isHazard ? (severityMnH[severity] ?? severity ?? '') : 'АЮУЛГҮЙ',
                  style: TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    color: isHazard ? color : Colors.green[700],
                  ),
                ),
              ),
              const SizedBox(width: 4),
              Icon(Icons.chevron_right, color: Colors.grey[400], size: 18),
            ],
          ),
        ),
      ),
    );
  }
}

class ReportDetailScreen extends StatelessWidget {
  final Map<String, dynamic> report;
  const ReportDetailScreen({super.key, required this.report});

  @override
  Widget build(BuildContext context) {
    final severity = report['severity'] as String?;
    final type = report['type'] as String?;
    final isHazard = report['is_hazard'] == true;
    final alerted = report['alerted'] == true;
    final tsekh = report['tsekh'] as String? ?? '';
    final reasoning = report['reasoning'] as String? ?? '';
    final transcript = report['transcript'] as String? ?? '';
    final confidence = report['confidence'];
    final wasEdited = report['wasEdited'] == true;
    final aiOriginal = report['aiOriginal'] as Map<String, dynamic>?;
    final smsNumbers = (report['smsNumbers'] as List?)?.cast<String>() ?? [];
    final color = severityColorH(severity);

    return Scaffold(
      appBar: AppBar(
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
        title: const Text('Дэлгэрэнгүй'),
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
                color: isHazard ? color.withOpacity(0.1) : Colors.green[50],
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: isHazard ? color.withOpacity(0.4) : Colors.green[200]!),
              ),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Icon(isHazard ? Icons.warning_amber_rounded : Icons.check_circle_outline,
                      color: isHazard ? color : Colors.green[700], size: 22),
                  const SizedBox(width: 8),
                  Expanded(child: Text(
                    isHazard ? (hazardTypeMnH[type] ?? type ?? '') : 'Аюул илрээгүй',
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.bold),
                  )),
                ]),
                const SizedBox(height: 8),
                Wrap(spacing: 8, children: [
                  _chip(severityMnH[severity] ?? severity ?? '', color),
                  if (confidence != null)
                    _chip('${((confidence as num) * 100).toStringAsFixed(0)}% итгэлцэл', Colors.blueGrey),
                ]),
              ]),
            ),
            const SizedBox(height: 12),
            _detailRow(Icons.location_on_outlined, 'Цех', tsekh),
            _detailRow(Icons.access_time, 'Огноо', _timeAgo(report['createdAt'] as String?)),
            const SizedBox(height: 16),

            if (reasoning.isNotEmpty) ...[
              const Text('Дүн шинжилгээ', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.grey[50],
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.grey[200]!),
                ),
                child: Text(reasoning, style: const TextStyle(height: 1.5)),
              ),
              const SizedBox(height: 16),
            ],

            if (transcript.isNotEmpty) ...[
              const Text('Дуу хоолойн бичвэр', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.blue[50],
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text('"$transcript"',
                    style: TextStyle(color: Colors.blue[900], fontStyle: FontStyle.italic, height: 1.4)),
              ),
              const SizedBox(height: 16),
            ],

            if (wasEdited && aiOriginal != null) ...[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Colors.amber[50],
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: Colors.amber[200]!),
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Icon(Icons.edit, size: 14, color: Colors.amber[800]),
                    const SizedBox(width: 6),
                    Text('Ажилтан AI-н санал болгосныг өөрчилсөн',
                        style: TextStyle(fontWeight: FontWeight.w600, color: Colors.amber[900], fontSize: 13)),
                  ]),
                  const SizedBox(height: 6),
                  Text('AI санал болгосон төрөл: ${hazardTypeMnH[aiOriginal['type']] ?? aiOriginal['type']}',
                      style: TextStyle(fontSize: 12, color: Colors.amber[800])),
                  Text('AI санал болгосон түвшин: ${severityMnH[aiOriginal['severity']] ?? aiOriginal['severity']}',
                      style: TextStyle(fontSize: 12, color: Colors.amber[800])),
                ]),
              ),
              const SizedBox(height: 16),
            ],

            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: alerted ? Colors.red[50] : Colors.grey[50],
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: alerted ? Colors.red[200]! : Colors.grey[200]!),
              ),
              child: Row(children: [
                Icon(alerted ? Icons.sms : Icons.sms_failed_outlined,
                    size: 18, color: alerted ? Colors.red[700] : Colors.grey),
                const SizedBox(width: 8),
                Expanded(child: Text(
                  alerted
                      ? 'SMS мэдэгдэл ${smsNumbers.length} хүнд илгээгдсэн'
                      : 'SMS илгээгдээгүй (аюулын түвшин хангалтгүй)',
                  style: TextStyle(
                    color: alerted ? Colors.red[700] : Colors.grey[600],
                    fontWeight: alerted ? FontWeight.w600 : FontWeight.normal,
                  ),
                )),
              ]),
            ),
          ],
        ),
      ),
    );
  }

  Widget _detailRow(IconData icon, String label, String value) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: [
        Icon(icon, size: 16, color: Colors.grey[600]),
        const SizedBox(width: 6),
        Text('$label: ', style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
        Expanded(child: Text(value, style: const TextStyle(fontSize: 13), overflow: TextOverflow.ellipsis)),
      ]),
    );
  }

  Widget _chip(String label, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withOpacity(0.12),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: color.withOpacity(0.4)),
      ),
      child: Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: color)),
    );
  }
}