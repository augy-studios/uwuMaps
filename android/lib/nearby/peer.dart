// Pairing with a device nearby: the Android side of main-site/js/p2p.js and docs/STUN-p2p-spec.md. Android
// has no WebRTC of its own, so flutter_webrtc brings it, and this speaks PeerJS's broker protocol and its
// BinaryPack data channel, so the app pairs with another phone or with the website either way round.
// STUN only: no relay, as the spec asks.

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import 'binarypack.dart';

const String _peerPrefix = 'uwumaps-';
const String _alphabet = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const int nearbyCodeLength = 6;
const int protocolVersion = 1;
const String _brokerHost = String.fromEnvironment('UWU_PEER_HOST', defaultValue: '0.peerjs.com');
const String _peerVersion = '1.5.4';
const Duration _connectTimeout = Duration(seconds: 15);
const Duration _heartbeat = Duration(seconds: 5);

const Map<String, dynamic> _ice = {
  'iceServers': [
    {'urls': 'stun:stun.l.google.com:19302'},
    {'urls': 'stun:stun.cloudflare.com:3478'},
  ],
};

String generateNearbyCode() {
  final r = math.Random.secure();
  return List.generate(nearbyCodeLength, (_) => _alphabet[r.nextInt(_alphabet.length)]).join();
}

String normaliseNearbyCode(String input) {
  final clean = input.toUpperCase().replaceAll(RegExp('[^A-Z0-9]'), '');
  return clean.length > nearbyCodeLength ? clean.substring(0, nearbyCodeLength) : clean;
}

bool isValidNearbyCode(String input) {
  final code = normaliseNearbyCode(input);
  return code.length == nearbyCodeLength && code.split('').every(_alphabet.contains);
}

const String _unreachableBroker = 'Cannot reach the pairing service. Everything else still works.';

typedef PeerStatus = void Function(String status, {String? message, bool taken});
typedef PeerMessage = void Function(Map<String, Object?> message, String from);

class _Link {
  _Link(this.peer, this.connectionId, this.pc);
  final String peer;
  final String connectionId;
  final RTCPeerConnection pc;
  RTCDataChannel? channel;
  bool opened = false;
  final Chunks chunks = Chunks();
  final List<RTCIceCandidate> early = [];
  bool haveRemote = false;
}

abstract class _Connection {
  _Connection(this.onStatus, this.onMessage);
  final PeerStatus onStatus;
  final PeerMessage onMessage;

  WebSocketChannel? _socket;
  Timer? _ping;
  String status = 'idle';
  bool _closed = false;
  final Map<String, _Link> _byConnection = {};

  void setStatus(String s, {String? message, bool taken = false}) {
    status = s;
    onStatus(s, message: message, taken: taken);
  }

  Future<void> openBroker(String id) async {
    final token = List.generate(10, (_) => math.Random().nextInt(36).toRadixString(36)).join();
    final url = Uri.parse('wss://$_brokerHost:443/peerjs?key=peerjs&id=$id&token=$token&version=$_peerVersion');
    final socket = WebSocketChannel.connect(url);
    _socket = socket;
    await socket.ready;
    socket.stream.listen((raw) {
      try {
        _onBroker(jsonDecode(raw as String) as Map<String, dynamic>);
      } catch (err) {
        debugPrint('Broker message: $err');
      }
    }, onDone: () {
      if (!_closed && _socket == socket) onBrokerClosed();
    }, onError: (Object _) {
      if (!_closed && _socket == socket) onBrokerClosed();
    });
    _ping = Timer.periodic(_heartbeat, (_) => _sendBroker({'type': 'HEARTBEAT'}));
  }

  void _sendBroker(Map<String, dynamic> m) {
    try {
      _socket?.sink.add(jsonEncode(m));
    } catch (_) {
      // Closed: its handler reports it.
    }
  }

  void onBrokerClosed();
  void onBrokerOpen();
  void onBrokerError(String type, String message);
  Future<void> onOffer(String from, Map<String, dynamic> payload);
  void onLinkOpen(_Link link);
  void onLinkClosed(_Link link);

  Future<void> _onBroker(Map<String, dynamic> m) async {
    final type = m['type'];
    final payload = m['payload'];
    switch (type) {
      case 'OPEN':
        onBrokerOpen();
      case 'ID-TAKEN':
        onBrokerError('unavailable-id', 'That code is already in use. Generate a new one.');
      case 'ERROR':
      case 'INVALID-KEY':
        onBrokerError('server-error', _unreachableBroker);
      case 'EXPIRE':
        onBrokerError('peer-unavailable', 'Nobody is hosting with that code. Check it and try again.');
      case 'OFFER':
        await onOffer(m['src'] as String, Map<String, dynamic>.from(payload as Map));
      case 'ANSWER':
        final p = payload as Map;
        final link = _byConnection[p['connectionId']];
        if (link == null) return;
        final sdp = p['sdp'] as Map;
        await link.pc.setRemoteDescription(RTCSessionDescription(sdp['sdp'] as String?, sdp['type'] as String?));
        link.haveRemote = true;
        for (final c in link.early) {
          await link.pc.addCandidate(c);
        }
        link.early.clear();
      case 'CANDIDATE':
        final p = payload as Map;
        final link = _byConnection[p['connectionId']];
        final c = p['candidate'] as Map?;
        if (link == null || c == null) return;
        final candidate = RTCIceCandidate(c['candidate'] as String?, c['sdpMid'] as String?, (c['sdpMLineIndex'] as num?)?.toInt());
        if (link.haveRemote) {
          await link.pc.addCandidate(candidate);
        } else {
          link.early.add(candidate);
        }
      case 'LEAVE':
        final src = m['src'];
        for (final link in _byConnection.values.toList()) {
          if (link.peer == src) dropLink(link);
        }
    }
  }

  Future<_Link> makeLink(String peer, String connectionId) async {
    final pc = await createPeerConnection(_ice);
    final link = _Link(peer, connectionId, pc);
    _byConnection[connectionId] = link;
    pc.onIceCandidate = (c) {
      if (c.candidate == null || c.candidate!.isEmpty) return;
      _sendBroker({
        'type': 'CANDIDATE',
        'payload': {
          'candidate': {'candidate': c.candidate, 'sdpMid': c.sdpMid, 'sdpMLineIndex': c.sdpMLineIndex},
          'type': 'data',
          'connectionId': connectionId,
        },
        'dst': peer,
      });
    };
    pc.onIceConnectionState = (s) {
      if (s == RTCIceConnectionState.RTCIceConnectionStateFailed || s == RTCIceConnectionState.RTCIceConnectionStateClosed) dropLink(link);
    };
    return link;
  }

  void bindChannel(_Link link, RTCDataChannel channel) {
    link.channel = channel;
    channel.onDataChannelState = (s) {
      if (s == RTCDataChannelState.RTCDataChannelOpen && !link.opened) {
        link.opened = true;
        onLinkOpen(link);
      } else if (s == RTCDataChannelState.RTCDataChannelClosed) {
        dropLink(link);
      }
    };
    channel.onMessage = (m) {
      if (!m.isBinary) return;
      _receive(link, m.binary);
    };
    // A channel that answers from an offer may already be open by the time it's seen.
    if (channel.state == RTCDataChannelState.RTCDataChannelOpen && !link.opened) {
      link.opened = true;
      onLinkOpen(link);
    }
  }

  void _receive(_Link link, Uint8List bytes) {
    try {
      final value = unpackMessage(bytes);
      if (value is! Map) return;
      final m = value.cast<String, Object?>();
      final peerData = m['__peerData'];
      if (peerData != null) {
        if (peerData is Map) {
          if (peerData['type'] == 'close') dropLink(link);
          return;
        }
        final whole = link.chunks.add(m);
        if (whole != null) _receive(link, whole);
        return;
      }
      if (m['type'] is! String) return;
      onMessage(m, link.peer);
    } catch (err) {
      debugPrint('Peer message: $err');
    }
  }

  void sendOn(_Link link, Map<String, Object?> message) {
    final channel = link.channel;
    if (channel == null || !link.opened) return;
    for (final frame in framesFor(message)) {
      try {
        channel.send(RTCDataChannelMessage.fromBinary(frame));
      } catch (_) {
        // Closed between the check and the send; its handler reports it.
      }
    }
  }

  void dropLink(_Link link) {
    if (_byConnection.remove(link.connectionId) == null) return;
    final wasOpen = link.opened;
    unawaited(link.channel?.close().catchError((Object _) {}));
    unawaited(link.pc.close().catchError((Object _) {}));
    link.opened = wasOpen;
    onLinkClosed(link);
  }

  void shutDown() {
    _closed = true;
    _ping?.cancel();
    for (final link in _byConnection.values.toList()) {
      dropLink(link);
    }
    _sendBrokerClose();
  }

  void _sendBrokerClose() {
    try {
      _socket?.sink.close();
    } catch (_) {}
    _socket = null;
  }
}

class NearbyHost extends _Connection {
  NearbyHost(super.onStatus, super.onMessage);

  Future<void> start(String code) async {
    setStatus('connecting');
    try {
      await openBroker('$_peerPrefix$code');
    } catch (_) {
      setStatus('error', message: _unreachableBroker);
    }
  }

  bool get _hasGuest => _byConnection.values.any((l) => l.opened);

  void _refresh() {
    if (!_closed) setStatus(_hasGuest ? 'connected' : 'waiting');
  }

  @override
  void onBrokerOpen() => _refresh();

  @override
  void onBrokerClosed() {
    // Guests already attached don't need the broker.
    if (!_hasGuest) setStatus('error', message: _unreachableBroker);
  }

  @override
  void onBrokerError(String type, String message) {
    if (type == 'unavailable-id') {
      setStatus('error', message: message, taken: true);
    } else if (!_hasGuest && type != 'peer-unavailable') {
      setStatus('error', message: message);
    }
  }

  @override
  Future<void> onOffer(String from, Map<String, dynamic> payload) async {
    // One guest at a time: the newcomer replaces the incumbent.
    for (final old in _byConnection.values.toList()) {
      dropLink(old);
    }
    final connectionId = payload['connectionId'] as String;
    final link = await makeLink(from, connectionId);
    link.pc.onDataChannel = (channel) => bindChannel(link, channel);
    final sdp = payload['sdp'] as Map;
    await link.pc.setRemoteDescription(RTCSessionDescription(sdp['sdp'] as String?, sdp['type'] as String?));
    link.haveRemote = true;
    for (final c in link.early) {
      await link.pc.addCandidate(c);
    }
    link.early.clear();
    final answer = await link.pc.createAnswer();
    await link.pc.setLocalDescription(answer);
    _sendBroker({
      'type': 'ANSWER',
      'payload': {
        'sdp': {'type': answer.type, 'sdp': answer.sdp},
        'type': 'data',
        'connectionId': connectionId,
      },
      'dst': from,
    });
  }

  @override
  void onLinkOpen(_Link link) => _refresh();

  @override
  void onLinkClosed(_Link link) => _refresh();

  void send(Map<String, Object?> message, String to) {
    for (final link in _byConnection.values) {
      if (link.peer == to) sendOn(link, message);
    }
  }

  void close() {
    shutDown();
    status = 'idle';
  }
}

class NearbyGuest extends _Connection {
  NearbyGuest(super.onStatus, super.onMessage);

  _Link? _link;
  Timer? _timer;
  String _code = '';
  bool _offered = false;

  Future<void> connect(String code) async {
    _code = code;
    setStatus('connecting');
    // Nothing errors when ICE can't find a path; it just keeps trying.
    _timer = Timer(_connectTimeout, () {
      if (status != 'connecting') return;
      close();
      setStatus('unreachable');
    });
    try {
      final res = await http.get(Uri.parse('https://$_brokerHost:443/peerjs/id?ts=${DateTime.now().millisecondsSinceEpoch}${math.Random().nextDouble()}&version=$_peerVersion')).timeout(const Duration(seconds: 8));
      if (res.statusCode != 200) throw Exception('${res.statusCode}');
      await openBroker(res.body.trim());
    } catch (_) {
      close();
      setStatus('error', message: _unreachableBroker);
    }
  }

  @override
  void onBrokerOpen() async {
    // A broker reconnect would open again: one offer only.
    if (_offered) return;
    _offered = true;
    final connectionId = 'dc_${List.generate(11, (_) => math.Random().nextInt(36).toRadixString(36)).join()}';
    final link = await makeLink('$_peerPrefix$_code', connectionId);
    _link = link;
    final channel = await link.pc.createDataChannel(connectionId, RTCDataChannelInit()..ordered = true);
    bindChannel(link, channel);
    final offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    _sendBroker({
      'type': 'OFFER',
      'payload': {
        'sdp': {'type': offer.type, 'sdp': offer.sdp},
        'type': 'data',
        'connectionId': connectionId,
        'label': connectionId,
        'reliable': true,
        'serialization': 'binary',
      },
      'dst': link.peer,
    });
  }

  @override
  void onBrokerClosed() {
    if (status != 'connected') {
      close();
      setStatus('error', message: _unreachableBroker);
    }
  }

  @override
  void onBrokerError(String type, String message) {
    if (status == 'connected') return;
    close();
    setStatus('error', message: message);
  }

  @override
  Future<void> onOffer(String from, Map<String, dynamic> payload) async {}

  @override
  void onLinkOpen(_Link link) {
    if (link != _link) return;
    _timer?.cancel();
    setStatus('connected');
    send({'type': 'hello', 'v': protocolVersion});
  }

  @override
  void onLinkClosed(_Link link) {
    if (link != _link) return;
    _link = null;
    if (!_closed) setStatus(link.opened ? 'dropped' : 'unreachable');
  }

  void send(Map<String, Object?> message) {
    final link = _link;
    if (link != null) sendOn(link, message);
  }

  void close() {
    _timer?.cancel();
    shutDown();
    status = 'idle';
  }
}
