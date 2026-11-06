// Sending a place, a route or a list to a device nearby, as main-site/js/nearby.js does it. Two ways, each
// saying what it needs:
//
//   QR code   The whole thing fits in the link, so it needs no connection on either device.
//   Code      Direct between two devices over WebRTC, for what's too big for a QR code. A public broker
//             introduces them, so both need a connection to start, and a network that lets them reach
//             each other. Pairs with another phone, or with the website.
//
// Closing the sheet ends the session, so a code shown to a room doesn't keep working.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../app.dart';
import '../core/config.dart';
import '../core/net.dart';
import '../nearby/peer.dart';
import '../share/links.dart';
import '../theme/tokens.dart';
import 'scanner_sheet.dart';
import 'widgets.dart';

// Past about this long a link makes a QR code too dense for a phone's camera to read reliably.
const int _qrMax = 1200;

const String _unreachable = 'Could not reach the other device. Both have to be on the same network: join the same wifi, or turn on a hotspot on one and join it from the other. Check the code is still the one on screen.';

/// The code on show, for the browser tests, as a QR code and selectable text can't be read from outside.
String? shownNearbyCode;

Future<void> openNearby(BuildContext context, {Map<String, Object?>? payload, String? join}) {
  final sending = payload ?? _savedAsPayload();
  final title = sending != null && join == null ? 'Send to a device nearby' : 'Receive from a device nearby';
  return showAppSheet<void>(context, title: title, builder: (_) => _NearbyBody(sending: sending, join: join));
}

Map<String, Object?>? _savedAsPayload() {
  final places = app.places.saved.take(200).map((p) => placeOf(p, p.name)).toList();
  if (places.isEmpty) return null;
  return {
    'kind': 'list',
    'data': {'name': 'From a nearby device', 'places': places},
  };
}

class _QrImage extends StatelessWidget {
  const _QrImage(this.data);
  final String data;

  // Dark on light whatever the theme, or scanners won't read it.
  @override
  Widget build(BuildContext context) => Center(
        child: Semantics(
          image: true,
          label: 'QR code',
          child: Container(
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(color: Colors.white, borderRadius: BorderRadius.circular(12)),
            child: QrImageView(data: data, version: QrVersions.auto, errorCorrectionLevel: QrErrorCorrectLevel.L, size: 240, gapless: true, backgroundColor: Colors.white),
          ),
        ),
      );
}

class _NearbyBody extends StatefulWidget {
  const _NearbyBody({this.sending, this.join});
  final Map<String, Object?>? sending;
  final String? join;

  @override
  State<_NearbyBody> createState() => _NearbyBodyState();
}

class _NearbyBodyState extends State<_NearbyBody> {
  late final TextEditingController _code = TextEditingController(text: widget.join != null ? normaliseNearbyCode(widget.join!) : '');
  NearbyHost? _host;
  NearbyGuest? _guest;
  String? _hostCode;
  String _status = '';
  String _tone = '';
  bool _retried = false;
  bool _sent = false;

  @override
  void initState() {
    super.initState();
    if (widget.join != null) WidgetsBinding.instance.addPostFrameCallback((_) => _receive(widget.join!));
  }

  @override
  void dispose() {
    _host?.close();
    _guest?.close();
    _code.dispose();
    super.dispose();
  }

  void _say(String text, [String tone = '']) {
    if (mounted) {
      setState(() {
        _status = text;
        _tone = tone;
      });
    }
  }

  Future<void> _startHosting() async {
    _host?.close();
    if (!Net.online.value) {
      _say('Sending by code needs a connection to start. The QR code above works without one.', 'error');
      return;
    }
    final code = generateNearbyCode();
    setState(() => _hostCode = code);
    shownNearbyCode = code;
    final payload = widget.sending!;
    late final NearbyHost host;
    host = NearbyHost((status, {message, taken = false}) {
      if (taken && !_retried) {
        // Something else holds the code: a fresh one, once, silently.
        _retried = true;
        _startHosting();
        return;
      }
      if (status == 'waiting') _retried = false;
      if (status == 'error') {
        _say(message ?? 'The connection failed.', 'error');
      } else if (status == 'connecting') {
        _say('Connecting...');
      } else if (status == 'waiting') {
        // The other device leaving once it has it isn't news.
        if (!_sent) _say('Waiting for the other device. Enter this code there, or scan this.');
      } else if (status == 'connected') {
        _sent = false;
        _say('Connected. Sending...');
      }
    }, (message, from) {
      if (message['type'] == 'hello') {
        host.send({'type': 'state', 'payload': payload}, from);
      } else if (message['type'] == 'got') {
        _sent = true;
        _say('Sent.', 'ok');
      }
    });
    _host = host;
    await host.start(code);
  }

  Future<void> _receive(String input) async {
    final code = normaliseNearbyCode(input);
    if (!isValidNearbyCode(code)) {
      _say('A code is $nearbyCodeLength letters and numbers.', 'error');
      return;
    }
    if (!Net.online.value) {
      _say('Receiving by code needs a connection to start. Ask them to show the QR code instead.', 'error');
      return;
    }
    _guest?.close();
    final nav = Navigator.of(context);
    late final NearbyGuest guest;
    guest = NearbyGuest((status, {message, taken = false}) {
      if (status == 'error') {
        _say(message ?? 'The connection failed.', 'error');
      } else if (status == 'connecting') {
        _say('Connecting...');
      } else if (status == 'connected') {
        _say('Connected. Receiving...');
      } else if (status == 'unreachable') {
        _say(_unreachable, 'error');
      } else if (status == 'dropped') {
        _say('The other device has closed the connection.');
      }
    }, (message, from) {
      final payload = message['payload'];
      if (message['type'] != 'state' || payload is! Map) return;
      guest.send({'type': 'got'});
      _say('Received.', 'ok');
      // A round trip, so the other side's message survives closing here.
      final copy = jsonDecode(jsonEncode(payload)) as Map<String, dynamic>;
      Future<void>.delayed(const Duration(milliseconds: 300), () {
        if (nav.canPop()) nav.pop();
        app.share.receive(copy);
      });
    });
    _guest = guest;
    await guest.connect(code);
  }

  Widget _receiveSection() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SectionLabel('Receive by code'),
        const SizedBox(height: 6),
        Row(
          children: [
            Expanded(child: AppField(controller: _code, hint: 'Code from the other device', label: 'Code', upper: true, maxLength: 8)),
            const SizedBox(width: 8),
            AppButton('Receive', kind: BtnKind.primary, onPressed: () => _receive(_code.text)),
          ],
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final sending = widget.sending;
    final link = sending == null ? null : selfLink(sending);
    final fits = link != null && link.length <= _qrMax;
    final tone = _tone == 'error' ? t.error : (_tone == 'ok' ? t.ok : t.ink);
    final statusLine = Semantics(liveRegion: true, child: Text(_status, textAlign: _hostCode == null ? TextAlign.start : TextAlign.center, style: TextStyle(fontSize: 13.6, color: tone)));
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.join != null) ...[_receiveSection(), const SizedBox(height: 10)],
        if (sending != null) ...[
          const SectionLabel('Send with a QR code, no connection needed'),
          const SizedBox(height: 6),
          if (fits) ...[
            _QrImage(link),
            const SizedBox(height: 6),
            const Muted("Scan this with the other device's camera, or with Scan a code in uwuMaps. It opens with no connection if uwuMaps is installed there."),
          ] else
            const Muted('This is too big for a QR code. Send it by code instead.'),
          const SizedBox(height: 10),
          const SectionLabel('Or send by code'),
          const SizedBox(height: 4),
          const Muted('Both devices need a connection to start, and to be on the same wifi or a hotspot from one of them.'),
          const SizedBox(height: 8),
          Align(alignment: Alignment.centerLeft, child: AppButton('Show a code', icon: 'nearby', onPressed: _startHosting)),
          if (_hostCode != null) ...[
            const SizedBox(height: 8),
            Center(child: SelectableText(_hostCode!, style: TextStyle(fontSize: 25.6, letterSpacing: 3, color: t.brandInk))),
            // Here rather than at the end of the sheet, where it would be off a phone's screen.
            if (_status.isNotEmpty) ...[const SizedBox(height: 4), statusLine],
            const SizedBox(height: 6),
            _QrImage('$siteOrigin/#join=$_hostCode'),
          ],
          const SizedBox(height: 10),
        ],
        if (widget.join == null) ...[
          _receiveSection(),
          const SizedBox(height: 10),
        ],
        if (!kIsWeb) ...[
          Align(
            alignment: Alignment.centerLeft,
            child: AppButton('Scan a code', icon: 'qr', onPressed: () async {
              final nav = Navigator.of(context);
              final host = nav.context;
              final scanned = await openScanner(context);
              if (scanned == null) return;
              final uri = Uri.tryParse(scanned);
              if (uri != null && parseLink(uri) != null) {
                nav.pop();
                if (host.mounted) app.share.openLink(uri);
              } else {
                _say("That code isn't a uwuMaps link.", 'error');
              }
            }),
          ),
          const SizedBox(height: 8),
        ],
        if (_status.isNotEmpty && _hostCode == null) statusLine,
      ],
    );
  }
}
