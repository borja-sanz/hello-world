/*
  Overpass QL — Commercial POIs in Guatemala
  Used for Commercial Density scoring factor
*/

[out:json][timeout:90];

area["name"="Guatemala"]["boundary"="administrative"]["admin_level"="2"]->.guatemala;

(
  // Markets and traditional commerce
  node["amenity"="marketplace"](area.guatemala);
  node["shop"="market"](area.guatemala);

  // Banks (purchasing power signal)
  node["amenity"="bank"](area.guatemala);

  // Pharmacies
  node["amenity"="pharmacy"](area.guatemala);

  // Hardware stores (ferretería)
  node["shop"="hardware"](area.guatemala);
  node["shop"="doityourself"](area.guatemala);

  // Schools
  node["amenity"="school"](area.guatemala);
  node["amenity"="university"](area.guatemala);
  node["amenity"="college"](area.guatemala);

  // Health centers
  node["amenity"="hospital"](area.guatemala);
  node["amenity"="clinic"](area.guatemala);
  node["amenity"="health_centre"](area.guatemala);

  // Churches (community activity signal)
  node["amenity"="place_of_worship"](area.guatemala);

  // Bus terminals (mobility/accessibility)
  node["amenity"="bus_station"](area.guatemala);
  node["highway"="bus_stop"](area.guatemala);

  // Gas stations (road traffic signal)
  node["amenity"="fuel"](area.guatemala);
);

out center;
