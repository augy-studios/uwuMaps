// A Singapore station's train doors: which doors stop nearest the lifts, stairs and escalators. A port of
// the data side of main-site/js/mrt-doors.js, itself following SG Bus Timings. Keep them in step.

import 'package:flutter/painting.dart';

const Map<String, int> _doors = {'CC': 12, 'DT': 12, 'TE': 20};
const List<String> _order = ['escalator', 'lift', 'stairs'];
const Map<String, String> doorType = {'escalator': 'Escalator', 'lift': 'Lift', 'stairs': 'Stairs'};
const Map<String, String> _lineLabels = {'EWL': 'EW Line', 'NSL': 'NS Line', 'NEL': 'NE Line', 'CCL': 'CC Line', 'DTL': 'DT Line', 'TEL': 'TE Line', 'BPL': 'BP LRT', 'STL': 'SK LRT', 'PTL': 'PG LRT'};
const Map<String, Color> _lineColours = {'EW': Color(0xFF009645), 'CG': Color(0xFF009645), 'NS': Color(0xFFD42E12), 'NE': Color(0xFF9900AA), 'CC': Color(0xFFFA9E0D), 'CE': Color(0xFFFA9E0D), 'DT': Color(0xFF005EC4), 'TE': Color(0xFF9D5B25), 'JS': Color(0xFF0099AA), 'JE': Color(0xFF0099AA), 'JW': Color(0xFF0099AA), 'CR': Color(0xFF97C616), 'CP': Color(0xFF97C616)};
const Color _lrt = Color(0xFF748477);

String _lineName(String l) => _lineLabels['${l}L'] ?? '${l}L';

Color lineColourOf(String code) {
  final m = RegExp('^[A-Z]+').stringMatch(code.toUpperCase()) ?? '';
  return _lineColours[m.length > 2 ? m.substring(0, 2) : m] ?? _lrt;
}

String listText(List<String> xs) => xs.length < 2 ? xs.join() : '${xs.sublist(0, xs.length - 1).join(', ')} and ${xs.last}';

class DoorRow {
  DoorRow(this.type, this.leads, this.doors);
  final String type;
  final List<String> leads;
  List<int> doors;

  String get where => '${doorType[type] ?? type} to ${listText(leads.map(_leadText).toList())}';
}

class DoorSlide {
  DoorSlide({required this.code, required this.towards, required this.next, required this.last, required this.rows, required this.numberAt, required this.cross});
  final String code;
  final String towards;
  final String? next;
  final bool last;
  final List<DoorRow> rows;

  /// above, corner or post: where on the platform door its number is. Null where it isn't known.
  final String? numberAt;
  final List<String> cross;
}

const Map<String, String> numberAtWords = {
  'above': 'on the panel above the doors',
  'corner': 'at the top right of each door',
  'post': 'near the top of the post beside each door',
};

String _leadText(String x) {
  if (x == 'Exit') return 'the exit';
  final toward = RegExp(r'^(.*\b(?:Line|LRT)) towards (.+)$').firstMatch(x);
  if (toward != null) return 'the ${toward[1]} towards ${toward[2]}';
  return RegExp(r'\b(Line|LRT)$').hasMatch(x) ? 'the $x' : x;
}

String? _numberAt(Map<String, dynamic> p) {
  if (p['e'] == 1) return 'post';
  if (['NE', 'CC', 'DT', 'TE'].contains(p['l'])) return 'corner';
  if (p['e'] == 0) return 'above';
  return null;
}

// The way a direction goes, from station `here`: towards its far end, or on a loop, whose two ways
// both end at Promenade, towards its next station from here.
String _towardsFrom(List<Map<String, dynamic>> list, String here) {
  final end = list.last;
  if (list.first['n'] != end['n']) return end['n'] as String;
  final at = list.where((q) => q['n'] == here).firstOrNull;
  if (at != null) {
    final next = list.where((q) => (q['o'] as num) > (at['o'] as num)).firstOrNull;
    if (next != null) return next['n'] as String;
  }
  return end['n'] as String;
}

List<String> _leadsOf(Map<String, dynamic> f, Map<String, List<Map<String, dynamic>>> byDir, String here) {
  final out = <Object>[];
  final lines = <String, List<String>>{};
  final ways = (f['to'] ?? '').toString().split('/').map((s) => s.trim()).where((s) => s.isNotEmpty);
  for (final w in ways) {
    if (byDir.containsKey(w)) {
      final l = byDir[w]!.first['l'] as String;
      if (!lines.containsKey(l)) out.add(_LineLead(l));
      (lines[l] ??= []).add(w);
    } else {
      final text = w.toLowerCase() == 'exit' ? 'Exit' : w;
      if (!out.contains(text)) out.add(text);
    }
  }
  final words = out.map((x) {
    if (x is String) return x;
    final line = (x as _LineLead).line;
    final dirs = lines[line]!;
    if (dirs.length > 1) return _lineName(line);
    return '${_lineName(line)} towards ${_towardsFrom(byDir[dirs.first]!, here)}';
  }).toList();
  return words.isEmpty ? ['Exit'] : words;
}

class _LineLead {
  _LineLead(this.line);
  final String line;
}

/// Every platform at a station, by its codes: one for each way a train goes from it.
List<DoorSlide> stationPlatforms(List<String> codes, List<dynamic> rawPlatforms) {
  final platforms = rawPlatforms.cast<Map<String, dynamic>>();
  final want = codes.map((c) => c.toUpperCase()).toList();
  final byDir = <String, List<Map<String, dynamic>>>{};
  for (final p in platforms) {
    (byDir[p['d'] as String] ??= []).add(p);
  }
  for (final list in byDir.values) {
    list.sort((a, b) => (a['o'] as num).compareTo(b['o'] as num));
  }
  int rank(String t) => _order.contains(t) ? _order.indexOf(t) : _order.length;

  final picked = platforms.where((p) => want.contains((p['c'] as String).toUpperCase())).toList()
    ..sort((a, b) {
      var c = want.indexOf((a['c'] as String).toUpperCase()) - want.indexOf((b['c'] as String).toUpperCase());
      if (c != 0) return c;
      c = (a['d'] as String).compareTo(b['d'] as String);
      if (c != 0) return c;
      return (a['o'] as num).compareTo(b['o'] as num);
    });

  return picked.map((p) {
    final list = byDir[p['d']] ?? [p];
    final end = list.last;
    final next = list.where((q) => (q['o'] as num) > (p['o'] as num)).firstOrNull;
    final max = _doors[p['l']] ?? 24;
    final groups = <String, DoorRow>{};
    for (final raw in p['f'] as List<dynamic>) {
      final f = raw as Map<String, dynamic>;
      final doors = (f['doors'] as List<dynamic>).whereType<num>().where((n) => n == n.toInt() && n >= 1 && n <= max).map((n) => n.toInt()).toSet().toList();
      if (doors.isEmpty) continue;
      final leads = _leadsOf(f, byDir, p['n'] as String);
      final key = '${f['t']}|${leads.join('/')}';
      final g = groups[key] ??= DoorRow(f['t'] as String, leads, []);
      g.doors = ({...g.doors, ...doors}.toList()..sort());
    }
    final rows = groups.values.toList()
      ..sort((a, b) {
        final c = rank(a.type) - rank(b.type);
        return c != 0 ? c : a.leads.join(',').compareTo(b.leads.join(','));
      });
    final cross = (p['x'] as List<dynamic>).map((d) => byDir[d]).whereType<List<Map<String, dynamic>>>().map((l) => '${_lineName(l.first['l'] as String)} towards ${_towardsFrom(l, p['n'] as String)}').toList();
    return DoorSlide(code: p['c'] as String, towards: end['n'] as String, next: next?['n'] as String?, last: next == null, rows: rows, numberAt: _numberAt(p), cross: cross);
  }).toList();
}
