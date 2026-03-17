/*
  Overpass QL — Supermarkets in Guatemala
  Run at: https://overpass-turbo.eu/
  Or via API: https://overpass-api.de/api/interpreter
*/

[out:json][timeout:60];

// Get Guatemala area
area["name"="Guatemala"]["boundary"="administrative"]["admin_level"="2"]->.guatemala;

// Find all supermarkets within Guatemala
(
  node["shop"="supermarket"](area.guatemala);
  way["shop"="supermarket"](area.guatemala);
  node["shop"="convenience"](area.guatemala);
  node["shop"="department_store"](area.guatemala);
);

out center;
