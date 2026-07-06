import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'app_user.dart';
import 'config.dart';
import 'main.dart';

const Map<String, String> roleMn = {
  'ажилтан':     'Ажилтан',
  'tsekh_darga': 'Цехийн дарга',
  'hub_darga':   'Хаб-ын дарга',
};

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  bool _isRegisterMode = false;
  bool _isLoading = false;
  String? _errorMessage;

  final _employeeIdController = TextEditingController();
  final _phoneController = TextEditingController();
  String _selectedRole = 'ажилтан';
  String? _selectedTsekh;
  List<String> _tsekhList = [];

  @override
  void initState() {
    super.initState();
    _loadTsekhList();
  }

  @override
  void dispose() {
    _employeeIdController.dispose();
    _phoneController.dispose();
    super.dispose();
  }

  Future<void> _loadTsekhList() async {
    try {
      final res = await http.get(Uri.parse('$kBackendBase/api/tsekh'));
      if (res.statusCode == 200) {
        final list = (jsonDecode(res.body) as List).cast<String>();
        if (mounted) setState(() => _tsekhList = list);
      }
    } catch (_) {
      setState(() => _tsekhList = [
        'Уурхай-1', 'Уурхай-2', 'Баяжуулах цех', 'Засварын цех',
        'Цахилгааны цех', 'Тээврийн цех', 'Агуулах', 'Администраци',
      ]);
    }
  }

  void _goToMain(AppUser user) {
    Navigator.pushReplacement(
      context,
      MaterialPageRoute(builder: (_) => HazardReportPage(currentUser: user)),
    );
  }

  Future<void> _login() async {
    final employeeId = _employeeIdController.text.trim();
    if (employeeId.isEmpty) {
      setState(() => _errorMessage = 'Бүртгэлийн дугаараа оруулна уу.');
      return;
    }
    if (!RegExp(r'^\d{5}$').hasMatch(employeeId)) {
      setState(() => _errorMessage = 'Бүртгэлийн дугаар 5 оронтой тоо байх ёстой.');
      return;
    }

    setState(() { _isLoading = true; _errorMessage = null; });
    try {
      final res = await http.post(
        Uri.parse('$kBackendBase/api/login'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'employeeId': employeeId}),
      ).timeout(const Duration(seconds: 20));

      final decoded = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200) {
        _goToMain(AppUser.fromJson(decoded));
      } else {
        setState(() => _errorMessage = decoded['error'] ?? 'Нэвтэрч чадсангүй.');
      }
    } catch (e) {
      setState(() => _errorMessage = 'Серверт холбогдож чадсангүй.\n\n$e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _register() async {
    final employeeId = _employeeIdController.text.trim();
    final phone = _phoneController.text.trim();

    if (employeeId.isEmpty || phone.isEmpty) {
      setState(() => _errorMessage = 'Бүртгэлийн дугаар болон утасны дугаараа оруулна уу.');
      return;
    }
    if (!RegExp(r'^\d{5}$').hasMatch(employeeId)) {
      setState(() => _errorMessage = 'Бүртгэлийн дугаар 5 оронтой тоо байх ёстой. Жишээ: 12345');
      return;
    }
    if (_selectedRole != 'hub_darga' && _selectedTsekh == null) {
      setState(() => _errorMessage = 'Цехээ сонгоно уу.');
      return;
    }

    setState(() { _isLoading = true; _errorMessage = null; });
    try {
      final res = await http.post(
        Uri.parse('$kBackendBase/api/register'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({
          'employeeId': employeeId,
          'phone': '+976$phone',
          'role': _selectedRole,
          'tsekh': _selectedRole == 'hub_darga' ? '' : _selectedTsekh,
        }),
      ).timeout(const Duration(seconds: 20));

      final decoded = jsonDecode(res.body) as Map<String, dynamic>;
      if (res.statusCode == 200) {
        _goToMain(AppUser.fromJson(decoded));
      } else {
        setState(() => _errorMessage = decoded['error'] ?? 'Бүртгэж чадсангүй.');
      }
    } catch (e) {
      setState(() => _errorMessage = 'Серверт холбогдож чадсангүй.\n\n$e');
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.grey[50],
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 32),
              Icon(Icons.warning_amber_rounded, size: 64, color: Colors.deepOrange[700]),
              const SizedBox(height: 12),
              const Text(
                'Уурхайн Аюулын Мэдээлэл',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 22, fontWeight: FontWeight.bold),
              ),
              const SizedBox(height: 4),
              Text(
                '"Эрдэнэт Үйлдвэр" ТӨҮГ',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13, color: Colors.grey[600]),
              ),
              const SizedBox(height: 8),
              Text(
                _isRegisterMode ? 'Шинэ хэрэглэгч бүртгүүлэх' : 'Нэвтрэх',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 14, color: Colors.grey[500]),
              ),
              const SizedBox(height: 32),

              // ── Бүртгэлийн дугаар ──
              const Text('Бүртгэлийн дугаар', style: TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 6),
              TextField(
                controller: _employeeIdController,
                keyboardType: TextInputType.number,
                maxLength: 5,
                decoration: InputDecoration(
                  hintText: '5 оронтой дугаар',
                  prefixIcon: const Icon(Icons.badge_outlined),
                  counterText: '',
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                  contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                ),
                onSubmitted: (_) => _isRegisterMode ? _register() : _login(),
              ),

              if (_isRegisterMode) ...[
                const SizedBox(height: 16),

                // ── Phone ──
                const Text('Утасны дугаар (SMS-д ашиглагдана)', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                TextField(
                  controller: _phoneController,
                  keyboardType: TextInputType.phone,
                  maxLength: 8,
                  decoration: InputDecoration(
                    hintText: '99112233',
                    prefixText: '+976 ',
                    counterText: '',
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  ),
                ),
                const SizedBox(height: 16),

                // ── Role ──
                const Text('Албан тушаал', style: TextStyle(fontWeight: FontWeight.w600)),
                const SizedBox(height: 6),
                DropdownButtonFormField<String>(
                  value: _selectedRole,
                  isExpanded: true,
                  decoration: InputDecoration(
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                  ),
                  items: roleMn.entries
                      .map((e) => DropdownMenuItem(value: e.key, child: Text(e.value)))
                      .toList(),
                  onChanged: (v) => setState(() { _selectedRole = v!; _selectedTsekh = null; }),
                ),
                const SizedBox(height: 4),
                Text(
                  _selectedRole == 'hub_darga'
                      ? 'Хаб-ын дарга бүх цехийн яаралтай мэдэгдлийг хүлээн авна.'
                      : _selectedRole == 'tsekh_darga'
                          ? 'Цехийн дарга зөвхөн өөрийн цехийн мэдэгдлийг хүлээн авна.'
                          : 'Ажилтан аюулын тухай мэдэгдэж, өөрийн түүхээ харах боломжтой.',
                  style: TextStyle(fontSize: 12, color: Colors.grey[600]),
                ),

                // ── Tsekh (only if not hub_darga) ──
                if (_selectedRole != 'hub_darga') ...[
                  const SizedBox(height: 16),
                  const Text('Цех', style: TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 6),
                  DropdownButtonFormField<String>(
                    value: _selectedTsekh,
                    hint: const Text('Цехээ сонгоно уу'),
                    isExpanded: true,
                    decoration: InputDecoration(
                      border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
                      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                    ),
                    items: _tsekhList.map((t) => DropdownMenuItem(value: t, child: Text(t))).toList(),
                    onChanged: (v) => setState(() => _selectedTsekh = v),
                  ),
                ],
              ],

              const SizedBox(height: 28),

              if (_errorMessage != null) ...[
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: Colors.red[50],
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: Colors.red[200]!),
                  ),
                  child: Text(_errorMessage!, style: TextStyle(color: Colors.red[900])),
                ),
                const SizedBox(height: 16),
              ],

              ElevatedButton(
                onPressed: _isLoading ? null : (_isRegisterMode ? _register : _login),
                style: ElevatedButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  backgroundColor: Colors.deepOrange,
                  foregroundColor: Colors.white,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                ),
                child: _isLoading
                    ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2))
                    : Text(_isRegisterMode ? 'Бүртгүүлэх' : 'Нэвтрэх', style: const TextStyle(fontSize: 16)),
              ),
              const SizedBox(height: 12),
              TextButton(
                onPressed: _isLoading
                    ? null
                    : () => setState(() {
                          _isRegisterMode = !_isRegisterMode;
                          _errorMessage = null;
                          _employeeIdController.clear();
                        }),
                child: Text(
                  _isRegisterMode
                      ? 'Бүртгэлтэй хэрэглэгч үү? Нэвтрэх'
                      : 'Анх удаа хэрэглэж байна уу? Бүртгүүлэх',
                  style: const TextStyle(color: Colors.deepOrange),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}