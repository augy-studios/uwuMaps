// The modal sheets the tray opens: Settings, Layers, Offline maps, Saved places, Share and a shared list.

import 'package:flutter/material.dart';

import '../app.dart';
import '../core/format.dart';
import '../core/models.dart';
import '../core/net.dart';
import '../map/map_style.dart';
import '../packs/pack_list.dart';
import '../places/places.dart';
import '../share/links.dart';
import '../share/share.dart';
import '../theme/theme_controller.dart';
import '../theme/tokens.dart';
import 'nearby_sheet.dart';
import 'widgets.dart';

/* ---- Settings ---- */

Future<void> openSettings(BuildContext context) => showAppSheet<void>(context, title: 'Settings', builder: (_) => const _SettingsBody());

class _SettingsBody extends StatelessWidget {
  const _SettingsBody();

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([app.theme, app.updater]),
      builder: (context, _) {
        final th = app.theme;
        final t = context.t;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwitchRow(
              label: 'Material You',
              sub: th.materialYou ? 'Your phone’s colours and font, drawn the way Android’s own apps are.' : 'Off: the usual uwuapps look, with its glass and its Jua font.',
              value: th.materialYou,
              onChanged: th.setMaterialYou,
            ),
            const SizedBox(height: 10),
            const SectionLabel('Mode'),
            const SizedBox(height: 6),
            SegmentPicker<String>(
              value: th.modePreference,
              onChanged: th.setMode,
              segments: [
                if (th.materialYou) const Segment('phone', 'Phone', icon: 'settings'),
                const Segment('light', 'Light', icon: 'sun'),
                const Segment('dark', 'Dark', icon: 'moon'),
                Segment('time', th.materialYou ? 'Time' : 'Time-based', icon: 'clock', wide: true),
              ],
            ),
            if (th.modePreference == 'time') ...[
              const SizedBox(height: 8),
              Text('Following the clock. Currently ${th.isDark ? 'dark' : 'light'}.', style: TextStyle(fontSize: 13.6, color: t.muted)),
            ],
            const SizedBox(height: 10),
            if (th.materialYou) ...[
              SwitchRow(
                label: 'Your phone’s colours',
                sub: 'From your wallpaper, on Android 12 and later.',
                value: th.phoneColours,
                onChanged: th.setPhoneColours,
              ),
              const SizedBox(height: 4),
              SwitchRow(
                label: 'Your phone’s font',
                value: th.phoneFont,
                onChanged: th.setPhoneFont,
              ),
              if (!th.phoneColours) ...[
                const SizedBox(height: 10),
                const SectionLabel('Colour'),
                const SizedBox(height: 6),
                _Swatches(active: th.materialSwatch, onPick: th.setSwatch),
              ],
            ] else ...[
              const SectionLabel('Brand colour'),
              const SizedBox(height: 6),
              _Swatches(active: th.colorTheme, onPick: th.setSwatch),
            ],
            const SizedBox(height: 14),
            Muted('uwuMaps ${app.updater.version}'),
          ],
        );
      },
    );
  }
}

class _Swatches extends StatelessWidget {
  const _Swatches({required this.active, required this.onPick});
  final String active;
  final ValueChanged<String> onPick;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final one = MediaQuery.of(context).size.width <= 480;
    return LayoutBuilder(
      builder: (context, box) {
        final w = one ? box.maxWidth : (box.maxWidth - 8) / 2;
        return Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final s in brandSwatches)
              SizedBox(
                width: w,
                child: Semantics(
                  container: true,
                  button: true,
                  selected: s.id == active,
                  label: s.label,
                  excludeSemantics: true,
                  onTap: () => onPick(s.id),
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () => onPick(s.id),
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 150),
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: t.surface,
                        borderRadius: BorderRadius.circular(14),
                        border: Border.all(color: s.id == active ? s.color : t.surfaceBorder, width: s.id == active ? 2 : 1),
                      ),
                      // Ringed in its own colour, plus a containment ring: the pale swatches reach only 1:1
                      // against a light surface on their own. Outside the box, as a shadow would show
                      // through its see-through surface.
                      foregroundDecoration: s.id == active
                          ? BoxDecoration(
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(color: mix(t.ink, 0.5, transparentInk), strokeAlign: BorderSide.strokeAlignOutside),
                            )
                          : null,
                      child: Row(
                        children: [
                          Container(width: 20, height: 20, decoration: BoxDecoration(color: s.color, shape: BoxShape.circle, border: Border.all(color: mix(t.ink, 0.3, transparentInk)))),
                          const SizedBox(width: 8),
                          Flexible(child: Text(s.label, style: TextStyle(fontSize: 12.5, color: t.ink))),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }
}

/* ---- Layers ---- */

Future<void> openLayers(BuildContext context) => showAppSheet<void>(context, title: 'Layers', builder: (_) => const _LayersBody());

class _LayersBody extends StatelessWidget {
  const _LayersBody();

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([app.map, app.transit]),
      builder: (context, _) {
        final groups = <String, List<LayerOption>>{};
        for (final l in layerOptions) {
          (groups[l.group] ??= []).add(l);
        }
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final g in groups.entries) ...[
              SectionLabel(g.key),
              const SizedBox(height: 4),
              for (final l in g.value)
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: SwitchRow(
                    label: l.label,
                    value: app.map.isOn(l.id),
                    onChanged: (on) {
                      app.map.setLayer(l.id, on);
                      app.transit.loadVisible();
                    },
                  ),
                ),
            ],
            if (app.transit.liveStatus.isNotEmpty) ...[const SizedBox(height: 6), Muted(app.transit.liveStatus)],
          ],
        );
      },
    );
  }
}

/* ---- Offline maps ---- */

Future<void> openPacks(BuildContext context) {
  app.packs.refreshCatalogue();
  app.packs.refreshStorage();
  return showAppSheet<void>(context, title: 'Offline maps', builder: (_) => const _PacksBody());
}

class _PacksBody extends StatelessWidget {
  const _PacksBody();

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: Listenable.merge([app.packs, Net.online]),
      builder: (context, _) {
        final groups = <String, List<PackInfo>>{};
        for (final p in packList) {
          (groups[p.region] ??= []).add(p);
        }
        final store = app.packs;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Muted('Keep an area on this device for its map, 3D buildings, search and directions with no connection.'),
            const SizedBox(height: 4),
            if (store.freeBytes != null) Muted('Using ${formatBytes(store.usedBytes)}, with ${formatBytes(store.freeBytes!)} free on this phone.'),
            for (final g in groups.entries) ...[
              const SizedBox(height: 8),
              Text(g.key, style: TextStyle(fontSize: 13.6, color: context.t.mutedStrong)),
              const SizedBox(height: 4),
              for (final p in g.value) Padding(padding: const EdgeInsets.only(bottom: 8), child: _PackRow(pack: p)),
            ],
            Muted('Map data © OpenStreetMap contributors. Buildings © Overture Maps Foundation, OpenStreetMap contributors and others.'),
          ],
        );
      },
    );
  }
}

class _PackRow extends StatelessWidget {
  const _PackRow({required this.pack});
  final PackInfo pack;

  Future<void> _get() async {
    if (!Net.online.value) {
      app.toast('Downloading a map needs a connection', error: true);
      return;
    }
    final message = await app.packs.download(pack.id);
    if (message != null) app.toast(message);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final store = app.packs;
    final meta = store.installed[pack.id];
    final info = store.catalogue[pack.id];
    final state = store.downloads[pack.id];
    final update = meta != null && info != null && info.build != meta.build;
    String sub;
    final actions = <Widget>[];
    if (state != null && state.error == null) {
      sub = '${formatBytes(state.done)} of ${formatBytes(state.total)}';
      actions.add(AppButton('Stop', onPressed: () => store.stop(pack.id)));
    } else if (state?.error != null) {
      sub = state!.error!;
      actions.add(AppButton('Try again', kind: BtnKind.primary, onPressed: _get));
    } else if (meta != null) {
      sub = update ? 'Saved. A newer map is ready, ${formatBytes(info.size)}' : 'Saved, ${formatBytes(meta.size)}';
      if (update) actions.add(AppButton('Update', kind: BtnKind.primary, onPressed: _get));
      actions.add(AppIconButton('trash', label: 'Delete ${pack.name}', small: true, onPressed: () => store.remove(pack.id)));
    } else if (info != null) {
      sub = formatBytes(info.size);
      actions.add(AppButton('Download', icon: 'download', onPressed: _get));
    } else {
      sub = !Net.online.value ? 'Connect to download' : (store.catalogueLoaded ? 'Not ready yet' : 'Looking...');
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(14), border: t.material ? null : Border.all(color: t.surfaceBorder)),
      child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(pack.name, style: TextStyle(fontSize: 15.2, color: t.ink)),
                      Text(sub, style: TextStyle(fontSize: 12.5, color: t.mutedStrong)),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                for (final a in actions) Padding(padding: const EdgeInsets.only(left: 6), child: a),
              ],
            ),
            if (state != null && state.error == null) ...[
              const SizedBox(height: 6),
              ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: LinearProgressIndicator(minHeight: 8, value: state.total > 0 ? state.done / state.total : 0, color: t.brandInk, backgroundColor: mix(t.ink, 0.12, transparentInk), semanticsLabel: 'Downloading ${pack.name}'),
              ),
            ],
          ],
        ),
    );
  }
}

/* ---- Saved places ---- */

Future<void> openSaved(BuildContext context) => showAppSheet<void>(context, title: 'Saved places', builder: (_) => const _SavedBody());

class _SavedBody extends StatefulWidget {
  const _SavedBody();
  @override
  State<_SavedBody> createState() => _SavedBodyState();
}

class _SavedBodyState extends State<_SavedBody> {
  final _join = TextEditingController();

  @override
  void dispose() {
    _join.dispose();
    super.dispose();
  }

  Future<void> _moveTo(Place p) async {
    final controller = TextEditingController(text: p.list ?? defaultList);
    final lists = app.places.lists;
    final chosen = await showDialog<String>(
      context: context,
      builder: (c) => AlertDialog(
        title: Text('List for ${p.name}'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            AppField(controller: controller, hint: 'List name', label: 'List name'),
            const SizedBox(height: 8),
            Wrap(spacing: 6, runSpacing: 6, children: [for (final l in lists) ActionChip(label: Text(l), onPressed: () => Navigator.of(c).pop(l))]),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(c).pop(), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(c).pop(controller.text), child: const Text('Move')),
        ],
      ),
    );
    if (chosen != null) app.places.moveToList(p, chosen);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: app.places,
      builder: (context, _) {
        final t = context.t;
        final all = app.places.saved;
        final code = app.places.syncCode;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (all.isEmpty) const Muted('Places you save show here, and work offline.'),
            for (final list in app.places.lists) ...[
              Row(
                children: [
                  Expanded(child: Text(list, style: TextStyle(fontSize: 13.6, color: t.mutedStrong))),
                  AppButton('Share list', icon: 'share', onPressed: () {
                    final items = all.where((p) => (p.list ?? defaultList) == list).toList();
                    Navigator.of(context).pop();
                    app.share.shareList(list, items);
                  }),
                ],
              ),
              const SizedBox(height: 6),
              for (final p in all.where((p) => (p.list ?? defaultList) == list))
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(14), border: t.material ? null : Border.all(color: t.surfaceBorder)),
                    child: Row(
                      children: [
                        Expanded(
                          child: Semantics(
                            container: true,
                            button: true,
                            label: p.name,
                            excludeSemantics: true,
                            onTap: () {
                              Navigator.of(context).pop();
                              app.showPlace(p);
                            },
                            child: GestureDetector(
                              behavior: HitTestBehavior.opaque,
                              onTap: () {
                                Navigator.of(context).pop();
                                app.showPlace(p);
                              },
                              child: Text(p.name, style: TextStyle(fontSize: 15.2, color: t.ink)),
                            ),
                          ),
                        ),
                        AppIconButton('list', label: 'List for ${p.name}', small: true, onPressed: () => _moveTo(p)),
                        const SizedBox(width: 6),
                        AppIconButton('trash', label: 'Remove ${p.name}', small: true, onPressed: () => app.places.forget(p)),
                      ],
                    ),
                  ),
                ),
            ],
            const SizedBox(height: 8),
            const SectionLabel('Sync between devices'),
            const SizedBox(height: 6),
            if (code.isNotEmpty) ...[
              Center(
                child: SelectableText(
                  code.replaceAllMapped(RegExp(r'(.{4})(?=.)'), (m) => '${m[1]} '),
                  style: TextStyle(fontSize: 25.6, letterSpacing: 3, color: t.brandInk),
                ),
              ),
              const Muted('Enter this code on another device to share these places. Anyone with it can see and change them.'),
              if (app.places.syncState.isNotEmpty) Muted(app.places.syncState),
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: [
                  AppButton('Sync now', icon: 'sync', onPressed: app.places.syncNow),
                  AppButton('Turn off', kind: BtnKind.quiet, onPressed: app.places.stopSyncing),
                ],
              ),
            ] else ...[
              const Muted('Keep saved places the same on your devices, with a code and no account.'),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: AppButton('Start syncing', icon: 'sync', onPressed: () {
                  final err = app.places.startSyncing();
                  if (err != null) app.toast(err, error: true);
                }),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(child: AppField(controller: _join, hint: 'Or enter a code', label: 'Sync code', upper: true)),
                  const SizedBox(width: 8),
                  AppButton('Join', onPressed: () => app.places.joinSync(_join.text)),
                ],
              ),
              if (app.places.syncState.isNotEmpty) ...[const SizedBox(height: 6), Muted(app.places.syncState)],
            ],
          ],
        );
      },
    );
  }
}

/* ---- Sharing ---- */

Future<void> openShareSheet(BuildContext context, ShareCard card) => showAppSheet<void>(context, title: 'Share', builder: (_) => _ShareBody(card: card));

class _ShareBody extends StatelessWidget {
  const _ShareBody({required this.card});
  final ShareCard card;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: app.share,
      builder: (context, _) {
        final t = context.t;
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(card.title, style: TextStyle(fontSize: 15.2, color: t.ink)),
            if (card.mapImage != null) ...[
              const SizedBox(height: 8),
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: Image.network(card.mapImage!, fit: BoxFit.cover, height: 170, errorBuilder: (_, _, _) => const SizedBox.shrink(), semanticLabel: 'Map preview'),
              ),
            ],
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(child: AppField(controller: TextEditingController(text: card.url), readOnly: true, label: 'Link')),
                const SizedBox(width: 8),
                AppIconButton('copy', label: 'Copy link', onPressed: () => app.share.copy(card.url)),
              ],
            ),
            if (card.note.isNotEmpty) ...[const SizedBox(height: 6), Muted(card.note)],
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              children: [
                AppButton('Send', icon: 'share', kind: BtnKind.primary, onPressed: () => app.share.send(card.url, card.title)),
                AppButton('Nearby', icon: 'nearby', onPressed: () {
                  final payload = card.payload;
                  final nav = Navigator.of(context);
                  final host = nav.context;
                  nav.pop();
                  openNearby(host, payload: payload);
                }),
              ],
            ),
          ],
        );
      },
    );
  }
}

/* ---- A shared list being opened ---- */

Future<void> openListSheet(BuildContext context, Map<String, dynamic> data) {
  final places = (data['places'] as List<dynamic>).map((p) => fromLink(Map<String, dynamic>.from(p as Map))).toList();
  final name = data['name'] as String;
  return showAppSheet<void>(
    context,
    title: name,
    builder: (c) {
      final t = c.t;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final p in places)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Semantics(
                container: true,
                button: true,
                label: p.name,
                excludeSemantics: true,
                onTap: () {
                  Navigator.of(c).pop();
                  app.showPlace(p);
                },
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () {
                    Navigator.of(c).pop();
                    app.showPlace(p);
                  },
                  child: Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(color: t.surface, borderRadius: BorderRadius.circular(14), border: t.material ? null : Border.all(color: t.surfaceBorder)),
                    child: Text(p.name, style: TextStyle(fontSize: 15.2, color: t.ink)),
                  ),
                ),
              ),
            ),
          AppButton('Save all', icon: 'bookmark', kind: BtnKind.primary, onPressed: () {
            for (final p in places) {
              app.places.save(p, name);
            }
            Navigator.of(c).pop();
            app.toast('Saved ${places.length} places to $name');
          }),
        ],
      );
    },
  );
}
