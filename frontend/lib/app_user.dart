// Simple model representing the logged-in person.
// Roles:
//   'ажилтан'     — Ажилтан (employee, reports hazards from their цех)
//   'tsekh_darga' — Цехийн дарга (receives SMS/notifications for their цех)
//   'hub_darga'   — Хаб-ын дарга (receives SMS/notifications for all цехs)
class AppUser {
  final String id;
  final String name;
  final String employeeId;
  final String phone;
  final String role;
  final String roleLabel;
  final String tsekh;

  const AppUser({
    required this.id,
    required this.name,
    required this.employeeId,
    required this.phone,
    required this.role,
    required this.roleLabel,
    required this.tsekh,
  });

  factory AppUser.fromJson(Map<String, dynamic> json) {
    return AppUser(
      id: json['_id']?.toString() ?? '',
      name: json['name'] ?? '',
      employeeId: json['employeeId'] ?? '',
      phone: json['phone'] ?? '',
      role: json['role'] ?? 'ажилтан',
      roleLabel: json['roleLabel'] ?? json['role'] ?? '',
      tsekh: json['tsekh'] ?? '',
    );
  }
}