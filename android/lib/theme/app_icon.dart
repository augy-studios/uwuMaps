// One icon by name: the site's own SVG in the uwuapps theme, and Material's in Material You.

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

import 'icon_paths.g.dart';
import 'tokens.dart';

const Map<String, IconData> _material = {
  'sun': Icons.light_mode_outlined,
  'moon': Icons.dark_mode_outlined,
  'close': Icons.close,
  'clock': Icons.schedule,
  'search': Icons.search,
  'directions': Icons.directions_outlined,
  'bookmark': Icons.bookmark_outline,
  'download': Icons.download_for_offline_outlined,
  'update': Icons.system_update_outlined,
  'locate': Icons.my_location,
  'share': Icons.share_outlined,
  'nearby': Icons.wifi_tethering,
  'car': Icons.directions_car_outlined,
  'bike': Icons.directions_bike,
  'walk': Icons.directions_walk,
  'navigate': Icons.navigation_outlined,
  'stop': Icons.stop_rounded,
  'swap': Icons.swap_vert,
  'trash': Icons.delete_outline,
  'copy': Icons.content_copy,
  'sound': Icons.volume_up_outlined,
  'mute': Icons.volume_off_outlined,
  'plus': Icons.add,
  'minus': Icons.remove,
  'compass': Icons.explore_outlined,
  'sync': Icons.sync,
  'pin': Icons.place_outlined,
  'list': Icons.list,
  'layers': Icons.layers_outlined,
  'train': Icons.train_outlined,
  'bus': Icons.directions_bus_outlined,
  'turnLeft': Icons.turn_left,
  'turnRight': Icons.turn_right,
  'straight': Icons.straight,
  'slightLeft': Icons.turn_slight_left,
  'slightRight': Icons.turn_slight_right,
  'uturn': Icons.u_turn_left,
  'roundabout': Icons.roundabout_right,
  'arrive': Icons.flag_outlined,
  'escalator': Icons.escalator,
  'lift': Icons.elevator_outlined,
  'stairs': Icons.stairs_outlined,
  'across': Icons.swap_horiz,
  'back': Icons.arrow_back,
  'forward': Icons.arrow_forward,
  'qr': Icons.qr_code_scanner,
  'settings': Icons.tune,
};

// The few icons the site doesn't have: the update check's from the Android spec, and the app's map
// controls and scanner, in the same hand.
const Map<String, String> _extra = {
  'update': '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v8M8.5 12l3.5 3.5 3.5-3.5"/>',
  'minus': '<path d="M5 12h14"/>',
  'compass': '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  'qr': '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M4 12h16"/>',
};

String _svgFor(String name) {
  final body = _extra[name];
  if (body != null) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">$body</svg>';
  }
  return uwuIconSvgs[name] ?? uwuIconSvgs['pin']!;
}

class AppIcon extends StatelessWidget {
  const AppIcon(this.name, {super.key, this.size = 20, this.color});

  final String name;
  final double size;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final colour = color ?? IconTheme.of(context).color ?? context.t.ink;
    if (context.t.material) {
      return Icon(_material[name] ?? Icons.circle_outlined, size: size, color: colour);
    }
    final hex = colour.toARGB32().toRadixString(16).padLeft(8, '0').substring(2);
    return SvgPicture.string(
      _svgFor(name).replaceAll('currentColor', '#$hex'),
      width: size,
      height: size,
      excludeFromSemantics: true,
    );
  }
}
