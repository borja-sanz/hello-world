/*
  Overpass QL — Road Network in Guatemala
  Used for Mobility & Access scoring factor
*/

[out:json][timeout:90];

area["name"="Guatemala"]["boundary"="administrative"]["admin_level"="2"]->.guatemala;

(
  // Primary and trunk roads (highways)
  way["highway"="motorway"](area.guatemala);
  way["highway"="trunk"](area.guatemala);
  way["highway"="primary"](area.guatemala);

  // Secondary roads
  way["highway"="secondary"](area.guatemala);
  way["highway"="tertiary"](area.guatemala);

  // Urban roads
  way["highway"="residential"](area.guatemala);
  way["highway"="unclassified"](area.guatemala);
);

out geom;
