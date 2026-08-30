/**
 * PACK: GOVERNMENT SERVICES AND DOCUMENTS.
 *
 * Aadhaar, PAN, passport, driving licence, voter ID, ration card, and the
 * certificates everything else depends on. This is the pack with the most
 * everyday value in India and the one where wrong information wastes a
 * physical trip to an office.
 *
 * WHAT IS DELIBERATELY NOT HERE: exact fees and processing times drift, and
 * state portals differ. Where a number is stated it is the central, current
 * one at the time of writing with the official portal linked so it can be
 * checked. Where a thing is genuinely state-dependent — ration cards,
 * income and caste certificates — the entry says so rather than inventing a
 * national procedure that does not exist.
 */

const DOMAIN = "govt";

const e = (slug, source_short, source_title, ref, title, summary, detail, topics, source_url) => ({
  slug: `GOVT:${slug}`,
  domain: DOMAIN,
  source_title,
  source_short,
  ref,
  title,
  summary,
  detail,
  topics: `govt document ${topics}`.trim(),
  replaces: "",
  source_url,
  status: "in_force",
  effective: "",
});

const UIDAI = "https://uidai.gov.in";
const NSDL = "https://www.onlineservices.nsdl.com";
const PASSPORT = "https://www.passportindia.gov.in";
const PARIVAHAN = "https://parivahan.gov.in";
const NVSP = "https://voters.eci.gov.in";

const ENTRIES = [
  /* ---------------- AADHAAR ---------------- */

  e("aadhaar.enrol", "UIDAI", "Unique Identification Authority of India", "Enrolment",
    "Aadhaar enrolment is free and done at an Aadhaar Seva Kendra or an authorised enrolment centre. You need one proof of identity, one proof of address, and proof of date of birth; biometrics (ten fingerprints, both irises, photograph) are captured there.",
    "First enrolment is FREE. You get an acknowledgement slip with a 14-digit enrolment ID (EID) — keep it, it is how you track the application. Generation usually takes up to 30 days. A child under 5 gets a Bal Aadhaar with no biometrics, which MUST be updated with biometrics at ages 5 and 15 or it becomes inactive.",
    "aadhaar identity enrolment", UIDAI),

  e("aadhaar.update", "UIDAI", "Unique Identification Authority of India", "Update",
    "Name, address, date of birth, gender, mobile and email can be updated. Address can be updated online through myAadhaar with a valid proof; name, date of birth, gender and biometrics require a visit to an Aadhaar Seva Kendra.",
    "Charges are ₹50 for a demographic update and ₹100 for a biometric update at a centre (online address update is periodically free — check myAadhaar). LIMITS: name can be changed twice in a lifetime, gender once, and date of birth once. Mobile number CANNOT be updated online — it needs a centre visit, which is the single most common wasted trip.",
    "aadhaar identity update address", `${UIDAI}/en/my-aadhaar`),

  e("aadhaar.lock", "UIDAI", "Unique Identification Authority of India", "Security",
    "Lock your biometrics on myAadhaar so they cannot be used for authentication even if someone has your number, and use a Virtual ID (VID) or Masked Aadhaar instead of the full number when sharing.",
    "Check 'Authentication History' on myAadhaar to see every place your Aadhaar was used — this is how you spot misuse. Private entities cannot demand Aadhaar as the only proof of identity except where a law expressly requires it (Puttaswamy, 2018).",
    "aadhaar identity security privacy fraud", `${UIDAI}/en/my-aadhaar`),

  /* ---------------- PAN ---------------- */

  e("pan.apply", "Income Tax Department", "Permanent Account Number", "Form 49A",
    "Apply for a PAN online through NSDL (Protean) or UTIITSL using Form 49A for Indian citizens. With Aadhaar-based e-KYC the whole application is paperless and the e-PAN is usually issued within a few working days.",
    "Fee is around ₹107 for an Indian address and about ₹1,017 for despatch abroad. INSTANT e-PAN is free on the Income Tax portal if your mobile is linked to your Aadhaar — it takes about ten minutes and is a valid PAN, not a provisional one. Holding more than one PAN is an offence under Section 272B of the Income-tax Act with a ₹10,000 penalty; surrender any duplicate.",
    "pan tax identity apply", NSDL),

  e("pan.aadhaar.link", "CBDT", "Central Board of Direct Taxes", "Section 139AA",
    "PAN must be linked to Aadhaar. An unlinked PAN becomes INOPERATIVE — you cannot file a return, get a refund, or complete most banking and investment transactions, and TDS is deducted at the higher rate.",
    "Linking after the free window carries a ₹1,000 fee under Section 234H. An inoperative PAN becomes operative again about 30 days after linking. Exempt: residents of Assam, Jammu & Kashmir and Meghalaya, non-residents, those aged over 80, and non-citizens.",
    "pan aadhaar tax link", "https://www.incometax.gov.in"),

  /* ---------------- PASSPORT ---------------- */

  e("passport.apply", "MEA", "Ministry of External Affairs — Passport Seva", "Fresh passport",
    "Register on the Passport Seva portal, fill the form, pay online and book an appointment at a Passport Seva Kendra or Post Office PSK. Carry the ORIGINAL documents plus a self-attested set: proof of address, date of birth, and an Annexure where required.",
    "Fees: ₹1,500 for a 36-page 10-year passport (normal), ₹2,000 for 60 pages; TATKAAL is ₹3,500 extra. Minors under 15: ₹1,000. Normal issue typically 30–45 days including police verification; Tatkaal is usually issued in 1–3 working days with post-issue verification. Police verification is the usual cause of delay — a mismatch between your current and document address is the most common reason.",
    "passport travel identity apply", PASSPORT),

  e("passport.renew", "MEA", "Ministry of External Affairs — Passport Seva", "Re-issue",
    "Apply for re-issue up to one year BEFORE expiry, and you can still apply after it expires. Choose 're-issue' and not 'fresh' — a fresh application restarts full police verification unnecessarily.",
    "Re-issue with no change in particulars and a clear previous passport often gets no repeat police verification. Carry the old passport; it is returned cancelled. Damaged or lost passports need a police report and an Annexure, and take longer.",
    "passport travel renew", PASSPORT),

  /* ---------------- DRIVING LICENCE ---------------- */

  e("dl.learner", "MoRTH", "Ministry of Road Transport and Highways — Parivahan", "Learner's Licence",
    "Apply on the Parivahan Sarathi portal. You must be 18 for a geared vehicle (16 for a gearless two-wheeler under 50cc with parental consent). You need Form 1 (medical self-declaration), address and age proof, and you must pass an online test on road signs and rules.",
    "The learner's licence is valid for 6 MONTHS. You may apply for the permanent licence after 30 days and must do so within those 6 months, or you retake the learner's test. Driving without a valid licence is ₹5,000 under Section 181 of the Motor Vehicles Act.",
    "driving licence transport apply", `${PARIVAHAN}/parivahan`),

  e("dl.permanent", "MoRTH", "Ministry of Road Transport and Highways — Parivahan", "Driving Licence",
    "Book a driving test slot at the RTO with your learner's licence. Bring the vehicle of the class you are testing for. On passing, the licence is issued and posted.",
    "Valid for 20 years or until age 50, whichever is earlier; after 50, renewals are for 5 years. RENEW WITHIN 30 DAYS of expiry to avoid a penalty; after 5 years lapsed you must start again from the learner's stage. A licence obtained through a certified driving training centre can exempt you from the RTO test.",
    "driving licence transport renew", `${PARIVAHAN}/parivahan`),

  /* ---------------- VOTER ID ---------------- */

  e("voter.register", "ECI", "Election Commission of India", "Form 6",
    "Any citizen who is 18 or older on the qualifying date can register using Form 6 on the Voters' Service Portal or the Voter Helpline app. You need proof of age, address and a photograph.",
    "Form 8 corrects details, changes address or requests a replacement EPIC. Form 7 objects to an entry or requests deletion. Registration is free. You can vote with any of the approved alternative photo IDs if your EPIC has not arrived, as long as your name is on the roll — check the roll before election day, which is where most people are caught out.",
    "voter election identity register", NVSP),

  /* ---------------- CERTIFICATES ---------------- */

  e("cert.birth", "Registrar", "Registration of Births and Deaths Act, 1969", "Birth certificate",
    "Births must be registered within 21 DAYS with the local registrar — the municipal corporation, panchayat or the hospital where the birth took place. Registration within that window is free.",
    "Late registration is allowed but escalates: after 21 days with a fee, after 30 days with the Registrar's written permission, after a year only on an order of a Magistrate. Since the 2023 amendment, the birth certificate is the single document for admission, licence, passport and marriage registration, so getting it right early matters more than it used to. Application is at the state's e-district portal, which differs by state.",
    "certificate birth registration", "https://crsorgi.gov.in"),

  e("cert.death", "Registrar", "Registration of Births and Deaths Act, 1969", "Death certificate",
    "Deaths must be registered within 21 days with the local registrar. The certificate is required for insurance claims, pension transfer, property mutation and closing bank accounts.",
    "Apply through the municipal body or the state e-district portal. Get several certified copies at once — every institution will want its own, and returning later for more is slower than asking upfront.",
    "certificate death registration", "https://crsorgi.gov.in"),

  e("cert.income.caste", "State Government", "State revenue departments", "Income / caste / domicile",
    "Income, caste, domicile and residence certificates are issued by the STATE, usually by the Tahsildar or a revenue officer through the state e-district portal. There is no single national procedure — the forms, documents and validity differ by state.",
    "Typically needed: ration card or address proof, Aadhaar, and a self-declaration; caste certificates additionally need a parent's or relative's caste certificate. Income certificates are usually valid for one financial year. Because this is state-specific, verify on your own state's e-district portal before making a trip.",
    "certificate income caste domicile state", "https://services.india.gov.in"),

  /* ---------------- GRIEVANCE ---------------- */

  e("grievance.cpgrams", "DARPG", "Centralised Public Grievance Redress and Monitoring System", "CPGRAMS",
    "Any grievance against a central government department, ministry or public sector body can be filed online at pgportal.gov.in. You get a registration number to track it, and it is routed to the responsible officer.",
    "Use this when an application is stuck beyond its stated timeline — it is far more effective than repeat visits. If the reply is unsatisfactory there is an appeal option within the portal. For state departments, use the state's own grievance portal. An RTI application asking for the file's current status often moves a stalled matter faster than a grievance does.",
    "grievance complaint government delay", "https://pgportal.gov.in"),

  e("govt.digilocker", "MeitY", "DigiLocker", "Digital documents",
    "DigiLocker holds government-issued documents — Aadhaar, PAN, driving licence, vehicle RC, education certificates, insurance — in a form that is legally equivalent to the original under Rule 9A of the IT Rules.",
    "Documents pulled from the issuer into DigiLocker must be accepted by government offices, police and transport authorities in place of physical originals. For a traffic stop, the DigiLocker or mParivahan copy of your licence and RC IS valid — a photograph of the document on your phone is not.",
    "digilocker documents identity digital", "https://www.digilocker.gov.in"),
];

module.exports = { DOMAIN, ENTRIES };
