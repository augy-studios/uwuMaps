// The map's whole style, as one document: OpenFreeMap's style with its sources pointed at the app's own
// tile addresses, then the 3D buildings, public transport, saved places, the route and the markers. On
// the website these are added to the map one at a time; here they're in the style from the start.

import 'dart:convert';

import 'package:flutter/services.dart';

import 'tile_server.dart';

const double _floorMetres = 3.2;
const double _defaultHeight = 6;
const double _roofCapMetres = 0.5;
const int _buildingsMinZoom = 14;
const String _baseAttribution = '<a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const Map<String, Map<String, String>> _tints = {
  'light': {
    'residential': '#f3e3cf', 'commercial': '#c9dcf2', 'industrial': '#d5d0e0', 'education': '#f6e6a8',
    'medical': '#f6cfd4', 'civic': '#d3e8d0', 'religious': '#ecd5ee', 'transportation': '#cfe6e8',
    'agricultural': '#e4e6bf', 'military': '#cfd4c2', 'entertainment': '#f6d3bb', 'service': '#dddad2', 'outbuilding': '#e6e1d6',
    'other': '#e8e4dc',
  },
  'dark': {
    'residential': '#5c5246', 'commercial': '#46566b', 'industrial': '#4e4a5a', 'education': '#6b6238',
    'medical': '#6a4a50', 'civic': '#46604a', 'religious': '#5e4a60', 'transportation': '#3f5a5e',
    'agricultural': '#585a38', 'military': '#4a4f3f', 'entertainment': '#6b5140', 'service': '#504e48', 'outbuilding': '#55524a',
    'other': '#55524c',
  },
};

// A roof with no colour of its own: the walls' tint, a step darker, so the shape still reads from above.
String _shade(String hex) {
  final n = int.parse(hex.substring(1), radix: 16);
  String f(int v) => (v * 0.88).round().toRadixString(16).padLeft(2, '0');
  return '#${f((n >> 16) & 255)}${f((n >> 8) & 255)}${f(n & 255)}';
}

List<Object> _tint(String mode, bool darken) {
  final t = _tints[mode]!;
  final cases = <Object>[
    'match',
    ['coalesce', ['get', 'subtype'], 'other'],
  ];
  t.forEach((kind, colour) {
    if (kind != 'other') cases.addAll([kind, darken ? _shade(colour) : colour]);
  });
  cases.add(darken ? _shade(t['other']!) : t['other']!);
  return cases;
}

// By "has", not "coalesce": to-number makes a missing value 0, which coalesce would stop at, laying
// flat everything without a stated height.
List<Object> _metres(String key, String floorsKey, num otherwise) => [
      'case',
      ['has', key],
      ['to-number', ['get', key]],
      ['has', floorsKey],
      ['*', ['to-number', ['get', floorsKey]], _floorMetres],
      otherwise,
    ];

const Map<String, dynamic> _emptyGeo = {'type': 'geojson', 'data': {'type': 'FeatureCollection', 'features': <Object>[]}};

/// Everything somebody can turn on and off.
class LayerOption {
  const LayerOption(this.id, this.group, this.label, {this.live = false});
  final String id;
  final String group;
  final String label;
  final bool live;
}

const List<LayerOption> layerOptions = [
  LayerOption('buildings', 'Map', '3D buildings'),
  LayerOption('saved', 'Map', 'Saved places'),
  LayerOption('sg-lines', 'Singapore', 'MRT and LRT lines'),
  LayerOption('sg-stations', 'Singapore', 'Train stations'),
  LayerOption('sg-exits', 'Singapore', 'Station exits'),
  LayerOption('sg-stops', 'Singapore', 'Bus stops'),
  LayerOption('my-lines', 'Malaysia', 'Train lines'),
  LayerOption('my-stations', 'Malaysia', 'Train stations'),
  LayerOption('my-stops', 'Malaysia', 'Bus stops'),
  LayerOption('my-live-trains', 'Malaysia', 'Live trains', live: true),
  LayerOption('my-live-buses', 'Malaysia', 'Live buses', live: true),
];

/// Each option's layers on the map.
const Map<String, List<String>> mapLayersOf = {
  'buildings': ['buildings-walls', 'buildings-roofs', 'parts-walls', 'parts-roofs'],
  'saved': ['saved'],
  'sg-lines': ['sg-lines'],
  'sg-stations': ['sg-stations', 'sg-station-labels'],
  'sg-exits': ['sg-exits'],
  'sg-stops': ['sg-stops', 'sg-stop-labels'],
  'my-lines': ['my-lines'],
  'my-stations': ['my-stations', 'my-station-labels'],
  'my-stops': ['my-stops', 'my-stop-labels'],
  'my-live-trains': ['my-live-trains', 'my-live-trains-arrow'],
  'my-live-buses': ['my-live-buses', 'my-live-buses-arrow'],
};

class BuiltStyle {
  BuiltStyle(this.json, this.symbolLayers);
  final String json;

  /// The named things on the base map, for tapping a place.
  final List<String> symbolLayers;
}

Future<BuiltStyle> buildStyle({required bool dark, required bool Function(String) isOn}) async {
  final name = dark ? 'dark' : 'liberty';
  final style = jsonDecode(await rootBundle.loadString('assets/map/styles/$name.json')) as Map<String, dynamic>;
  style['sprite'] = TileServer.sprite;
  style['glyphs'] = TileServer.glyphs;
  final sources = <String, dynamic>{
    'openmaptiles': {
      'type': 'vector',
      'tiles': [TileServer.baseTiles],
      'minzoom': 0,
      'maxzoom': 14,
      'attribution': _baseAttribution,
    },
    'buildings': {
      'type': 'vector',
      'tiles': [TileServer.buildingTiles],
      'minzoom': _buildingsMinZoom,
      'maxzoom': _buildingsMinZoom,
      'attribution': '&copy; <a href="https://overturemaps.org">Overture Maps Foundation</a>',
    },
    for (final id in ['sg-lines', 'sg-stations', 'sg-exits', 'sg-stops', 'my-lines', 'my-stations', 'my-stops', 'my-live-trains', 'my-live-buses', 'saved', 'route', 'markers']) id: _emptyGeo,
  };
  style['sources'] = sources;

  // The shaded relief is online only and adds little, and the plain 3D buildings make way for ours.
  final base = (style['layers'] as List<dynamic>).cast<Map<String, dynamic>>().where((l) => (l['source'] == null || l['source'] == 'openmaptiles') && l['id'] != 'building-3d' && l['type'] != 'raster').toList();

  // Above everything flat, or the roads and building fills paint over the 3D, and below what's left of
  // the labels. Not simply the first label: the dark style has one early on, under its roads.
  var lastFlat = -1;
  for (var i = 0; i < base.length; i++) {
    if (base[i]['type'] != 'symbol') lastFlat = i;
  }

  final mode = dark ? 'dark' : 'light';
  final heightOf = _metres('height', 'num_floors', _defaultHeight);
  final baseOf = _metres('min_height', 'min_floor', 0);
  final capBase = ['max', ['-', heightOf, _roofCapMetres], baseOf];
  final wall = ['to-color', ['coalesce', ['get', 'facade_color'], ['get', 'roof_color'], _tint(mode, false)]];
  final roof = ['to-color', ['coalesce', ['get', 'roof_color'], ['get', 'facade_color'], _tint(mode, true)]];
  // A building split into parts is drawn by its parts alone.
  final visible = ['all', ['!=', ['get', 'has_parts'], true], ['!=', ['get', 'is_underground'], true]];
  final partVisible = ['!=', ['get', 'is_underground'], true];
  String vis(String id) => isOn(id) ? 'visible' : 'none';
  Map<String, dynamic> extrusion(String id, String sourceLayer, Object filter, Object colour, Object bottom, Object top, bool gradient) => {
        'id': id,
        'type': 'fill-extrusion',
        'source': 'buildings',
        'source-layer': sourceLayer,
        'minzoom': _buildingsMinZoom,
        'filter': filter,
        'layout': {'visibility': vis('buildings')},
        'paint': {
          'fill-extrusion-color': colour,
          'fill-extrusion-base': bottom,
          'fill-extrusion-height': top,
          'fill-extrusion-vertical-gradient': gradient,
          // Solid, so all four layers share one depth buffer and draw each other in the right order.
          'fill-extrusion-opacity': 1,
        },
      };
  base.insertAll(lastFlat + 1, [
    extrusion('buildings-walls', 'building', visible, wall, baseOf, heightOf, true),
    extrusion('buildings-roofs', 'building', visible, roof, capBase, heightOf, false),
    extrusion('parts-walls', 'building_part', partVisible, wall, baseOf, heightOf, true),
    extrusion('parts-roofs', 'building_part', partVisible, roof, capBase, heightOf, false),
  ]);

  final symbolLayers = base.where((l) => l['type'] == 'symbol').map((l) => l['id'] as String).toList();

  final halo = dark ? '#0c100e' : '#ffffff';
  final ink = dark ? '#eef2ef' : '#121815';
  final dotFill = dark ? '#121815' : '#ffffff';
  Map<String, dynamic> label(String id, String layerId, String source, num minzoom, [num size = 11]) => {
        'id': id,
        'type': 'symbol',
        'source': source,
        'minzoom': minzoom,
        'layout': {
          'visibility': vis(layerId),
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': size,
          'text-offset': [0, 1],
          'text-anchor': 'top',
          'text-optional': true,
        },
        'paint': {'text-color': ink, 'text-halo-color': halo, 'text-halo-width': 1.4},
      };
  List<Object> stops(num a, num x, num b, num y) => ['interpolate', ['linear'], ['zoom'], a, x, b, y];
  Map<String, dynamic> line(String id, num minzoom, num thin) => {
        'id': id,
        'type': 'line',
        'source': id,
        'minzoom': minzoom,
        'layout': {'visibility': vis(id), 'line-cap': 'round', 'line-join': 'round'},
        'paint': {'line-color': ['get', 'color'], 'line-width': stops(id == 'sg-lines' ? 10 : 8, thin, 16, 5)},
      };
  Map<String, dynamic> stopDots(String id) => {
        'id': id,
        'type': 'circle',
        'source': id,
        'minzoom': 14.5,
        'layout': {'visibility': vis(id)},
        'paint': {'circle-radius': stops(14.5, 2.5, 18, 6), 'circle-color': '#2e9e5b', 'circle-stroke-color': dotFill, 'circle-stroke-width': 1.2},
      };
  Map<String, dynamic> stationDots(String id, num z, num r, num w) => {
        'id': id,
        'type': 'circle',
        'source': id,
        'minzoom': z,
        'layout': {'visibility': vis(id)},
        'paint': {'circle-radius': stops(z, r, 16, 7), 'circle-color': dotFill, 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': stops(z, w, 16, 3)},
      };
  List<Map<String, dynamic>> live(String id, String colour, num minzoom) => [
        {
          'id': id,
          'type': 'circle',
          'source': id,
          'minzoom': minzoom,
          'layout': {'visibility': vis(id)},
          'paint': {'circle-radius': stops(8, 4, 16, 10), 'circle-color': colour, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5},
        },
        {
          'id': '$id-arrow',
          'type': 'symbol',
          'source': id,
          'minzoom': minzoom > 11 ? minzoom : 11,
          'filter': ['has', 'bearing'],
          'layout': {
            'visibility': vis(id),
            'icon-image': 'uwu-arrow',
            'icon-size': stops(11, 0.55, 16, 1),
            'icon-rotate': ['get', 'bearing'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
          },
        },
      ];

  base.addAll([
    line('sg-lines', 9, 1.5),
    line('my-lines', 6, 1.2),
    stopDots('sg-stops'),
    label('sg-stop-labels', 'sg-stops', 'sg-stops', 17),
    stopDots('my-stops'),
    label('my-stop-labels', 'my-stops', 'my-stops', 17),
    {
      'id': 'sg-exits',
      'type': 'circle',
      'source': 'sg-exits',
      'minzoom': 16,
      'layout': {'visibility': vis('sg-exits')},
      'paint': {'circle-radius': 3.5, 'circle-color': ['get', 'color'], 'circle-stroke-color': dotFill, 'circle-stroke-width': 1},
    },
    stationDots('sg-stations', 10, 2.5, 1.2),
    label('sg-station-labels', 'sg-stations', 'sg-stations', 13, 12),
    stationDots('my-stations', 8, 2, 1),
    label('my-station-labels', 'my-stations', 'my-stations', 12, 12),
    ...live('my-live-trains', '#1b5e9f', 6),
    ...live('my-live-buses', '#d9480f', 9),
    {
      'id': 'saved',
      'type': 'circle',
      'source': 'saved',
      'layout': {'visibility': vis('saved')},
      'paint': {'circle-radius': 7, 'circle-color': '#e8486f', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2},
    },
    {
      'id': 'route-casing',
      'type': 'line',
      'source': 'route',
      'layout': {'line-cap': 'round', 'line-join': 'round'},
      'paint': {'line-color': '#0b3d91', 'line-width': stops(8, 5, 16, 12)},
    },
    {
      'id': 'route-line',
      'type': 'line',
      'source': 'route',
      'layout': {'line-cap': 'round', 'line-join': 'round'},
      'paint': {'line-color': '#3b8bff', 'line-width': stops(8, 3, 16, 8)},
    },
    {
      'id': 'markers-you',
      'type': 'symbol',
      'source': 'markers',
      'filter': ['==', ['get', 'kind'], 'you'],
      'layout': {'icon-image': 'uwu-you', 'icon-allow-overlap': true, 'icon-ignore-placement': true},
    },
    {
      'id': 'markers-pins',
      'type': 'symbol',
      'source': 'markers',
      'filter': ['!=', ['get', 'kind'], 'you'],
      'layout': {'icon-image': ['get', 'icon'], 'icon-anchor': 'bottom', 'icon-allow-overlap': true, 'icon-ignore-placement': true},
    },
  ]);
  style['layers'] = base;
  return BuiltStyle(jsonEncode(style), symbolLayers);
}
