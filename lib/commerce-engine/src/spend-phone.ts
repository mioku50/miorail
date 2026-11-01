// ---------------------------------------------------------------------------
// Still Spend: the number a phone top-up goes to.
//
// Bitrefill takes it as `refill_input`, "phone in international format (e.g.,
// "4915123456789")", and a top-up sent to a wrong number cannot be taken back.
// So a number is sent only when it starts with the calling code of the
// country the operator serves: a local number without its code, or a number of
// another country, is refused here before any invoice exists. This guards
// against a typo; it does not prove whose number it is.
// ---------------------------------------------------------------------------

/** Country calling codes by ISO 3166-1 alpha-2, as the ITU assigns them. */
const CALLING_CODES_V1: Readonly<Record<string, string>> = {
  AD: '376', AE: '971', AF: '93', AG: '1', AI: '1', AL: '355', AM: '374', AO: '244', AR: '54', AS: '1', AT: '43', AU: '61', AW: '297',
  AX: '358', AZ: '994', BA: '387', BB: '1', BD: '880', BE: '32', BF: '226', BG: '359', BH: '973', BI: '257', BJ: '229', BL: '590',
  BM: '1', BN: '673', BO: '591', BQ: '599', BR: '55', BS: '1', BT: '975', BW: '267', BY: '375', BZ: '501', CA: '1', CC: '61', CD: '243',
  CF: '236', CG: '242', CH: '41', CI: '225', CK: '682', CL: '56', CM: '237', CN: '86', CO: '57', CR: '506', CV: '238', CW: '599',
  CX: '61', CY: '357', CZ: '420', DE: '49', DJ: '253', DK: '45', DM: '1', DO: '1', DZ: '213', EC: '593', EE: '372', EG: '20', EH: '212',
  ER: '291', ES: '34', ET: '251', FI: '358', FJ: '679', FK: '500', FM: '691', FO: '298', FR: '33', GA: '241', GB: '44', GD: '1', GE: '995',
  GF: '594', GG: '44', GH: '233', GI: '350', GL: '299', GM: '220', GN: '224', GP: '590', GQ: '240', GR: '30', GT: '502', GU: '1', GW: '245',
  GY: '592', HK: '852', HN: '504', HR: '385', HT: '509', HU: '36', ID: '62', IE: '353', IL: '972', IM: '44', IN: '91', IQ: '964', IS: '354',
  IT: '39', JE: '44', JM: '1', JO: '962', JP: '81', KE: '254', KG: '996', KH: '855', KI: '686', KM: '269', KN: '1', KR: '82', KW: '965',
  KY: '1', KZ: '7', LA: '856', LB: '961', LC: '1', LI: '423', LK: '94', LR: '231', LS: '266', LT: '370', LU: '352', LV: '371', LY: '218',
  MA: '212', MC: '377', MD: '373', ME: '382', MF: '590', MG: '261', MH: '692', MK: '389', ML: '223', MM: '95', MN: '976', MO: '853',
  MP: '1', MQ: '596', MR: '222', MS: '1', MT: '356', MU: '230', MV: '960', MW: '265', MX: '52', MY: '60', MZ: '258', NA: '264', NC: '687',
  NE: '227', NF: '672', NG: '234', NI: '505', NL: '31', NO: '47', NP: '977', NR: '674', NU: '683', NZ: '64', OM: '968', PA: '507', PE: '51',
  PF: '689', PG: '675', PH: '63', PK: '92', PL: '48', PM: '508', PN: '64', PR: '1', PS: '970', PT: '351', PW: '680', PY: '595', QA: '974',
  RE: '262', RO: '40', RS: '381', RU: '7', RW: '250', SA: '966', SB: '677', SC: '248', SD: '249', SE: '46', SG: '65', SH: '290', SI: '386',
  SJ: '47', SK: '421', SL: '232', SM: '378', SN: '221', SO: '252', SR: '597', SS: '211', ST: '239', SV: '503', SX: '1', SZ: '268', TC: '1',
  TD: '235', TG: '228', TH: '66', TJ: '992', TK: '690', TL: '670', TM: '993', TN: '216', TO: '676', TR: '90', TT: '1', TV: '688', TW: '886',
  TZ: '255', UA: '380', UG: '256', US: '1', UY: '598', UZ: '998', VA: '39', VC: '1', VE: '58', VG: '1', VI: '1', VN: '84', VU: '678',
  WF: '681', WS: '685', YE: '967', YT: '262', ZA: '27', ZM: '260', ZW: '263',
};

/** Where countries share a calling code, the prefixes that are this country's
 * own: Kazakhstan's +7 6 and +7 7 beside Russia's, and the area codes of the
 * North American plan beside the United States and Canada. */
const OWN_PREFIXES_V1: Readonly<Record<string, readonly string[]>> = {
  KZ: ['76', '77'], RU: ['73', '74', '78', '79'],
  AG: ['1268'], AI: ['1264'], AS: ['1684'], BB: ['1246'], BM: ['1441'], BS: ['1242'], DM: ['1767'], DO: ['1809', '1829', '1849'],
  GD: ['1473'], GU: ['1671'], JM: ['1876', '1658'], KN: ['1869'], KY: ['1345'], LC: ['1758'], MP: ['1670'], MS: ['1664'],
  PR: ['1787', '1939'], SX: ['1721'], TC: ['1649'], TT: ['1868'], VC: ['1784'], VG: ['1284'], VI: ['1340'],
};

/** The calling code a person writes first for this country, as "91", or null. */
export function spendCallingCodeV1(country: string | null | undefined): string | null {
  return typeof country === 'string' ? CALLING_CODES_V1[country.toUpperCase()] ?? null : null;
}

/** The number to top up, in Bitrefill's international format (digits, no
 * "+"), or null when it is not a number of this country. Spaces, dashes, dots
 * and brackets are dropped; a leading "+" or "00" is the international prefix. */
export function spendPhoneV1(raw: string, country: string | null | undefined): string | null {
  const code = spendCallingCodeV1(country);
  if (code === null || typeof raw !== 'string' || raw.length > 32) return null;
  let digits = raw.trim().replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^\d{7,15}$/.test(digits)) return null;
  const prefixes = OWN_PREFIXES_V1[country!.toUpperCase()] ?? [code];
  // At least four digits after the code: a code alone, or nearly, is no number.
  return prefixes.some((prefix) => digits.startsWith(prefix)) && digits.length - code.length >= 4 ? digits : null;
}
