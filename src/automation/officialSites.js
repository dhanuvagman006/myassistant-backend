/**
 * OFFICIAL SITES FOR GOVERNMENT TASKS — where "file my ITR" starts.
 *
 * Owner's test, 2026-09-26: asked to file his income tax return, the
 * assistant said "I can't file your ITR directly, but I can help you open
 * the official income tax portal… Would you like me to do that?" He wanted
 * it DONE: the browser opened on the official site and the task carried as
 * far as it can go, handing over only where he must act himself (login,
 * OTP, his own figures, e-verification).
 *
 * The model was also told to find the official page with a web search
 * first, which cost a round trip and sometimes landed on a look-alike. For
 * the services people ask about most, the official address is known.
 */
const SITES = [
  {
    label: "the income tax e-filing site",
    url: "https://www.incometax.gov.in/iec/foportal/",
    test: /\b(?:itr|income[\s-]?tax|tax return|e-?filing|form 16|26as|ais\b|tax refund)/i,
  },
  {
    label: "the EPFO passbook",
    url: "https://passbook.epfindia.gov.in/MemberPassBook/login",
    test: /\b(?:epfo?|pf (?:balance|passbook|account|withdraw)|provident fund|uan)\b/i,
  },
  {
    label: "the GST portal",
    url: "https://www.gst.gov.in/",
    test: /\bgst(?:in| return| registration| portal)?\b/i,
  },
  {
    label: "Passport Seva",
    url: "https://www.passportindia.gov.in/",
    test: /\bpassport\b/i,
  },
  {
    label: "the Aadhaar site",
    url: "https://myaadhaar.uidai.gov.in/",
    test: /\b(?:aadhaa?r|uidai)\b/i,
  },
  {
    label: "DigiLocker",
    url: "https://www.digilocker.gov.in/",
    test: /\bdigi ?locker\b/i,
  },
  {
    label: "Parivahan",
    url: "https://parivahan.gov.in/",
    test: /\b(?:driving licen[cs]e|dl renewal|vehicle registration|rc (?:book|transfer)|parivahan|challan)\b/i,
  },
];

/** The official site a request is about, or null. */
function siteFor(text) {
  const t = String(text || "");
  if (!t.trim()) return null;
  const hit = SITES.find((s) => s.test.test(t));
  return hit ? { label: hit.label, url: hit.url } : null;
}

module.exports = { siteFor, SITES };
