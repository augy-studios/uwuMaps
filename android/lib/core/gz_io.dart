import 'dart:io';
import 'dart:typed_data';

Future<Uint8List> gunzip(Uint8List bytes) async => Uint8List.fromList(gzip.decode(bytes));
