import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

class NotificationsScreen extends StatefulWidget {
  final String backendBase;
  final String phone;

  const NotificationsScreen({super.key, required this.backendBase, required this.phone});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  List<dynamic> _notifications = [];
  bool _isLoading = true;
  String? _errorMessage;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _isLoading = true; _errorMessage = null; });
    try {
      final res = await http.get(Uri.parse('${widget.backendBase}/api/notifications/${widget.phone}'));
      if (res.statusCode == 200) {
        setState(() => _notifications = jsonDecode(res.body) as List);
        // Mark all as read now that the person has opened the list.
        for (final n in _notifications) {
          if (n['read'] != true) _markRead(n['_id']);
        }
      } else {
        setState(() => _errorMessage = 'Мэдэгдэл татахад алдаа гарлаа.');
      }
    } catch (e) {
      setState(() => _errorMessage = 'Серверт холбогдож чадсангүй.');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _markRead(String id) async {
    try {
      await http.post(Uri.parse('${widget.backendBase}/api/notifications/$id/read'));
    } catch (_) {
      // Non-critical.
    }
  }

  String _timeAgo(String isoDate) {
    final date = DateTime.tryParse(isoDate);
    if (date == null) return '';
    final diff = DateTime.now().difference(date);
    if (diff.inMinutes < 60) return '${diff.inMinutes} мин өмнө';
    if (diff.inHours < 24) return '${diff.inHours} ц өмнө';
    return '${diff.inDays} өдрийн өмнө';
  }

  Color _severityColor(String? severity) {
    switch (severity) {
      case 'critical': return Colors.red[700]!;
      case 'high':     return Colors.orange[800]!;
      case 'medium':   return Colors.amber[700]!;
      default:         return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Мэдэгдэл'),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _errorMessage != null
              ? Center(child: Text(_errorMessage!))
              : _notifications.isEmpty
                  ? const Center(child: Text('Мэдэгдэл алга байна.'))
                  : RefreshIndicator(
                      onRefresh: _load,
                      child: ListView.separated(
                        padding: const EdgeInsets.all(12),
                        itemCount: _notifications.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 8),
                        itemBuilder: (context, i) {
                          final n = _notifications[i] as Map<String, dynamic>;
                          final wasUnread = n['read'] != true;
                          return Container(
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: wasUnread ? Colors.orange[50] : Colors.white,
                              borderRadius: BorderRadius.circular(10),
                              border: Border.all(
                                color: wasUnread ? Colors.orange[200]! : Colors.grey[300]!,
                              ),
                            ),
                            child: Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Container(
                                  width: 10, height: 10, margin: const EdgeInsets.only(top: 4),
                                  decoration: BoxDecoration(
                                    color: _severityColor(n['severity']),
                                    shape: BoxShape.circle,
                                  ),
                                ),
                                const SizedBox(width: 10),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Text(n['message'] ?? '', style: const TextStyle(fontWeight: FontWeight.w600)),
                                      const SizedBox(height: 4),
                                      Text(_timeAgo(n['createdAt'] ?? ''),
                                          style: TextStyle(fontSize: 12, color: Colors.grey[600])),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          );
                        },
                      ),
                    ),
    );
  }
}