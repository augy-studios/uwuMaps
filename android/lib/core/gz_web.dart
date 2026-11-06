import 'dart:typed_data';

import 'package:archive/archive.dart';

Future<Uint8List> gunzip(Uint8List bytes) async => Uint8List.fromList(const GZipDecoder().decodeBytes(bytes));
