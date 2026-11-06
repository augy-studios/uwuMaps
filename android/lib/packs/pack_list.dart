// The regions there are, as main-site/js/pack-list.js lists them. Keep the two in step.

class PackInfo {
  const PackInfo(this.id, this.name, this.region, this.west, this.south, this.east, this.north);
  final String id;
  final String name;
  final String region;
  final double west;
  final double south;
  final double east;
  final double north;

  List<double> get bounds => [west, south, east, north];
}

const List<PackInfo> packList = [
  PackInfo('singapore', 'Singapore', 'Asia', 103.59, 1.15, 104.1, 1.48),
  PackInfo('malaysia', 'Malaysia, Singapore and Brunei', 'Asia', 99.0, 0.7, 119.5, 7.6),
  PackInfo('taiwan', 'Taiwan', 'Asia', 118.1, 21.7, 122.1, 26.5),
  PackInfo('hong-kong', 'Hong Kong', 'Asia', 113.8, 22.1, 114.5, 22.6),
  PackInfo('thailand', 'Thailand', 'Asia', 97.2, 5.5, 105.8, 20.6),
  PackInfo('south-korea', 'South Korea', 'Asia', 124.5, 33.0, 131.0, 38.7),
  PackInfo('japan', 'Japan', 'Asia', 122.9, 24.0, 146.0, 45.6),
  PackInfo('java', 'Java', 'Asia', 105.0, -8.9, 116.3, -5.0),
  PackInfo('sumatra', 'Sumatra', 'Asia', 94.9, -6.2, 109.3, 6.1),
  PackInfo('kalimantan', 'Kalimantan', 'Asia', 108.5, -4.3, 119.1, 4.5),
  PackInfo('sulawesi', 'Sulawesi', 'Asia', 118.7, -7.6, 127.0, 5.6),
  PackInfo('bali-nusa-tenggara', 'Bali and Nusa Tenggara', 'Asia', 114.3, -11.1, 125.3, -7.9),
  PackInfo('maluku', 'Maluku', 'Asia', 124.2, -8.4, 135.8, 3.0),
  PackInfo('papua', 'Papua', 'Asia', 129.3, -9.2, 141.1, 1.2),
  PackInfo('philippines', 'Philippines', 'Asia', 116.8, 4.5, 126.8, 21.2),
  PackInfo('vietnam', 'Vietnam', 'Asia', 102.0, 8.3, 109.6, 23.5),
  PackInfo('greater-london', 'Greater London', 'Europe', -0.56, 51.25, 0.34, 51.72),
  PackInfo('ile-de-france', 'Paris and Ile-de-France', 'Europe', 1.4, 48.1, 3.6, 49.25),
  PackInfo('netherlands', 'Netherlands', 'Europe', 3.2, 50.7, 7.3, 53.7),
  PackInfo('catalonia', 'Catalonia', 'Europe', 0.15, 40.5, 3.35, 42.9),
  PackInfo('lazio', 'Rome and Lazio', 'Europe', 11.4, 40.7, 14.05, 42.85),
  PackInfo('new-york-state', 'New York State', 'North America', -79.8, 40.45, -71.8, 45.05),
  PackInfo('northern-california', 'Northern California', 'North America', -124.6, 35.7, -117.6, 42.05),
  PackInfo('british-columbia', 'British Columbia', 'North America', -139.1, 48.2, -114.0, 60.05),
  PackInfo('new-south-wales', 'New South Wales', 'Oceania', 140.9, -37.6, 153.7, -28.1),
];

const List<String> packArchives = ['base', 'buildings', 'route', 'search'];
const int partSize = 4 * 1024 * 1024;
