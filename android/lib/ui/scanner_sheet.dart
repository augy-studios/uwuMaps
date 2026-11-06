// Scanning another device's QR code with the camera. The camera's permission is asked for here, at the
// moment it's wanted.

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../theme/tokens.dart';
import 'widgets.dart';

Future<String?> openScanner(BuildContext context) => Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => const _Scanner(), fullscreenDialog: true),
    );

class _Scanner extends StatefulWidget {
  const _Scanner();
  @override
  State<_Scanner> createState() => _ScannerState();
}

class _ScannerState extends State<_Scanner> {
  final MobileScannerController _controller = MobileScannerController(formats: const [BarcodeFormat.qrCode]);
  bool _done = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(
            controller: _controller,
            onDetect: (capture) {
              if (_done) return;
              final value = capture.barcodes.where((b) => b.rawValue != null).firstOrNull?.rawValue;
              if (value == null) return;
              _done = true;
              Navigator.of(context).pop(value);
            },
            errorBuilder: (context, error) => Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text(
                  error.errorCode == MobileScannerErrorCode.permissionDenied ? 'Allow the camera to scan a code. You can do that in Android’s settings for uwuMaps.' : 'The camera couldn’t start.',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Colors.white, fontSize: 16),
                ),
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Align(
                alignment: Alignment.topLeft,
                child: Panel(
                  padding: const EdgeInsets.fromLTRB(14, 8, 8, 8),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('Point at a uwuMaps code', style: TextStyle(color: t.ink, fontSize: 15)),
                      const SizedBox(width: 10),
                      AppIconButton('close', label: 'Close', small: true, onPressed: () => Navigator.of(context).pop()),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
