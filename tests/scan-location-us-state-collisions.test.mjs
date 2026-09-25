// tests/scan-location-us-state-collisions.test.mjs — USPS state codes that are
// also ISO country codes must not rescue a blocked foreign posting.
//
// When location_filter.always_allow names the US, USPS state codes become extra
// always_allow matches so "Dublin, OH" survives block: [Dublin]. But IN, DE, IL,
// AR, CO, ID, ... are also ISO 3166-1 country codes, and always_allow runs before
// block, so "Bengaluru, IN" (India) was rescued as Indiana, "Berlin, DE"
// (Germany) as Delaware and "Tel Aviv, IL" (Israel) as Illinois — straight past
// block entries the user wrote for exactly those cities. Real rows from a live
// scan-history.tsv: Navan "Bengaluru, IN", OneAdvanced "Bengaluru, KA, IN",
// PubMatic "Pune, IN".
//
// The fix: an ambiguous code counts as a state only inside a location segment
// (split on ; · • | " / " newline) that does not itself hit a `block` keyword.
import { pass, fail } from './helpers.mjs';
import { buildLocationFilter } from '../scan.mjs';

console.log('\nscan.mjs — ISO country codes are not US state codes when blocked');

function expectAll(filter, cases, expected, label) {
  const wrong = cases.filter((loc) => filter(loc) !== expected);
  if (wrong.length === 0) pass(label);
  else fail(`${label} — wrong verdict for: ${wrong.map((l) => JSON.stringify(l)).join(', ')}`);
}

// Shaped like a real US/Canada-targeted portals.yml: countries AND cities in
// block, the US + home metros in always_allow, "Remote" in allow.
const usTargeted = buildLocationFilter({
  always_allow: ['United States', 'USA', 'U.S.', 'Canada', 'British Columbia', 'BC', 'Vancouver'],
  allow: ['Remote', 'United States', 'USA'],
  block: [
    'India', 'Germany', 'Israel', 'Argentina', 'Colombia', 'Indonesia',
    'Bengaluru', 'Hyderabad', 'Pune', 'Chennai', 'Berlin', 'Tel Aviv',
    'Buenos Aires', 'Bogota', 'Jakarta', 'Dublin', 'Paris', 'Warsaw',
  ],
});

// 1. The bug: a blocked foreign city followed by its ISO country code.
expectAll(usTargeted, [
  'Bengaluru, IN',
  'Bengaluru, KA, IN',
  'Pune, IN',
  'Chennai, TN, IN', // TN is Tamil Nadu here, not Tennessee
  'Berlin, DE',
  'Tel Aviv, IL',
  'Buenos Aires, AR',
  'Bogota, CO',
  'Jakarta, ID',
], false, 'blocked foreign city + ISO country code is rejected (Bengaluru, IN / Berlin, DE / Tel Aviv, IL)');

// Same through the Workday URL hint, which is its own single segment.
if (usTargeted('2 Locations', 'https://x.wd1.myworkdayjobs.com/c/job/Bengaluru-IN/Eng-Manager_R1') === false) {
  pass('Workday URL hint "Bengaluru-IN" is not rescued as Indiana');
} else {
  fail('Workday URL hint "Bengaluru-IN" must fall through to block, not pass as Indiana');
}

// 2. Unambiguous US codes keep the homonym rescue the feature exists for.
expectAll(usTargeted, [
  'Dublin, OH',
  'Paris, TX',
  'Berlin, CT',
], true, 'US homonyms with non-ISO state codes still pass (Dublin, OH / Paris, TX / Berlin, CT)');

// 3. Multi-location postings: a blocked office in another segment must not
// cancel the US option.
expectAll(usTargeted, [
  'Seattle, WA; Hyderabad, India',
  'Vancouver, BC; Pune, India',
  'Pittsburgh, PA · Bengaluru, IN',
  'Indianapolis, IN / Bengaluru, India',
  'Denver, CO | Bogota, CO',
  'Wilmington, DE • Berlin, DE',
  'Chicago, IL\nTel Aviv, IL',
], true, 'US segment of a multi-location posting survives a blocked foreign segment');

// Seattle is not in this always_allow, so this exercises the state code itself.
const bareUs = buildLocationFilter({
  always_allow: ['United States'],
  allow: ['Remote'],
  block: ['India', 'Hyderabad', 'Germany', 'Berlin', 'Israel'],
});
expectAll(bareUs, ['Seattle, WA; Hyderabad, India'], true,
  'WA rescues its own segment with no city-level always_allow entry');

// 4. An ambiguous code in an unblocked segment is still a state — even though
// the country it collides with (India, Germany, Israel) is blocked.
expectAll(bareUs, [
  'Indianapolis, IN',
  'Fishers, IN',
  'Wilmington, DE',
  'Chicago, IL',
  'Denver, CO',
  'Boise, ID',
  'Pittsburgh, PA',
  'Nashville, TN',
  'Raleigh, NC',
], true, 'ambiguous codes still rescue US cities that hit no block keyword');

// 5. ISO collisions deliberately kept unambiguous, because a well-known US city
// shares its name with a commonly blocked foreign one.
const homonymCities = buildLocationFilter({
  always_allow: ['United States'],
  allow: [],
  block: ['Cambridge', 'London', 'Birmingham', 'Athens', 'Rome', 'Vienna', 'Alexandria', 'Dublin'],
});
expectAll(homonymCities, [
  'Cambridge, MA',
  'London, KY',
  'Birmingham, AL',
  'Athens, GA',
  'Rome, GA',
  'Vienna, VA',
  'Alexandria, VA',
  'Dublin, CA',
], true, 'CA / KY / MA / AL / GA / VA stay unambiguous (Cambridge, MA / Vienna, VA / Dublin, CA pass)');

// 6. The accepted cost, and its escape hatch.
const warsaw = buildLocationFilter({
  always_allow: ['United States'],
  allow: [],
  block: ['Warsaw', 'Dublin'],
});
expectAll(warsaw, ['Warsaw, IN', 'Dublin, IN'], false,
  'accepted tradeoff: a US town named for a blocked city with an ISO-colliding code is rejected');
const warsawKept = buildLocationFilter({
  always_allow: ['United States', 'Warsaw, IN'],
  allow: [],
  block: ['Warsaw'],
});
if (warsawKept('Warsaw, IN') === true && warsawKept('Warsaw, Poland') === false) {
  pass('listing the exact "Warsaw, IN" in always_allow keeps it (Warsaw, Poland still rejected)');
} else {
  fail('an explicit always_allow "Warsaw, IN" must rescue it without rescuing Warsaw, Poland');
}

// 7. " - " is not a segment separator (ATSs use it inside one location), and
// the name matcher never had this problem: "Indiana" is still unambiguous.
expectAll(usTargeted, ['Bengaluru - IN'], false, '"Bengaluru - IN" is one segment and stays blocked');
expectAll(usTargeted, ['Warsaw, Indiana'], true, 'state names are unaffected ("Warsaw, Indiana" passes)');

// 8. Unchanged where the fix has nothing to protect: no block list, or no US
// token in always_allow at all.
const noBlock = buildLocationFilter({ always_allow: ['United States'], allow: ['Remote'] });
expectAll(noBlock, ['Berlin, DE', 'Chicago, IL'], true,
  'with no block list, ambiguous codes rescue exactly as before');
const noUsToken = buildLocationFilter({ always_allow: ['Canada'], allow: ['Remote'], block: [] });
expectAll(noUsToken, ['Chicago, IL', 'Indianapolis, IN'], false,
  'without a US always_allow token, no state code rescues anything');
